const config = require('../../core/config');
const cache = require('../../core/cache');
const tmdbClient = require('../../integrations/tmdb');
const nuvio = require('../../integrations/nuvioCloud');
const ids = require('../../integrations/nuvioIds');
const { toEpochMs, parseKey, describe } = require('../model');

const TMDB_POSTER_BASE = 'https://image.tmdb.org/t/p/w500';
const TMDB_BACKDROP_BASE = 'https://image.tmdb.org/t/p/w1280';

/** Forme canonique partagee avec le push direct -- voir integrations/nuvioIds.js. */
const contentIdFor = (item) => ids.contentIdFor(item.id);

async function libraryRow(item) {
  const details = await cache.wrap(`meta:${item.type}:${item.id}`, config.CACHE_TTL_MS, config.CACHE_EMPTY_TTL_MS, () =>
    tmdbClient.details(item.type, item.id),
  );
  return {
    content_id: contentIdFor(item),
    content_type: item.type === 'series' ? 'series' : 'movie',
    name: details.title || details.name,
    poster: details.poster_path ? `${TMDB_POSTER_BASE}${details.poster_path}` : null,
    background: details.backdrop_path ? `${TMDB_BACKDROP_BASE}${details.backdrop_path}` : null,
    description: details.overview || null,
    release_info: (details.release_date || details.first_air_date || '').slice(0, 4) || null,
    genres: (details.genres || []).map((g) => g.name),
    // bigint cote Nuvio: une date ISO se fait rejeter par Postgres (22P02).
    added_at: toEpochMs(item.addedAt),
  };
}

async function applyToNuvio(profileId, delta, removals = { library: [] }) {
  const result = {};

  if (delta.library.length > 0 || removals.library.length > 0) {
    // sync_push_library REMPLACE toute la bibliotheque: il faut renvoyer l'union,
    // pas seulement les nouveautes, sous peine d'effacer le reste.
    const existing = await nuvio.pullLibrary(profileId);
    // Les lignes relues sont renvoyees telles quelles: si l'API les rend avec une date
    // ISO alors que l'ecriture attend un bigint, le push entier casse (22P02). On
    // normalise donc aussi ce qui vient de Nuvio, pas seulement ce qu'on fabrique.
    const merged = new Map(
      existing
        .filter((r) => r?.content_id)
        .map((r) => [r.content_id, { ...r, added_at: toEpochMs(r.added_at) }]),
    );
    for (const item of delta.library) {
      const row = await libraryRow(item);
      if (!merged.has(row.content_id)) merged.set(row.content_id, row);
    }
    // La bibliotheque Nuvio s'ecrit en remplacement complet: supprimer, c'est simplement
    // ne pas renvoyer la ligne. Aucun endpoint de suppression n'est necessaire.
    for (const key of removals.library) {
      const { type, id } = parseKey(key);
      merged.delete(contentIdFor({ type, id }));
    }
    await nuvio.pushLibrary(profileId, [...merged.values()]);
    result.library = delta.library.length;
    if (removals.library.length > 0) result.libraryRetirees = removals.library.length;
  }

  if (delta.watched.length > 0) {
    const items = await Promise.all(
      delta.watched.map(async (item) => {
        const meta = await describe(item.type, item.id);
        const suffix = item.season ? ` S${String(item.season).padStart(2, '0')}E${String(item.episode).padStart(2, '0')}` : '';
        return {
          content_id: contentIdFor(item),
          content_type: item.type === 'series' ? 'series' : 'movie',
          title: `${meta.title}${suffix}`,
          ...(item.season ? { season: item.season, episode: item.episode } : {}),
          watched_at: Date.now(),
        };
      }),
    );
    await nuvio.pushWatchedItems(profileId, items);
    result.watched = items.length;
  }

  if (delta.progress.length > 0) {
    const entries = delta.progress.map((item) => {
      const base = contentIdFor(item);
      const duration = Math.round(item.duration * 1000);
      const position = Math.min(Math.max(Math.round(item.position * 1000), 1), Math.max(1, duration - 1000));
      return {
        content_id: base,
        content_type: item.type === 'series' ? 'series' : 'movie',
        video_id: ids.videoIdFor(base, item.season, item.episode),
        position,
        duration,
        last_watched: Date.now(),
        ...(item.season ? { season: item.season, episode: item.episode } : {}),
      };
    });
    await nuvio.pushWatchProgress(profileId, entries);
    result.progress = entries.length;
  }

  return result;
}

module.exports = { applyToNuvio, libraryRow, contentIdFor };
