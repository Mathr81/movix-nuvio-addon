const { parseKey, describe } = require('./model');

/**
 * Vue comparee des trois sources, pour la page Synchro: qui possede quoi, et ou ca
 * diverge. Lecture seule, sur les modeles du dernier cycle -- relire les trois comptes a
 * chaque affichage couterait un cycle entier.
 */

const SOURCES = ['movix', 'nuvio', 'simkl'];

const episodeLabel = (season, episode) =>
  `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;

/** Titres TMDB des cles donnees, 8 a la fois (le cache en sert l'essentiel). */
async function titlesFor(keys) {
  const ids = [...new Set(keys.map((key) => { const { type, id } = parseKey(key); return `${type}:${id}`; }))];
  const titles = new Map();
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const typed = ids[next++];
      const { type, id } = parseKey(typed);
      titles.set(typed, await describe(type, id));
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return titles;
}

/** `series:1399:2:5` -> "Game of Thrones · S02E05", avec le cache de `titlesFor`. */
function labelOf(key, titles) {
  const { type, id, season, episode } = parseKey(key);
  const title = titles.get(`${type}:${id}`)?.title || `TMDB ${id}`;
  return season && episode ? `${title} · ${episodeLabel(season, episode)}` : title;
}

async function compare(models) {
  if (!models) return null;
  const view = models.simkl;
  const sides = { movix: models.movix, nuvio: models.nuvio, simkl: view?.confirmed || null };
  const has = (side, kind, key) => (sides[side] ? sides[side][kind].has(key) : null);

  const keysOf = (kind) => new Set(SOURCES.flatMap((side) => (sides[side] ? [...sides[side][kind].keys()] : [])));

  const library = [...keysOf('library')].map((key) => {
    const row = { key, movix: has('movix', 'library', key), nuvio: has('nuvio', 'library', key), simkl: has('simkl', 'library', key) };
    // Une liste Simkl est exclusive: un titre termine n'est plus "a voir", sans etre perdu.
    if (row.simkl === false && view.known.library.has(key)) row.simkl = 'ailleurs';
    row.diff = SOURCES.some((side) => row[side] === false);
    return row;
  });

  // Vus: une ligne par titre, avec le nombre d'episodes de chaque cote et ce qui manque.
  const shows = new Map();
  for (const key of keysOf('watched')) {
    const { type, id, season, episode } = parseKey(key);
    const showKey = `${type}:${id}`;
    if (!shows.has(showKey)) shows.set(showKey, { key: showKey, episodes: new Set() });
    shows.get(showKey).episodes.add(season && episode ? key : null);
  }
  const watched = [...shows.values()].map(({ key, episodes }) => {
    const row = { key };
    for (const side of SOURCES) {
      if (!sides[side]) {
        row[side] = null;
        continue;
      }
      const present = [...episodes].filter((ep) => sides[side].watched.has(ep || key));
      row[side] = present.length;
      const missing = [...episodes].filter((ep) => ep && !sides[side].watched.has(ep));
      if (missing.length) {
        row.missing = row.missing || {};
        row.missing[side] = missing.map((ep) => { const p = parseKey(ep); return episodeLabel(p.season, p.episode); });
      }
    }
    row.total = episodes.size;
    row.diff = SOURCES.some((side) => row[side] !== null && row[side] !== row.total);
    return row;
  });

  // Reprises: Simkl ne les rend pas en lecture (elles n'y partent qu'en scrobble).
  const percent = (side, key) => {
    const p = sides[side].progress.get(key);
    return p ? Math.round((p.position / (p.duration || 1)) * 100) : false;
  };
  const progress = [...new Set([...models.movix.progress.keys(), ...models.nuvio.progress.keys()])].map((key) => {
    const row = { key, movix: percent('movix', key), nuvio: percent('nuvio', key) };
    // Nuvio efface de lui-meme une reprise terminee, a peine entamee ou d'un titre deja
    // vu: son absence en face n'est alors pas un ecart.
    const seen = models.movix.watched.has(key) || models.nuvio.watched.has(key);
    const meaningful = (v) => v !== false && v > 2 && v < 90 && !seen;
    row.diff =
      row.movix === false || row.nuvio === false
        ? meaningful(row.movix) || meaningful(row.nuvio)
        : Math.abs(row.movix - row.nuvio) > 1;
    return row;
  });

  const titles = await titlesFor([...library, ...watched, ...progress].map((r) => r.key));
  for (const row of [...library, ...watched, ...progress]) {
    row.label = labelOf(row.key, titles);
    row.poster = titles.get(row.key.split(':').slice(0, 2).join(':'))?.poster_path || '';
  }
  const byLabel = (a, b) => a.label.localeCompare(b.label, 'fr');

  return {
    at: models.at,
    simkl: !!view,
    library: library.sort(byLabel),
    watched: watched.sort(byLabel),
    progress: progress.sort(byLabel),
  };
}

module.exports = { compare, titlesFor, labelOf };
