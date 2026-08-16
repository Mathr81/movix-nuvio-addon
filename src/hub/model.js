const config = require('../core/config');
const cache = require('../core/cache');
const tmdbClient = require('../integrations/tmdb');

/**
 * Modele canonique partage par les trois sources du hub.
 *
 * Positions en SECONDES (unite Movix); la conversion en millisecondes est faite au
 * moment d'ecrire vers Nuvio, qui est le seul a travailler en ms.
 *
 * Les trois collections sont des Map indexees par une cle canonique: c'est elle qui rend
 * comparables des sources qui ne nomment rien pareil, et c'est aussi elle qu'on persiste
 * dans l'instantane d'un cycle a l'autre.
 */
function emptyModel() {
  return { library: new Map(), watched: new Map(), progress: new Map() };
}

/** Nuvio stocke ses horodatages en millisecondes epoch (bigint), jamais en ISO. */
function toEpochMs(value) {
  if (!value) return Date.now();
  if (typeof value === 'number') return value > 1e11 ? value : value * 1000;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

const libKey = (type, id) => `${type}:${id}`;
const watchedKey = (type, id, season, episode) =>
  type === 'series' && season ? `series:${id}:${season}:${episode}` : `movie:${id}`;
const progressKey = watchedKey;

/** `movie:157336` / `series:1399:2:5` -> objet exploitable. */
function parseKey(key) {
  const [type, id, season, episode] = key.split(':');
  return {
    type: type === 'series' ? 'series' : 'movie',
    id: Number(id),
    season: season ? Number(season) : null,
    episode: episode ? Number(episode) : null,
  };
}

/** Titre + affiche d'un titre TMDB, tolerant a l'echec: le hub ne doit pas s'arreter la. */
async function describe(type, id) {
  try {
    const details = await cache.wrap(`meta:${type}:${id}`, config.CACHE_TTL_MS, config.CACHE_EMPTY_TTL_MS, () =>
      tmdbClient.details(type, id),
    );
    return { title: details.title || details.name || `TMDB ${id}`, poster_path: details.poster_path || '' };
  } catch {
    return { title: `TMDB ${id}`, poster_path: '' };
  }
}

module.exports = { emptyModel, toEpochMs, libKey, watchedKey, progressKey, parseKey, describe };
