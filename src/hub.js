const fs = require('fs');
const path = require('path');
const config = require('./config');
const cache = require('./cache');
const movixSync = require('./movixSync');
const nuvio = require('./nuvioCloud');
const simkl = require('./simklCloud');
const tmdbClient = require('./tmdb');

/**
 * Hub de synchronisation bidirectionnel Movix <-> Nuvio Sync -> Simkl.
 *
 * Le probleme: le protocole d'addon ne notifie jamais la lecture, donc ce qui est
 * regarde DANS Nuvio est invisible de ce cote. La parade est de ne pas passer par
 * l'addon du tout mais par l'API cloud Nuvio, qui expose en lecture ce que l'app y
 * ecrit. Le hub interroge les deux cotes en boucle et propage les nouveautes.
 *
 * Methode: comparaison a un instantane du tour precedent, pas d'horodatage.
 * Movix n'estampille pas ses cles `progress_*`, donc "qui est le plus recent" est
 * indecidable par les donnees; en revanche "qu'est-ce qui a change depuis le dernier
 * tour" est exact des deux cotes. Un premier tour sans instantane traite tout comme
 * nouveau, ce qui produit exactement l'union voulue.
 *
 * Simkl ne recoit que l'historique et les listes: son API n'a pas d'endpoint de
 * position, et sa progression n'est de toute facon conservee qu'une semaine.
 */
const STATE_FILE = config.HUB_STATE_FILE || path.join(__dirname, '..', 'data', 'hub-state.json');

const TMDB_POSTER_BASE = 'https://image.tmdb.org/t/p/w500';
const TMDB_BACKDROP_BASE = 'https://image.tmdb.org/t/p/w1280';

// --- Instantane ------------------------------------------------------------

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
}

// --- Modele canonique ------------------------------------------------------
// Positions en SECONDES (unite Movix); la conversion en millisecondes est faite au
// moment d'ecrire vers Nuvio, qui est le seul a travailler en ms.

function emptyModel() {
  return { library: new Map(), watched: new Map(), progress: new Map() };
}

const libKey = (type, id) => `${type}:${id}`;
const watchedKey = (type, id, season, episode) =>
  type === 'series' && season ? `series:${id}:${season}:${episode}` : `movie:${id}`;
const progressKey = watchedKey;

async function readMovix() {
  const model = emptyModel();
  const data = await movixSync.fetchSyncData();
  if (!data) return model;

  const [wlMovies, wlSeries, favMovies, favSeries, watchedMovies, watchedSeries, episodes, progress] =
    await Promise.all([
      movixSync.getCollection('watchlist', 'movie'),
      movixSync.getCollection('watchlist', 'series'),
      movixSync.getCollection('favorites', 'movie'),
      movixSync.getCollection('favorites', 'series'),
      movixSync.getWatched('movie'),
      movixSync.getWatched('series'),
      movixSync.getWatchedEpisodes(),
      movixSync.getAllProgress(),
    ]);

  for (const [type, items, kind] of [
    ['movie', wlMovies, 'watchlist'],
    ['series', wlSeries, 'watchlist'],
    ['movie', favMovies, 'favorites'],
    ['series', favSeries, 'favorites'],
  ]) {
    for (const item of items) {
      const key = libKey(type, item.id);
      if (!model.library.has(key)) model.library.set(key, { type, id: Number(item.id), kind, addedAt: item.addedAt });
    }
  }

  for (const [type, items] of [['movie', watchedMovies], ['series', watchedSeries]]) {
    for (const item of items) {
      // Une serie "vue" sans detail d'episodes n'est pas transposable ailleurs
      // (Nuvio et Simkl raisonnent par episode): on ne retient que les episodes.
      if (type === 'series') continue;
      model.watched.set(watchedKey(type, item.id), { type, id: Number(item.id), watchedAt: item.addedAt });
    }
  }
  for (const ep of episodes) {
    model.watched.set(watchedKey('series', ep.showId, ep.season, ep.episode), {
      type: 'series',
      id: ep.showId,
      season: ep.season,
      episode: ep.episode,
    });
  }

  for (const p of progress) {
    model.progress.set(progressKey(p.type, p.id, p.season, p.episode), {
      type: p.type,
      id: p.id,
      season: p.season,
      episode: p.episode,
      position: p.position,
      duration: p.duration,
    });
  }

  return model;
}

