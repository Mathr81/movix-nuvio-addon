const config = require('../../core/config');
const cache = require('../../core/cache');
const tmdbClient = require('../../integrations/tmdb');
const simkl = require('../../integrations/simklCloud');
const simklLibrary = require('../../integrations/simklLibrary');
const { parseKey, watchedKey, libKey, progressKey } = require('../model');

/**
 * Ecritures vers Simkl, selon les regles de sa documentation:
 *
 *   - tout part en LOTS (50 titres par requete): Simkl n'accepte qu'un POST par seconde et
 *     verrouille l'utilisateur le temps de chaque ecriture;
 *   - chaque titre porte titre, annee et tous ses ids (TMDB + IMDb): Simkl les essaie dans
 *     l'ordre puis se rabat sur titre + annee. Un id TMDB seul est ambigu (films et series
 *     ont chacun leur sequence);
 *   - `not_found` est lu: un titre que Simkl ne sait pas identifier est note une fois pour
 *     toutes au lieu d'etre renvoye a chaque cycle;
 *   - jamais `/sync/add-to-list` apres `/sync/history` pour le meme titre: l'historique
 *     place deja le titre dans la bonne liste, et un `plantowatch` derriere retrograderait
 *     une serie terminee.
 */
const BATCH_SIZE = 50;
// Positions de reprise: Simkl ne les garde que 7 jours sur un compte gratuit. On ne
// renvoie une position inchangee que lorsqu'elle approche de cette limite.
const PLAYBACK_REFRESH_MS = 5 * 24 * 60 * 60 * 1000;
// En dessous de cet ecart (en points de pourcentage), deux positions sont la meme.
const PROGRESS_EPSILON = 2;

/** Titre, annee et ids d'un titre TMDB, tels que Simkl les attend. */
async function media(type, tmdbId) {
  const out = { ids: { tmdb: tmdbId } };
  try {
    const details = await cache.wrap(`meta:${type}:${tmdbId}`, config.CACHE_TTL_MS, config.CACHE_EMPTY_TTL_MS, () =>
      tmdbClient.details(type, tmdbId),
    );
    const date = details.release_date || details.first_air_date || '';
    if (details.title || details.name) out.title = details.title || details.name;
    if (Number(date.slice(0, 4))) out.year = Number(date.slice(0, 4));
  } catch {
    // Titre inconnu: les ids suffisent le plus souvent.
  }

  const imdbKey = `imdb:${type}:${tmdbId}`;
  let imdb = cache.get(imdbKey);
  if (imdb === undefined) {
    try {
      imdb = await tmdbClient.getImdbId(type, tmdbId);
    } catch {
      imdb = null;
    }
    cache.set(imdbKey, imdb, 24 * 60 * 60 * 1000);
  }
  if (imdb) out.ids.imdb = imdb;
  return out;
}

function chunk(items, size = BATCH_SIZE) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Ids TMDB (films, series) que Simkl dit ne pas avoir trouves. */
function notFoundTmdb(response) {
  const ids = (list) => new Set((list || []).map((e) => Number(e?.ids?.tmdb)).filter(Number.isFinite));
  return { movie: ids(response?.not_found?.movies), series: ids(response?.not_found?.shows) };
}

/**
 * Envoie des entrees `{type, id, keys, body}` par lots vers `endpoint`, et repartit leurs
 * cles entre acceptees et introuvables.
 */
async function sendBatches(endpoint, entries) {
  const accepted = [];
  const unmatched = [];
  for (const batch of chunk(entries)) {
    const payload = {
      movies: batch.filter((e) => e.type === 'movie').map((e) => e.body),
      shows: batch.filter((e) => e.type === 'series').map((e) => e.body),
    };
    const response = await endpoint(payload);
    const missing = notFoundTmdb(response);
    for (const entry of batch) (missing[entry.type].has(entry.id) ? unmatched : accepted).push(...entry.keys);
  }
  return { accepted, unmatched };
}

