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

/**
 * Nuvio attend des timestamps en millisecondes depuis l'epoch (nombre), pas des
 * chaines ISO: une date ISO est rejetee par l'API.
 */
function toEpochMs(value) {
  if (!value) return Date.now();
  if (typeof value === 'number') return value > 1e11 ? value : value * 1000;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

/**
 * Positions et durees sont en MILLISECONDES cote Nuvio, alors que Movix les stocke
 * en secondes (valeurs brutes de l'element <video>). Sans conversion, une position
 * de 2400 s serait interpretee comme 2,4 s.
 */
function toMs(seconds) {
  return Math.round(Number(seconds) * 1000);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** Titre lisible, requis par l'API pour les elements vus. */
async function titleFor(type, tmdbId) {
  try {
    const details = await cache.wrap(`meta:${type}:${tmdbId}`, config.CACHE_TTL_MS, config.CACHE_EMPTY_TTL_MS, () =>
      tmdbClient.details(type, tmdbId),
    );
    return details.title || details.name || null;
  } catch {
    return null;
  }
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
    // bigint cote Nuvio: une date ISO se fait rejeter par Postgres (22P02).
    added_at: toEpochMs(addedAt),
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
          title: item.title || item.name || (await titleFor(type, item.id)) || `TMDB ${item.id}`,
          watched_at: toEpochMs(item.watchedAt || item.addedAt),
        }))(),
      );
    }
  }

  // Un episode vu porte le content_id de la SERIE, plus les champs season/episode --
  // pas de video_id ici (contrairement a la progression, ou il est attendu).
  for (const ep of episodes) {
    tasks.push(
      (async () => {
        const [base, showTitle] = await Promise.all([
          contentId('series', ep.showId),
          titleFor('series', ep.showId),
        ]);
        return {
          content_id: base,
          content_type: 'series',
          title: `${showTitle || `TMDB ${ep.showId}`} S${pad2(ep.season)}E${pad2(ep.episode)}`,
          season: ep.season,
          episode: ep.episode,
          watched_at: Date.now(),
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
      const duration = toMs(e.duration);
      // Rester strictement dans ]0, duree[: une position egale a la duree ferait
      // passer le titre pour termine et non pour "en cours".
      const position = clamp(toMs(e.position), 1, Math.max(1, duration - 1000));

      const entry = {
        content_id: base,
        content_type: nuvioType(e.type),
        video_id: e.type === 'series' ? `${base}:${e.season}:${e.episode}` : base,
        position,
        duration,
        last_watched: Date.now(),
      };
      if (e.type === 'series') {
        entry.season = e.season;
        entry.episode = e.episode;
      }
      return entry;
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
    summary.samples = {
      library: finalLibrary.slice(-1),
      watched: watchedItems.slice(0, 1),
      progress: progressEntries.slice(0, 1),
    };
    return summary;
  }

  // Les trois envois sont independants: un echec sur l'un ne doit pas empecher les
  // autres, et le resume doit dire lequel a echoue plutot qu'un 400 anonyme.
  const steps = [
    ['library', () => nuvio.pushLibrary(profileId, finalLibrary), finalLibrary.length],
    ['watched', () => nuvio.pushWatchedItems(profileId, watchedItems), watchedItems.length],
    ['progress', () => nuvio.pushWatchProgress(profileId, progressEntries), progressEntries.length],
  ];

  summary.pushed = {};
  summary.errors = {};
  for (const [name, run, count] of steps) {
    if (count === 0) {
      summary.pushed[name] = 0;
      continue;
    }
    try {
      await run();
      summary.pushed[name] = count;
    } catch (err) {
      summary.ok = false;
      summary.errors[name] = err.message;
      console.error(`[nuvio-push] ${name}: ${err.message}`);
    }
  }

  console.log('[nuvio-push] termine:', JSON.stringify(summary));
  return summary;
}

module.exports = { pushToNuvio };
