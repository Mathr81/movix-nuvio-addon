const config = require('./config');
const cache = require('./cache');
const movixSync = require('./movixSync');
const nuvio = require('./nuvioCloud');
const tmdbClient = require('./tmdb');

const TMDB_POSTER_BASE = 'https://image.tmdb.org/t/p/w500';
const TMDB_BACKDROP_BASE = 'https://image.tmdb.org/t/p/w1280';

/**
 * content_id attendu par Nuvio: un id IMDb (`tt...`) de preference, sinon `tmdb:<id>`.
 * L'ecosysteme Stremio/Nuvio (Cinemeta) indexe par IMDb: utiliser le meme identifiant
 * permet aux entrees poussees de correspondre aux fiches que Nuvio affiche.
 */
async function contentId(type, tmdbId) {
  if (config.NUVIO_ID_PREFERENCE !== 'imdb') return `tmdb:${tmdbId}`;

  const key = `imdb:${type}:${tmdbId}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  let id;
  try {
    id = (await tmdbClient.getImdbId(type, tmdbId)) || `tmdb:${tmdbId}`;
  } catch {
    id = `tmdb:${tmdbId}`;
  }
  cache.set(key, id, 24 * 60 * 60 * 1000);
  return id;
}

function nuvioType(type) {
  return type === 'series' ? 'series' : 'movie';
}

/** Fiche TMDB enrichie pour la bibliotheque (Nuvio stocke le titre et les visuels). */
async function libraryEntry(type, tmdbId, addedAt) {
  const details = await cache.wrap(`meta:${type}:${tmdbId}`, config.CACHE_TTL_MS, config.CACHE_EMPTY_TTL_MS, () =>
    tmdbClient.details(type, tmdbId),
  );

  return {
    content_id: await contentId(type, tmdbId),
    content_type: nuvioType(type),
    name: details.title || details.name,
    poster: details.poster_path ? `${TMDB_POSTER_BASE}${details.poster_path}` : null,
    background: details.backdrop_path ? `${TMDB_BACKDROP_BASE}${details.backdrop_path}` : null,
    description: details.overview || null,
    release_info: (details.release_date || details.first_air_date || '').slice(0, 4) || null,
    genres: (details.genres || []).map((g) => g.name),
    added_at: addedAt || new Date().toISOString(),
  };
}

async function settleAll(promises, label) {
  const settled = await Promise.allSettled(promises);
  const failures = settled.filter((r) => r.status === 'rejected');
  if (failures.length > 0) {
    console.warn(`[nuvio-push] ${failures.length} entree(s) ignoree(s) dans ${label}: ${failures[0].reason?.message}`);
  }
  return settled.filter((r) => r.status === 'fulfilled').map((r) => r.value);
}

/** Bibliotheque = watchlist + favoris Movix, dedupliquee. */
async function buildLibraryItems() {
  const groups = await Promise.all([
    movixSync.getCollection('watchlist', 'movie'),
    movixSync.getCollection('watchlist', 'series'),
    movixSync.getCollection('favorites', 'movie'),
    movixSync.getCollection('favorites', 'series'),
  ]);

  const wanted = new Map();
  [
    ['movie', groups[0]],
    ['series', groups[1]],
    ['movie', groups[2]],
    ['series', groups[3]],
  ].forEach(([type, items]) => {
    for (const item of items) {
      const key = `${type}:${item.id}`;
      if (!wanted.has(key)) wanted.set(key, { type, id: item.id, addedAt: item.addedAt });
    }
  });

  return settleAll(
    [...wanted.values()].map((e) => libraryEntry(e.type, e.id, e.addedAt)),
    'la bibliotheque',
  );
}

async function buildWatchedItems() {
  const [movies, series, episodes] = await Promise.all([
    movixSync.getWatched('movie'),
    movixSync.getWatched('series'),
    movixSync.getWatchedEpisodes(),
  ]);

  const tasks = [];

  for (const [type, items] of [['movie', movies], ['series', series]]) {
    for (const item of items) {
      tasks.push(
        (async () => ({
          content_id: await contentId(type, item.id),
          content_type: nuvioType(type),
          title: item.title || item.name || null,
          watched_at: item.watchedAt || item.addedAt || new Date().toISOString(),
        }))(),
      );
    }
  }

  // Un episode vu est rattache a sa serie via l'id video `<content_id>:<saison>:<episode>`.
  for (const ep of episodes) {
    tasks.push(
      (async () => {
        const base = await contentId('series', ep.showId);
        return {
          content_id: base,
          content_type: 'series',
          video_id: `${base}:${ep.season}:${ep.episode}`,
          season: ep.season,
          episode: ep.episode,
          watched_at: new Date().toISOString(),
        };
      })(),
    );
  }

  return settleAll(tasks, 'les elements vus');
}

async function buildProgressEntries() {
  const entries = await movixSync.getAllProgress();

  return settleAll(
    entries.map(async (e) => {
      const base = await contentId(e.type, e.id);
      return {
        content_id: base,
        content_type: nuvioType(e.type),
        video_id: e.type === 'series' ? `${base}:${e.season}:${e.episode}` : base,
        season: e.season ?? null,
        episode: e.episode ?? null,
        position: e.position,
        duration: e.duration,
        last_watched: new Date().toISOString(),
      };
    }),
    'la progression',
  );
}

/**
 * Pousse les donnees Movix vers Nuvio Sync.
 *
 * `sync_push_library` REMPLACE integralement la bibliotheque du profil: on lit donc
 * d'abord l'existant et on fusionne, sinon tout ce que l'utilisateur a ajoute depuis
 * Nuvio serait efface. Les deux autres endpoints sont additifs.
 */
async function pushToNuvio({ dryRun = false } = {}) {
  if (!config.NUVIO_EMAIL || !config.NUVIO_PASSWORD) {
    return { ok: false, error: 'NUVIO_EMAIL / NUVIO_PASSWORD non renseignes' };
  }

  const profiles = await nuvio.pullProfiles();
  const profileId =
    config.NUVIO_PROFILE_INDEX ||
    Number(profiles[0]?.profile_index) ||
    1;
  console.log(`[nuvio-push] profil ${profileId} (${profiles.length} profil(s) disponible(s))`);

  const [libraryItems, watchedItems, progressEntries] = await Promise.all([
    buildLibraryItems(),
    buildWatchedItems(),
    buildProgressEntries(),
  ]);

  const existing = await nuvio.pullLibrary(profileId);
  const merged = new Map();
  for (const row of existing) {
    if (row?.content_id) merged.set(row.content_id, row);
  }
  let added = 0;
  for (const item of libraryItems) {
    if (!merged.has(item.content_id)) added += 1;
    merged.set(item.content_id, item); // Movix fait autorite sur les entrees qu'il connait
  }
  const finalLibrary = [...merged.values()];

  const summary = {
    ok: true,
    dryRun,
    profileId,
    library: { fromMovix: libraryItems.length, alreadyInNuvio: existing.length, added, totalAfterMerge: finalLibrary.length },
    watched: watchedItems.length,
    progress: progressEntries.length,
  };

  if (dryRun) {
    console.log('[nuvio-push] simulation (dryRun), aucun envoi:', JSON.stringify(summary));
    return summary;
  }

  if (finalLibrary.length > 0) await nuvio.pushLibrary(profileId, finalLibrary);
  if (watchedItems.length > 0) await nuvio.pushWatchedItems(profileId, watchedItems);
  if (progressEntries.length > 0) await nuvio.pushWatchProgress(profileId, progressEntries);

  console.log('[nuvio-push] termine:', JSON.stringify(summary));
  return summary;
}

module.exports = { pushToNuvio };
