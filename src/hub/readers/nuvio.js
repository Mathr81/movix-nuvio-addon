const nuvio = require('../../integrations/nuvioCloud');
const ids = require('../../integrations/contentIds');
const { emptyModel, libKey, watchedKey, progressKey } = require('../model');

function nuvioType(row) {
  return row?.content_type === 'series' ? 'series' : 'movie';
}

/**
 * Deux lignes Nuvio peuvent retomber sur la MEME cle canonique: c'est exactement ce qui
 * arrive quand un titre existe a la fois sous `tt0903747` et sous `tmdb:1396`. Le
 * `Map.set` direct laissait alors gagner la derniere ligne resolue -- un ordre qui
 * depend de la latence de TMDB, donc arbitraire. Une position pouvait ainsi RECULER, et
 * le hub propageait ensuite ce recul jusqu'a Movix.
 *
 * On garde donc la position la plus avancee, comme partout ailleurs dans le hub.
 */
function keepFurthest(map, key, entry) {
  const existing = map.get(key);
  if (existing && Math.round(existing.position) >= Math.round(entry.position)) return;
  map.set(key, entry);
}

/**
 * Lecture du compte Nuvio. Les identifiants y sont soit `tmdb:<id>`, soit un id IMDb
 * herite: `toTmdbId` ramene les deux formes a un id TMDB, seule cle que le hub manipule.
 */
async function readNuvio(profileId) {
  const model = emptyModel();

  const [library, watched, progress] = await Promise.all([
    nuvio.pullLibrary(profileId),
    nuvio.pullWatchedItems(profileId).catch((err) => {
      console.warn(`[hub] lecture des elements vus Nuvio indisponible: ${err.message}`);
      return [];
    }),
    nuvio.pullWatchProgress(profileId).catch((err) => {
      console.warn(`[hub] lecture de la progression Nuvio indisponible: ${err.message}`);
      return [];
    }),
  ]);

  await Promise.all(
    library.map(async (row) => {
      const type = nuvioType(row);
      const id = await ids.toTmdbId(row.content_id, type);
      if (id) model.library.set(libKey(type, id), { type, id, kind: 'watchlist', addedAt: row.added_at });
    }),
  );

  await Promise.all(
    watched.map(async (row) => {
      const type = nuvioType(row);
      const id = await ids.toTmdbId(row.content_id, type);
      if (!id) return;
      const season = Number(row.season) || null;
      const episode = Number(row.episode) || null;
      model.watched.set(watchedKey(type, id, season, episode), { type, id, season, episode, watchedAt: row.watched_at });
    }),
  );

  await Promise.all(
    progress.map(async (row) => {
      const type = nuvioType(row);
      const id = await ids.toTmdbId(row.content_id, type);
      if (!id) return;
      const season = Number(row.season) || null;
      const episode = Number(row.episode) || null;
      // Nuvio stocke en millisecondes, le modele canonique est en secondes.
      const position = Number(row.position) / 1000;
      const duration = Number(row.duration) / 1000;
      if (!Number.isFinite(position) || !Number.isFinite(duration) || duration <= 0) return;
      keepFurthest(model.progress, progressKey(type, id, season, episode), {
        type,
        id,
        season,
        episode,
        position,
        duration,
      });
    }),
  );

  return model;
}

module.exports = { readNuvio };
