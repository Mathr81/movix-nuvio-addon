const config = require('../../core/config');
const simkl = require('../../integrations/simklCloud');
const { parseKey, describe } = require('../model');

/**
 * Position de lecture vers Simkl, via un scrobble (Simkl calque Trakt: il n'y a pas
 * d'import de progression, seulement une pause simulee). Simkl ne conserve ces points
 * qu'une semaine, ce qui est sans consequence tant que le hub les repousse a chaque
 * cycle -- c'est meme la raison pour laquelle on les renvoie systematiquement, sans
 * filtrer sur le delta.
 */
async function scrobbleToSimkl(progressEntries) {
  let ok = 0;
  let failed = 0;
  for (const item of progressEntries) {
    const percent = (item.position / item.duration) * 100;
    // Simkl ne cree une session de reprise que SOUS 80 %: au-dela il considere le titre
    // termine et le scrobble est accepte sans rien afficher. Envoyer 80-95 % donnait donc
    // des "echecs: 0" pour des entrees invisibles cote Simkl.
    if (!Number.isFinite(percent) || percent <= 0 || percent >= config.SIMKL_RESUME_MAX_PERCENT) continue;

    const payload =
      item.type === 'series'
        ? { show: { ids: { tmdb: String(item.id) } }, episode: { season: item.season, number: item.episode }, progress: Number(percent.toFixed(2)) }
        : { movie: { ids: { tmdb: String(item.id) } }, progress: Number(percent.toFixed(2)) };

    try {
      await simkl.scrobble('pause', payload);
      ok += 1;
    } catch (err) {
      failed += 1;
      if (failed === 1) console.warn(`[hub] scrobble Simkl refuse: ${err.message}`);
    }
  }
  return { enregistrees: ok, echecs: failed };
}

async function applyToSimkl(delta) {
  if (!simkl.isAuthenticated()) return null;
  const result = {};

  const movies = [];
  const shows = new Map();
  for (const item of delta.watched) {
    if (item.type === 'series' && item.season) {
      if (!shows.has(item.id)) shows.set(item.id, new Map());
      const seasons = shows.get(item.id);
      if (!seasons.has(item.season)) seasons.set(item.season, []);
      seasons.get(item.season).push({ number: item.episode });
    } else if (item.type === 'movie') {
      movies.push(item);
    }
  }

  if (movies.length > 0 || shows.size > 0) {
    const payload = {
      movies: await Promise.all(
        movies.map(async (item) => ({ ...(await describe('movie', item.id)), ids: { tmdb: item.id } })),
      ),
      shows: await Promise.all(
        [...shows].map(async ([id, seasons]) => ({
          ...(await describe('series', id)),
          ids: { tmdb: id },
          seasons: [...seasons].map(([number, episodes]) => ({ number, episodes })),
        })),
      ),
    };
    await simkl.addToHistory(payload);
    result.history = movies.length + [...shows.values()].reduce((n, s) => n + [...s.values()].flat().length, 0);
  }

  if (delta.library.length > 0) {
    const payload = { movies: [], shows: [] };
    for (const item of delta.library) {
      const entry = { ...(await describe(item.type, item.id)), ids: { tmdb: item.id }, to: 'plantowatch' };
      (item.type === 'series' ? payload.shows : payload.movies).push(entry);
    }
    await simkl.addToList(payload);
    result.list = delta.library.length;
  }

  return Object.keys(result).length > 0 ? result : null;
}

/** Suppressions cote Simkl: listes et historique ont chacun leur endpoint. */
async function applyRemovalsToSimkl(removals) {
  if (!simkl.isAuthenticated()) return null;
  const result = {};

  const byType = (keys) => {
    const movies = [];
    const shows = [];
    for (const key of keys) {
      const { type, id } = parseKey(key);
      (type === 'series' ? shows : movies).push({ ids: { tmdb: String(id) } });
    }
    return { movies, shows };
  };

  if (removals.library.length > 0) {
    const payload = byType(removals.library);
    await simkl.post('/sync/remove-from-list', payload);
    result.liste = removals.library.length;
  }

  if (removals.watched.length > 0) {
    // Les episodes se retirent par serie + saison + numero, comme a l'ajout.
    const movies = [];
    const shows = new Map();
    for (const key of removals.watched) {
      const { type, id, season, episode } = parseKey(key);
      if (type === 'series' && season) {
        if (!shows.has(id)) shows.set(id, new Map());
        const seasons = shows.get(id);
        if (!seasons.has(season)) seasons.set(season, []);
        seasons.get(season).push({ number: episode });
      } else {
        movies.push({ ids: { tmdb: String(id) } });
      }
    }
    await simkl.post('/sync/history/remove', {
      movies,
      shows: [...shows].map(([id, seasons]) => ({
        ids: { tmdb: String(id) },
        seasons: [...seasons].map(([number, episodes]) => ({ number, episodes })),
      })),
    });
    result.historique = removals.watched.length;
  }

  return Object.keys(result).length > 0 ? result : null;
}

module.exports = { applyToSimkl, applyRemovalsToSimkl, scrobbleToSimkl };