/** Regroupe des elements vus par titre, et les episodes par saison. */
function groupWatched(items) {
  const movies = new Map();
  const shows = new Map();
  for (const item of items) {
    if (item.type === 'movie') {
      movies.set(item.id, item);
    } else if (item.type === 'series' && item.season && item.episode) {
      // Un "serie vue" sans episode n'a pas d'equivalent sur: on ne l'envoie pas.
      if (!shows.has(item.id)) shows.set(item.id, new Map());
      const seasons = shows.get(item.id);
      if (!seasons.has(item.season)) seasons.set(item.season, new Set());
      seasons.get(item.season).add(item.episode);
    }
  }
  return { movies, shows };
}

const isoDate = (value) => {
  const ms = typeof value === 'number' ? (value > 1e11 ? value : value * 1000) : Date.parse(value || '');
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : undefined;
};

async function applyToSimkl(delta) {
  if (!simkl.available()) return null;
  const result = {};

  // --- Historique ---
  const { movies, shows } = groupWatched(delta.watched);
  const historyEntries = [];
  for (const [id, item] of movies) {
    const watchedAt = isoDate(item.watchedAt);
    historyEntries.push({
      type: 'movie',
      id,
      keys: [watchedKey('movie', id)],
      body: { ...(await media('movie', id)), ...(watchedAt ? { watched_at: watchedAt } : {}) },
    });
  }
  for (const [id, seasons] of shows) {
    const keys = [];
    const seasonList = [...seasons].map(([number, eps]) => {
      for (const ep of eps) keys.push(watchedKey('series', id, number, ep));
      return { number, episodes: [...eps].map((n) => ({ number: n })) };
    });
    historyEntries.push({ type: 'series', id, keys, body: { ...(await media('series', id)), seasons: seasonList } });
  }

  if (historyEntries.length > 0) {
    const { accepted, unmatched } = await sendBatches(simkl.addToHistory, historyEntries);
    simklLibrary.markPending('watched', accepted);
    if (unmatched.length) simklLibrary.markUnmatched('watched', unmatched);
    result.historique = { envoyes: accepted.length, introuvables: unmatched.length };
  }

  // --- Listes ---
  // Un titre qui vient de recevoir de l'historique est deja dans la bonne liste.
  const inHistory = new Set(historyEntries.map((e) => libKey(e.type, e.id)));
  const listEntries = [];
  const skipped = [];
  for (const item of delta.library) {
    const key = libKey(item.type, item.id);
    if (inHistory.has(key)) {
      skipped.push(key);
      continue;
    }
    listEntries.push({ type: item.type, id: item.id, keys: [key], body: { ...(await media(item.type, item.id)), to: 'plantowatch' } });
  }
  if (skipped.length) simklLibrary.markPending('library', skipped);

  if (listEntries.length > 0) {
    const { accepted, unmatched } = await sendBatches(simkl.addToList, listEntries);
    simklLibrary.markPending('library', accepted);
    if (unmatched.length) simklLibrary.markUnmatched('library', unmatched);
    result.liste = { envoyes: accepted.length, introuvables: unmatched.length };
  }

  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Suppressions. Simkl n'a pas d'endpoint "retirer de la liste": c'est
 * `/sync/history/remove` sans saisons, qui efface le titre ENTIER, historique compris.
 * On ne s'en sert donc que pour un titre encore en `plantowatch` -- retirer de sa
 * watchlist une serie deja commencee ne doit pas effacer ce qui a ete vu.
 */
async function applyRemovalsToSimkl(removals) {
  if (!simkl.available()) return null;
  const result = {};

  const libraryEntries = [];
  let kept = 0;
  for (const key of removals.library) {
    const { type, id } = parseKey(key);
    const item = simklLibrary.findItem(type, id);
    if (item?.status !== 'plantowatch') {
      kept += 1;
      continue;
    }
    libraryEntries.push({ type, id, keys: [key], body: { ids: { simkl: item.simkl, tmdb: id } } });
  }

  const watchedItems = removals.watched.map((key) => parseKey(key));
  const { movies, shows } = groupWatched(watchedItems);
  const watchedEntries = [
    ...[...movies.keys()].map((id) => ({ type: 'movie', id, keys: [watchedKey('movie', id)], body: { ids: { tmdb: id } } })),
    ...[...shows].map(([id, seasons]) => {
      const keys = [];
      const seasonList = [...seasons].map(([number, eps]) => {
        for (const ep of eps) keys.push(watchedKey('series', id, number, ep));
        return { number, episodes: [...eps].map((n) => ({ number: n })) };
      });
      return { type: 'series', id, keys, body: { ids: { tmdb: id }, seasons: seasonList } };
    }),
  ];
  // Ids Simkl quand on les connait: plus surs qu'un id TMDB, ambigu entre film et serie.
  for (const entry of watchedEntries) {
    const item = simklLibrary.findItem(entry.type, entry.id);
    if (item) entry.body.ids.simkl = item.simkl;
  }

  const entries = [...libraryEntries, ...watchedEntries];
  if (entries.length > 0) {
    const { accepted } = await sendBatches(simkl.removeFromHistory, entries);
    const acceptedSet = new Set(accepted);
    simklLibrary.applyRemoved({
      library: libraryEntries.flatMap((e) => e.keys).filter((k) => acceptedSet.has(k)),
      watched: watchedEntries.flatMap((e) => e.keys).filter((k) => acceptedSet.has(k)),
    });
    result.retires = accepted.length;
  }
  if (kept) result.conserves = `${kept} titre(s) deja commence(s) laisse(s) dans Simkl`;

  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Positions de reprise vers Simkl (`/scrobble/pause`).
 *
 * N'envoie que ce qui DIFFERE de ce que Simkl a deja (lu via `/sync/playback`, ou retenu
 * du dernier envoi), et au plus SIMKL_SCROBBLE_MAX_PER_CYCLE par cycle. L'ancienne
 * version renvoyait toutes les positions a chaque cycle de 20 s -- des dizaines de POST
 * par minute sur une API limitee a un par seconde.
 */
async function scrobbleToSimkl(progressEntries) {
  if (!simkl.available()) return null;

  const due = [];
  for (const item of progressEntries) {
    const percent = Number(((item.position / item.duration) * 100).toFixed(2));
    // Simkl ne cree une session de reprise que SOUS 80 %: au-dela il considere le titre
    // termine et le scrobble est accepte sans rien afficher.
    if (!Number.isFinite(percent) || percent < 1 || percent >= config.SIMKL_RESUME_MAX_PERCENT) continue;
    if (item.type === 'series' && !(item.season && item.episode)) continue;

    const key = progressKey(item.type, item.id, item.season, item.episode);
    const known = simklLibrary.playbackOf(key);
    const sent = simklLibrary.lastScrobble(key);
    const reference = sent && (!known || sent.at > Date.parse(known.pausedAt || 0)) ? sent.progress : known?.progress;
    const lastAt = Math.max(sent?.at || 0, Date.parse(known?.pausedAt || 0) || 0);
    const same = reference !== undefined && Math.abs(reference - percent) < PROGRESS_EPSILON;
    if (same && Date.now() - lastAt < PLAYBACK_REFRESH_MS) continue;
    due.push({ item, key, percent });
  }

  let ok = 0;
  let failed = 0;
  for (const { item, key, percent } of due.slice(0, config.SIMKL_SCROBBLE_MAX_PER_CYCLE)) {
    const payload =
      item.type === 'series'
        ? { show: await media('series', item.id), episode: { season: item.season, number: item.episode }, progress: percent }
        : { movie: await media('movie', item.id), progress: percent };
    try {
      await simkl.scrobble('pause', payload);
      simklLibrary.noteScrobble(key, percent);
      ok += 1;
    } catch (err) {
      failed += 1;
      if (failed === 1) console.warn(`[hub] scrobble Simkl refuse: ${err.message}`);
      if (err.paused) break;
    }
  }

  if (ok + failed === 0) return null;
  return { enregistrees: ok, echecs: failed, enAttente: Math.max(due.length - ok - failed, 0) };
}

module.exports = { applyToSimkl, applyRemovalsToSimkl, scrobbleToSimkl, media };
