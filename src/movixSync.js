const { mainApi } = require('./movixClient');
const config = require('./config');
const cache = require('./cache');

/**
 * Lit les donnees synchronisees du compte Movix (GET /api/sync/:userType/:userId/:profileId).
 * Cette route exige un JWT: c'est la meme donnee que le localStorage du site
 * (continueWatching, watchlist_*, favorite_*...), cf. src/utils/syncStorage.ts.
 */
async function fetchSyncData() {
  if (!config.MOVIX_JWT || !config.MOVIX_USER_ID) return null;

  return cache.wrap('sync:data', config.SYNC_TTL_MS, config.SYNC_TTL_MS, async () => {
    const segments = [config.MOVIX_USER_TYPE, config.MOVIX_USER_ID];
    if (config.MOVIX_PROFILE_ID) segments.push(config.MOVIX_PROFILE_ID);

    try {
      const { data } = await mainApi.get(`/api/sync/${segments.join('/')}`, {
        headers: { Authorization: `Bearer ${config.MOVIX_JWT}` },
      });
      const payload = data?.data || {};
      console.log(`[sync] donnees recuperees (${Object.keys(payload).length} cles)`);
      return payload;
    } catch (err) {
      const status = err.response?.status;
      const body = err.response?.data;
      if (status === 400 && body?.code === 'PROFILE_ID_REQUIRED') {
        console.warn(
          `[sync] ce compte a des profils: renseigne MOVIX_PROFILE_ID (profil par defaut: ${body.defaultProfileId})`,
        );
      } else if (status === 401) {
        console.warn('[sync] 401 -- MOVIX_JWT invalide/expire ou MOVIX_USER_ID incoherent');
      } else {
        console.warn(`[sync] echec: status=${status ?? 'n/a'} msg=${err.message}`);
      }
      return null;
    }
  });
}

/** Les valeurs synchronisees sont parfois des chaines JSON (copie brute du localStorage). */
function parseCollection(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function normalizeType(item) {
  const raw = item.media_type || item.type;
  return raw === 'tv' || raw === 'series' ? 'series' : 'movie';
}

/**
 * Elements "reprendre la lecture", tries du plus recent au plus ancien.
 * Structure cote site: {id, title|name, poster_path, media_type, progress, lastAccessed|lastWatched,
 * currentEpisode:{season,episode}} (cf. src/pages/Home.tsx:138-155).
 */
async function getContinueWatching(type) {
  const data = await fetchSyncData();
  if (!data) return [];

  return parseCollection(data.continueWatching)
    .filter((item) => item && item.id && normalizeType(item) === type)
    .sort((a, b) => new Date(b.lastAccessed || b.lastWatched || 0) - new Date(a.lastAccessed || a.lastWatched || 0));
}

/** Watchlist / favoris, fusionnes depuis les differentes cles du site. */
async function getCollection(kind, type) {
  const data = await fetchSyncData();
  if (!data) return [];

  const keys =
    kind === 'watchlist'
      ? type === 'series'
        ? ['watchlist_tv', 'watchlist_series']
        : ['watchlist_movie', 'watchlist_movies']
      : type === 'series'
        ? ['favorites_tv', 'favorite_tv']
        : ['favorite_movie', 'favorite_movies'];

  const merged = [];
  const seen = new Set();
  for (const key of keys) {
    for (const item of parseCollection(data[key])) {
      if (!item?.id || seen.has(item.id)) continue;
      seen.add(item.id);
      merged.push(item);
    }
  }

  return merged.sort((a, b) => new Date(b.addedAt || 0) - new Date(a.addedAt || 0));
}

module.exports = { fetchSyncData, getContinueWatching, getCollection };
