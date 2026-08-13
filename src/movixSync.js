const { mainApi } = require('./movixClient');
const config = require('./config');
const cache = require('./cache');

/**
 * Lit les donnees synchronisees du compte Movix (GET /api/sync/:userType/:userId/:profileId).
 * Cette route exige un JWT: c'est la meme donnee que le localStorage du site
 * (continueWatching, watchlist_*, favorite_*...), cf. src/utils/syncStorage.ts.
 */
/**
 * Interprete un echec de sync. Un 404 a deux origines tres differentes cote Mainapi,
 * heureusement distinguables par le corps de la reponse:
 *  - domainRestriction (middleware/security.js:159) repond {"error":"Not Found"} en JSON
 *    quand l'Origin/Referer n'est pas dans son allowlist;
 *  - Express repond du HTML "Cannot GET /..." quand aucune route ne correspond, ce qui
 *    signifie que l'API deployee n'expose pas cette route.
 */
function explainFailure(err, url) {
  const status = err.response?.status;
  const body = err.response?.data;
  const bodyText = typeof body === 'string' ? body : JSON.stringify(body || '');

  console.warn(`[sync] echec sur ${url} -- status=${status ?? 'n/a'} msg=${err.message}`);
  if (bodyText) console.warn(`[sync] corps de reponse: ${bodyText.slice(0, 300)}`);

  if (status === 400 && body?.code === 'PROFILE_ID_REQUIRED') {
    console.warn(`[sync] -> ce compte a des profils: renseigne MOVIX_PROFILE_ID (defaut: ${body.defaultProfileId})`);
  } else if (status === 400 && body?.code === 'INVALID_USER_TYPE') {
    console.warn('[sync] -> MOVIX_USER_TYPE doit valoir "bip39" ou "oauth"');
  } else if (status === 400) {
    console.warn('[sync] -> MOVIX_USER_ID ou MOVIX_PROFILE_ID a un format refuse par le serveur');
  } else if (status === 401) {
    console.warn('[sync] -> MOVIX_JWT invalide/expire, ou incoherent avec MOVIX_USER_ID/MOVIX_USER_TYPE');
  } else if (status === 404 && /cannot get/i.test(bodyText)) {
    console.warn(
      '[sync] -> l\'API deployee n\'expose PAS cette route (elle existe dans le depot mais pas en prod). ' +
        'Les catalogues personnels ne sont pas disponibles sur cette instance.',
    );
  } else if (status === 404) {
    console.warn(
      '[sync] -> 404 renvoye par domainRestriction: Origin/Referer refuse. ' +
        `Verifie SPOOFED_ORIGIN (actuel: ${config.SPOOFED_ORIGIN}) contre l'allowlist de middleware/security.js`,
    );
  }
}

async function fetchSyncData() {
  if (!config.MOVIX_JWT || !config.MOVIX_USER_ID) return null;

  return cache.wrap('sync:data', config.SYNC_TTL_MS, config.SYNC_TTL_MS, async () => {
    // Deux formes possibles: avec profil (comptes multi-profils) et sans (comptes legacy).
    // On essaie la plus specifique d'abord, puis on retombe sur l'autre.
    const base = `/api/sync/${config.MOVIX_USER_TYPE}/${config.MOVIX_USER_ID}`;
    const candidates = config.MOVIX_PROFILE_ID ? [`${base}/${config.MOVIX_PROFILE_ID}`, base] : [base];

    let lastError = null;
    for (const url of candidates) {
      try {
        const { data } = await mainApi.get(url, {
          headers: { Authorization: `Bearer ${config.MOVIX_JWT}` },
        });
        const payload = data?.data || {};
        console.log(`[sync] OK sur ${url} (${Object.keys(payload).length} cles)`);
        return payload;
      } catch (err) {
        lastError = { err, url };
        // Un 400 PROFILE_ID_REQUIRED sur la forme sans profil est informatif: on le remonte.
        if (err.response?.status === 400 && err.response?.data?.code === 'PROFILE_ID_REQUIRED') break;
      }
    }

    if (lastError) explainFailure(lastError.err, lastError.url);
    return null;
  });
}

/** Les valeurs synchronisees sont des copies brutes du localStorage: parfois deja
 * desserialisees, parfois encore sous forme de chaine JSON. */
function parseValue(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseCollection(value) {
  const parsed = parseValue(value);
  return Array.isArray(parsed) ? parsed : [];
}

/**
 * Progression d'un titre, en pourcentage.
 * Le site ne la stocke PAS dans continueWatching mais dans des cles dediees
 * `progress_<id>` / `progress_tv_<id>_s<saison>_e<episode>` valant {position, duration}
 * en secondes (cf. EmblaCarousel.tsx:609-652).
 */
function progressPercent(data, type, id, currentEpisode) {
  const key =
    type === 'series' && currentEpisode
      ? `progress_tv_${id}_s${currentEpisode.season}_e${currentEpisode.episode}`
      : `progress_${id}`;

  const entry = parseValue(data[key]);
  const position = Number(entry?.position);
  const duration = Number(entry?.duration);
  if (!Number.isFinite(position) || !Number.isFinite(duration) || duration <= 0) return undefined;

  return Math.min((position / duration) * 100, 100);
}

/**
 * Elements "reprendre la lecture", tries du plus recent au plus ancien.
 *
 * ATTENTION: `continueWatching` n'est pas un tableau mais un objet
 * {movies: [...], tv: [...]} (cf. WatchMovie.tsx:692-717, WatchTv.tsx:1204-1239).
 * Les entrees ne portent que {id, lastAccessed} (+ currentEpisode pour les series);
 * ni titre, ni affiche, ni progression -- d'ou le passage par TMDB et par les cles
 * `progress_*` ci-dessus. Un ancien format stocke les films comme de simples nombres.
 */
async function getContinueWatching(type) {
  const data = await fetchSyncData();
  if (!data) return [];

  const root = parseValue(data.continueWatching);
  if (!root || typeof root !== 'object') return [];

  const list = Array.isArray(root)
    ? root // format historique: liste plate portant media_type
    : type === 'series'
      ? root.tv
      : root.movies;

  if (!Array.isArray(list)) return [];

  return list
    .map((item) => (typeof item === 'number' ? { id: item } : item))
    .filter((item) => {
      if (!item?.id) return false;
      // Liste plate historique: filtrer sur media_type; sinon la cle a deja fait le tri.
      if (Array.isArray(root)) {
        const raw = item.media_type || item.type;
        return (raw === 'tv' || raw === 'series' ? 'series' : 'movie') === type;
      }
      return true;
    })
    .map((item) => ({
      ...item,
      progress: item.progress ?? progressPercent(data, type, item.id, item.currentEpisode),
    }))
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