/**
 * Les identifiants Nuvio sont soit `tmdb:<id>`, soit un id IMDb selon NUVIO_ID_PREFERENCE.
 * Tout le reste du hub raisonne en id TMDB: on resout donc ici, avec cache long
 * (une correspondance IMDb <-> TMDB ne change jamais).
 */
async function toTmdbId(contentId, type) {
  if (contentId === null || contentId === undefined) return null;
  const raw = String(contentId);

  if (raw.startsWith('tmdb:')) return Number(raw.slice(5)) || null;
  if (/^\d+$/.test(raw)) return Number(raw);
  if (!raw.startsWith('tt')) return null;

  const key = `tmdbOf:${raw}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  let id = null;
  try {
    const found = await tmdbClient.findByImdbId(raw);
    const list = type === 'series' ? found.tv_results : found.movie_results;
    id = list?.[0]?.id || null;
  } catch {
    id = null;
  }
  cache.set(key, id, 24 * 60 * 60 * 1000);
  return id;
}

function nuvioType(row) {
  return row?.content_type === 'series' ? 'series' : 'movie';
}

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
      const id = await toTmdbId(row.content_id, type);
      if (id) model.library.set(libKey(type, id), { type, id, kind: 'watchlist', addedAt: row.added_at });
    }),
  );

  await Promise.all(
    watched.map(async (row) => {
      const type = nuvioType(row);
      const id = await toTmdbId(row.content_id, type);
      if (!id) return;
      const season = Number(row.season) || null;
      const episode = Number(row.episode) || null;
      model.watched.set(watchedKey(type, id, season, episode), { type, id, season, episode, watchedAt: row.watched_at });
    }),
  );

  await Promise.all(
    progress.map(async (row) => {
      const type = nuvioType(row);
      const id = await toTmdbId(row.content_id, type);
      if (!id) return;
      const season = Number(row.season) || null;
      const episode = Number(row.episode) || null;
      // Nuvio stocke en millisecondes, le modele canonique est en secondes.
      const position = Number(row.position) / 1000;
      const duration = Number(row.duration) / 1000;
      if (!Number.isFinite(position) || !Number.isFinite(duration) || duration <= 0) return;
      model.progress.set(progressKey(type, id, season, episode), { type, id, season, episode, position, duration });
    }),
  );

  return model;
}

// --- Diff ------------------------------------------------------------------

/** Empreinte comparable d'un modele: c'est elle qui est persistee entre deux tours. */
function snapshot(model) {
  return {
    library: [...model.library.keys()],
    watched: [...model.watched.keys()],
    // La position arrondie a la seconde suffit a detecter une lecture; la garder brute
    // ferait diverger l'empreinte a chaque tour pour cause d'arrondi flottant.
    progress: Object.fromEntries([...model.progress].map(([k, v]) => [k, Math.round(v.position)])),
  };
}

/** Ce qui est apparu (ou a bouge) dans `model` depuis l'instantane `previous`. */
function changesSince(model, previous) {
  const prevLibrary = new Set(previous?.library || []);
  const prevWatched = new Set(previous?.watched || []);
  const prevProgress = previous?.progress || {};

  return {
    library: [...model.library].filter(([k]) => !prevLibrary.has(k)).map(([, v]) => v),
    watched: [...model.watched].filter(([k]) => !prevWatched.has(k)).map(([, v]) => v),
    progress: [...model.progress]
      .filter(([k, v]) => Math.round(v.position) !== prevProgress[k])
      .map(([, v]) => v),
  };
}

/** Retire d'un delta ce que la cible possede deja a l'identique. */
function notYetIn(delta, target) {
  return {
    library: delta.library.filter((e) => !target.library.has(libKey(e.type, e.id))),
    watched: delta.watched.filter((e) => !target.watched.has(watchedKey(e.type, e.id, e.season, e.episode))),
    progress: delta.progress.filter((e) => {
      const existing = target.progress.get(progressKey(e.type, e.id, e.season, e.episode));
      // Conflit reel (les deux cotes ont bouge): la position la plus avancee gagne.
      // A defaut d'horodatage fiable cote Movix, c'est la regle qui perd le moins.
      return !existing || Math.round(existing.position) < Math.round(e.position);
    }),
  };
}

const deltaSize = (d) => d.library.length + d.watched.length + d.progress.length;

// --- Ecriture vers Movix ---------------------------------------------------

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

function parseJson(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/**
 * Applique un delta au compte Movix. Les formes ecrites reproduisent exactement celles
 * du site (cf. MovieDetails.tsx:4141, Profile.tsx:1255, WatchMovie.tsx:712), sinon
 * l'interface du site afficherait des entrees incompletes.
 */
async function applyToMovix(delta) {
  const raw = await movixSync.fetchSyncData();
  if (!raw) throw new Error('sync Movix indisponible');

  const entries = new Map(); // cle localStorage -> valeur (objet, serialise a l'envoi)
  const readKey = (key, fallback) => {
    if (entries.has(key)) return entries.get(key);
    return parseJson(raw[key], fallback);
  };

  for (const item of delta.library) {
    const key = item.type === 'series' ? 'watchlist_tv' : 'watchlist_movie';
    const list = readKey(key, []);
    if (!Array.isArray(list) || list.some((e) => Number(e?.id) === item.id)) continue;
    const meta = await describe(item.type, item.id);
    list.push({
      id: item.id,
      type: item.type === 'series' ? 'tv' : 'movie',
      title: meta.title,
      poster_path: meta.poster_path,
      addedAt: item.addedAt || new Date().toISOString(),
    });
    entries.set(key, list);
  }

  for (const item of delta.watched) {
    if (item.type === 'series' && item.season) {
      const key = `watched_episodes_tv_${item.id}`;
      const map = readKey(key, {});
      if (typeof map !== 'object' || map === null) continue;
      map[`S${item.season}E${item.episode}`] = true;
      entries.set(key, map);
    } else {
      const key = item.type === 'series' ? 'watched_tv' : 'watched_movie';
      const list = readKey(key, []);
      if (!Array.isArray(list) || list.some((e) => Number(e?.id) === item.id)) continue;
      const meta = await describe(item.type, item.id);
      list.unshift({
        id: item.id,
        type: item.type === 'series' ? 'tv' : 'movie',
        title: meta.title,
        poster_path: meta.poster_path,
        addedAt: new Date().toISOString(),
      });
      entries.set(key, list);
    }
  }

  if (delta.progress.length > 0) {
    const continueWatching = readKey('continueWatching', { movies: [], tv: [] });
    if (!continueWatching.movies) continueWatching.movies = [];
    if (!continueWatching.tv) continueWatching.tv = [];

    for (const item of delta.progress) {
      const key =
        item.type === 'series'
          ? `progress_tv_${item.id}_s${item.season}_e${item.episode}`
          : `progress_${item.id}`;
      entries.set(key, { position: item.position, duration: item.duration });

      // Le site place le titre en tete de "Reprendre" a chaque lecture: on fait pareil,
      // sinon la reprise existerait sans apparaitre nulle part dans l'interface.
      const bucket = item.type === 'series' ? continueWatching.tv : continueWatching.movies;
      const index = bucket.findIndex((e) => Number(typeof e === 'number' ? e : e?.id) === item.id);
      if (index !== -1) bucket.splice(index, 1);
      bucket.unshift({
        id: item.id,
        lastAccessed: new Date().toISOString(),
        ...(item.type === 'series' ? { currentEpisode: { season: item.season, episode: item.episode } } : {}),
      });
    }
    entries.set('continueWatching', continueWatching);
  }

  if (entries.size === 0) return { applied: 0 };
  return movixSync.writeSync([...entries].map(([key, value]) => ({ key, value })));
}

// --- Ecriture vers Nuvio ---------------------------------------------------

function contentIdFor(item) {
  return `tmdb:${item.id}`;
}

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
    added_at: item.addedAt || new Date().toISOString(),
  };
}

async function applyToNuvio(profileId, delta, nuvioModel) {
  const result = {};

  if (delta.library.length > 0) {
    // sync_push_library REMPLACE toute la bibliotheque: il faut renvoyer l'union,
    // pas seulement les nouveautes, sous peine d'effacer le reste.
    const existing = await nuvio.pullLibrary(profileId);
    const merged = new Map(existing.filter((r) => r?.content_id).map((r) => [r.content_id, r]));
    for (const item of delta.library) {
      const row = await libraryRow(item);
      if (!merged.has(row.content_id)) merged.set(row.content_id, row);
    }
    await nuvio.pushLibrary(profileId, [...merged.values()]);
    result.library = delta.library.length;
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
        video_id: item.season ? `${base}:${item.season}:${item.episode}` : base,
        position,
        duration,
        last_watched: Date.now(),
        ...(item.season ? { season: item.season, episode: item.episode } : {}),
      };
    });
    await nuvio.pushWatchProgress(profileId, entries);
    result.progress = entries.length;
  }

  void nuvioModel;
  return result;
}

// --- Ecriture vers Simkl ---------------------------------------------------

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

// --- Cycle -----------------------------------------------------------------

let running = false;
let lastRun = null;

async function runCycle({ dryRun = false } = {}) {
  if (running) return { ok: false, skipped: 'un cycle est deja en cours' };
  running = true;

  try {
    // Le hub veut l'etat courant, pas la version en cache du catalogue.
    movixSync.invalidate();

    const profiles = await nuvio.pullProfiles();
    const profileId = config.NUVIO_PROFILE_INDEX || Number(profiles[0]?.profile_index) || 1;

    const [movix, nuvioModel] = await Promise.all([readMovix(), readNuvio(profileId)]);
    const previous = loadState();

    const movixDelta = notYetIn(changesSince(movix, previous?.movix), nuvioModel);
    const nuvioDelta = notYetIn(changesSince(nuvioModel, previous?.nuvio), movix);

    const summary = {
      ok: true,
      dryRun,
      profileId,
      premierTour: !previous,
      movix: { library: movix.library.size, watched: movix.watched.size, progress: movix.progress.size },
      nuvio: { library: nuvioModel.library.size, watched: nuvioModel.watched.size, progress: nuvioModel.progress.size },
      versNuvio: { library: movixDelta.library.length, watched: movixDelta.watched.length, progress: movixDelta.progress.length },
      versMovix: { library: nuvioDelta.library.length, watched: nuvioDelta.watched.length, progress: nuvioDelta.progress.length },
    };

    if (dryRun) {
      summary.samples = { versNuvio: movixDelta.progress.slice(0, 2), versMovix: nuvioDelta.progress.slice(0, 2) };
      running = false;
      return summary;
    }

    summary.errors = {};
    const step = async (name, fn) => {
      try {
        const value = await fn();
        if (value) summary[name] = value;
      } catch (err) {
        summary.ok = false;
        summary.errors[name] = err.message;
        console.error(`[hub] ${name}: ${err.message}`);
      }
    };

    if (deltaSize(movixDelta) > 0) await step('pousseVersNuvio', () => applyToNuvio(profileId, movixDelta, nuvioModel));
    if (deltaSize(nuvioDelta) > 0) await step('pousseVersMovix', () => applyToMovix(nuvioDelta));

    // Simkl recoit l'union des deux cotes: c'est un miroir, jamais une source.
    const forSimkl = {
      library: [...movixDelta.library, ...nuvioDelta.library],
      watched: [...movixDelta.watched, ...nuvioDelta.watched],
      progress: [],
    };
    if (deltaSize(forSimkl) > 0) await step('pousseVersSimkl', () => applyToSimkl(forSimkl));

    // L'instantane n'est enregistre qu'en cas de succes complet: un echec partiel doit
    // etre rejoue au tour suivant, pas oublie.
    if (summary.ok) saveState({ movix: snapshot(movix), nuvio: snapshot(nuvioModel) });

    lastRun = { at: new Date().toISOString(), summary };
    if (deltaSize(movixDelta) + deltaSize(nuvioDelta) > 0 || !summary.ok) {
      console.log('[hub] cycle:', JSON.stringify(summary));
    }
    return summary;
  } finally {
    running = false;
  }
}

function start() {
  if (!config.HUB_ENABLED) return;
  if (!config.MOVIX_JWT || !config.NUVIO_EMAIL) {
    console.warn('[hub] desactive: MOVIX_JWT et NUVIO_EMAIL sont tous deux requis');
    return;
  }

  const seconds = Math.round(config.HUB_INTERVAL_MS / 1000);
  console.log(`Hub de synchronisation actif (cycle toutes les ${seconds}s)`);
  const tick = () => runCycle().catch((err) => console.error(`[hub] cycle echoue: ${err.message}`));
  tick();
  setInterval(tick, config.HUB_INTERVAL_MS).unref();
}

function status() {
  return { enabled: config.HUB_ENABLED, intervalMs: config.HUB_INTERVAL_MS, running, lastRun };
}

module.exports = { runCycle, start, status, STATE_FILE };
