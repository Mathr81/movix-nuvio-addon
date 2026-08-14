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

// --- Lecture Simkl ---------------------------------------------------------

/**
 * Simkl est la seule des trois sources a avoir de vrais statuts (plantowatch / watching /
 * completed), la ou Nuvio n'a qu'une bibliotheque plate. On les traduit vers le modele
 * canonique: plantowatch + watching alimentent la bibliotheque, completed l'historique.
 *
 * Formes confirmees sur un compte reel via `npm run simkl:probe`:
 *   /sync/all-items/movies/<statut> -> {movies: [{status, movie: {ids: {tmdb: "9919"}}}]}
 *   /sync/all-items/shows/<statut>  -> {shows:  [{status, show:  {ids}, seasons: [...]}]}
 * Attention: `ids.tmdb` est une CHAINE cote Simkl.
 */
function simklTmdbId(node) {
  const raw = node?.ids?.tmdb;
  const id = Number(raw);
  return Number.isFinite(id) && id > 0 ? id : null;
}

async function readSimkl() {
  const model = emptyModel();
  if (!simkl.isAuthenticated()) return model;

  const buckets = await Promise.all([
    simkl.allItems('movies', 'plantowatch').catch(() => null),
    simkl.allItems('shows', 'plantowatch').catch(() => null),
    simkl.allItems('shows', 'watching').catch(() => null),
    simkl.allItems('movies', 'completed').catch(() => null),
    simkl.allItems('shows', 'completed').catch(() => null),
  ]);

  const addLibrary = (rows, type, key) => {
    for (const row of rows || []) {
      const id = simklTmdbId(row[key]);
      if (id) model.library.set(libKey(type, id), { type, id, kind: 'watchlist', addedAt: row.added_to_watchlist_at });
    }
  };

  addLibrary(buckets[0]?.movies, 'movie', 'movie');
  addLibrary(buckets[1]?.shows, 'series', 'show');
  addLibrary(buckets[2]?.shows, 'series', 'show');

  for (const row of buckets[3]?.movies || []) {
    const id = simklTmdbId(row.movie);
    if (id) model.watched.set(watchedKey('movie', id), { type: 'movie', id, watchedAt: row.last_watched_at });
  }

  // Les episodes vus sont dans `seasons`, present sur les series en cours comme terminees.
  for (const row of [...(buckets[2]?.shows || []), ...(buckets[4]?.shows || [])]) {
    const id = simklTmdbId(row.show);
    if (!id) continue;
    for (const season of row.seasons || []) {
      const seasonNumber = Number(season.number);
      if (!Number.isFinite(seasonNumber)) continue;
      for (const ep of season.episodes || []) {
        const episode = Number(ep.number);
        if (!Number.isFinite(episode)) continue;
        model.watched.set(watchedKey('series', id, seasonNumber, episode), {
          type: 'series',
          id,
          season: seasonNumber,
          episode,
        });
      }
    }
  }

  return model;
}

// --- Diff ------------------------------------------------------------------

/**
 * Empreinte comparable d'un modele: c'est elle qui est persistee entre deux tours.
 *
 * `additions` / `removals` projettent ce que le cycle vient d'ECRIRE dans la source.
 * Sans cette projection, l'instantane refleterait l'etat d'AVANT nos propres ecritures,
 * et le tour suivant les relirait comme des nouveautes venues de la source -- ce qui
 * relance une propagation inutile et, pire, annule une vraie suppression faite entre
 * temps (notre echo compterait comme un ajout concurrent).
 */
function snapshot(model, additions, removals) {
  const library = new Set(model.library.keys());
  const watched = new Set(model.watched.keys());
  // La position arrondie a la seconde suffit a detecter une lecture; la garder brute
  // ferait diverger l'empreinte a chaque tour pour cause d'arrondi flottant.
  const progress = Object.fromEntries([...model.progress].map(([k, v]) => [k, Math.round(v.position)]));

  if (additions) {
    for (const e of additions.library) library.add(libKey(e.type, e.id));
    for (const e of additions.watched) watched.add(watchedKey(e.type, e.id, e.season, e.episode));
    for (const e of additions.progress) progress[progressKey(e.type, e.id, e.season, e.episode)] = Math.round(e.position);
  }
  if (removals) {
    for (const key of removals.library) library.delete(key);
    for (const key of removals.watched) watched.delete(key);
    for (const key of removals.progress) delete progress[key];
  }

  return { library: [...library], watched: [...watched], progress };
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

/**
 * Ce qui a DISPARU d'une source depuis l'instantane precedent.
 *
 * Sans cette detection, retirer un titre de sa watchlist ne sert a rien: le tour suivant
 * le voit encore chez les deux autres et le reajoute. Une suppression doit donc voyager
 * comme un ajout.
 *
 * Les cles suffisent (le contenu supprime n'existe plus nulle part), d'ou la relecture
 * depuis l'instantane plutot que depuis un modele.
 */
function removalsSince(model, previous) {
  if (!previous) return { library: [], watched: [], progress: [] }; // premier tour: rien n'a disparu

  const gone = (keys, present) => (keys || []).filter((k) => !present.has(k));
  return {
    library: gone(previous.library, model.library),
    watched: gone(previous.watched, model.watched),
    progress: gone(Object.keys(previous.progress || {}), model.progress),
  };
}

/**
 * Coupe-circuit sur les suppressions.
 *
 * Une suppression detectee n'est qu'une absence: elle ne distingue pas "l'utilisateur a
 * retire ce titre" de "la lecture de cette source a echoue ou repondu partiellement".
 * Confondre les deux propagerait un effacement massif chez les deux autres systemes --
 * la seule faute vraiment irrattrapable de tout le hub.
 *
 * Deux garde-fous: une source qui parait entierement vide alors qu'elle ne l'etait pas
 * est tenue pour muette, et un volume anormal de disparitions en un seul cycle est
 * refuse. Dans les deux cas on ne perd rien: un vrai retrait se represente au tour
 * suivant, ou dans un cycle ou il sera minoritaire.
 */
function guardRemovals(source, removals, model, previous) {
  const count = removals.library.length + removals.watched.length + removals.progress.length;
  if (count === 0) return removals;

  const previousSize = (previous?.library?.length || 0) + (previous?.watched?.length || 0);
  const currentSize = model.library.size + model.watched.size;
  if (previousSize > 0 && currentSize === 0) {
    console.warn(`[hub] ${source} parait vide alors qu'il contenait ${previousSize} entree(s): suppressions ignorees`);
    return { library: [], watched: [], progress: [] };
  }

  if (count > config.HUB_MAX_REMOVALS_PER_CYCLE) {
    console.warn(
      `[hub] ${count} disparitions detectees dans ${source} en un cycle (plafond ${config.HUB_MAX_REMOVALS_PER_CYCLE}): ` +
        'suppressions ignorees. Releve HUB_MAX_REMOVALS_PER_CYCLE si le menage est volontaire.',
    );
    return { library: [], watched: [], progress: [] };
  }

  return removals;
}

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

/**
 * Une suppression ne l'emporte que si personne n'a (re)ajoute l'element ailleurs pendant
 * le meme cycle. Sinon on effacerait un ajout tout frais, ce qui est la faute la plus
 * couteuse a rattraper -- alors qu'une suppression ignoree revient au tour suivant.
 */
function withoutContested(removals, additions) {
  const added = new Set([
    ...additions.library.map((e) => libKey(e.type, e.id)),
    ...additions.watched.map((e) => watchedKey(e.type, e.id, e.season, e.episode)),
    ...additions.progress.map((e) => progressKey(e.type, e.id, e.season, e.episode)),
  ]);
  const keep = (keys) => keys.filter((k) => !added.has(k));
  return { library: keep(removals.library), watched: keep(removals.watched), progress: keep(removals.progress) };
}

function mergeRemovals(a, b) {
  return {
    library: [...new Set([...a.library, ...b.library])],
    watched: [...new Set([...a.watched, ...b.watched])],
    progress: [...new Set([...a.progress, ...b.progress])],
  };
}

/** Fusion de deux deltas, dedupliquee par cle canonique. */
function union(a, b) {
  const dedupe = (items, keyOf) => {
    const map = new Map();
    for (const item of [...items]) map.set(keyOf(item), item);
    return [...map.values()];
  };
  return {
    library: dedupe([...a.library, ...b.library], (e) => libKey(e.type, e.id)),
    watched: dedupe([...a.watched, ...b.watched], (e) => watchedKey(e.type, e.id, e.season, e.episode)),
    progress: dedupe([...a.progress, ...b.progress], (e) => progressKey(e.type, e.id, e.season, e.episode)),
  };
}

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

/**
 * Suppressions cote Movix. On reecrit chaque liste amputee de l'element (les cles du
 * localStorage sont des tableaux entiers, il n'y a pas de suppression unitaire), et on
 * utilise l'operation `remove` pour les cles de progression, qui existent une par titre.
 */
async function applyRemovalsToMovix(removals) {
  const raw = await movixSync.fetchSyncData();
  if (!raw) throw new Error('sync Movix indisponible');

  const entries = new Map();
  const removeKeys = [];
  const readKey = (key, fallback) => (entries.has(key) ? entries.get(key) : parseJson(raw[key], fallback));

  const dropFromList = (key, id) => {
    const list = readKey(key, []);
    if (!Array.isArray(list)) return;
    const next = list.filter((e) => Number(typeof e === 'number' ? e : e?.id) !== id);
    if (next.length !== list.length) entries.set(key, next);
  };

  for (const key of removals.library) {
    const { type, id } = parseKey(key);
    // Un titre retire "de la bibliotheque" peut venir de l'une ou l'autre des listes du
    // site: on le retire des deux, sans quoi il reviendrait par celle qu'on aurait omise.
    for (const listKey of type === 'series'
      ? ['watchlist_tv', 'favorites_tv', 'favorite_tv']
      : ['watchlist_movie', 'favorite_movie', 'favorite_movies']) {
      dropFromList(listKey, id);
    }
  }

  for (const key of removals.watched) {
    const { type, id, season, episode } = parseKey(key);
    if (type === 'series' && season) {
      const mapKey = `watched_episodes_tv_${id}`;
      const map = readKey(mapKey, {});
      if (map && typeof map === 'object' && map[`S${season}E${episode}`]) {
        delete map[`S${season}E${episode}`];
        entries.set(mapKey, map);
      }
    } else {
      dropFromList(type === 'series' ? 'watched_tv' : 'watched_movie', id);
    }
  }

  if (removals.progress.length > 0) {
    const continueWatching = readKey('continueWatching', { movies: [], tv: [] });
    let touched = false;

    for (const key of removals.progress) {
      const { type, id, season, episode } = parseKey(key);
      removeKeys.push(type === 'series' ? `progress_tv_${id}_s${season}_e${episode}` : `progress_${id}`);

      const bucket = type === 'series' ? continueWatching.tv : continueWatching.movies;
      if (!Array.isArray(bucket)) continue;
      const next = bucket.filter((e) => Number(typeof e === 'number' ? e : e?.id) !== id);
      if (next.length !== bucket.length) {
        if (type === 'series') continueWatching.tv = next;
        else continueWatching.movies = next;
        touched = true;
      }
    }
    if (touched) entries.set('continueWatching', continueWatching);
  }

  const ops = [
    ...[...entries].map(([key, value]) => ({ key, value })),
    ...removeKeys.map((key) => ({ key, op: 'remove' })),
  ];
  if (ops.length === 0) return { retirees: 0 };
  await movixSync.writeSync(ops);
  return { retirees: ops.length };
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

  return result;
}

// --- Ecriture vers Simkl ---------------------------------------------------

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
    if (!Number.isFinite(percent) || percent <= 0 || percent >= 95) continue;

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

    const [movix, nuvioModel, simklModel] = await Promise.all([readMovix(), readNuvio(profileId), readSimkl()]);
    const previous = loadState();

    const changes = {
      movix: changesSince(movix, previous?.movix),
      nuvio: changesSince(nuvioModel, previous?.nuvio),
      simkl: changesSince(simklModel, previous?.simkl),
    };

    // Chaque cible recoit ce qui a bouge chez les deux autres, moins ce qu'elle a deja.
    const toNuvio = notYetIn(union(changes.movix, changes.simkl), nuvioModel);
    const toMovix = notYetIn(union(changes.nuvio, changes.simkl), movix);
    const toSimkl = notYetIn(union(changes.movix, changes.nuvio), simklModel);

    // Suppressions: memes chemins que les ajouts, mais on ecarte tout element (re)ajoute
    // ailleurs pendant le meme cycle -- effacer un ajout frais est irrattrapable, alors
    // qu'une suppression ignoree se represente au tour suivant.
    const allAdditions = union(union(changes.movix, changes.nuvio), changes.simkl);
    const gone = config.HUB_PROPAGATE_DELETIONS
      ? {
          movix: guardRemovals('Movix', removalsSince(movix, previous?.movix), movix, previous?.movix),
          nuvio: guardRemovals('Nuvio', removalsSince(nuvioModel, previous?.nuvio), nuvioModel, previous?.nuvio),
          simkl: guardRemovals('Simkl', removalsSince(simklModel, previous?.simkl), simklModel, previous?.simkl),
        }
      : { movix: null, nuvio: null, simkl: null };

    const removeFrom = (a, b) =>
      config.HUB_PROPAGATE_DELETIONS
        ? withoutContested(mergeRemovals(a, b), allAdditions)
        : { library: [], watched: [], progress: [] };

    const removeInNuvio = removeFrom(gone.movix, gone.simkl);
    const removeInMovix = removeFrom(gone.nuvio, gone.simkl);
    const removeInSimkl = removeFrom(gone.movix, gone.nuvio);

    const count = (d) => ({ library: d.library.length, watched: d.watched.length, progress: d.progress.length });
    const summary = {
      ok: true,
      dryRun,
      profileId,
      premierTour: !previous,
      movix: { library: movix.library.size, watched: movix.watched.size, progress: movix.progress.size },
      nuvio: { library: nuvioModel.library.size, watched: nuvioModel.watched.size, progress: nuvioModel.progress.size },
      simkl: { library: simklModel.library.size, watched: simklModel.watched.size },
      versNuvio: count(toNuvio),
      versMovix: count(toMovix),
      versSimkl: count(toSimkl),
      retraits: config.HUB_PROPAGATE_DELETIONS
        ? { nuvio: count(removeInNuvio), movix: count(removeInMovix), simkl: count(removeInSimkl) }
        : 'desactive (HUB_PROPAGATE_DELETIONS)',
    };

    if (dryRun) {
      summary.samples = { versNuvio: toNuvio.progress.slice(0, 2), versMovix: toMovix.progress.slice(0, 2) };
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

    if (deltaSize(toNuvio) > 0 || removeInNuvio.library.length > 0) {
      await step('pousseVersNuvio', () => applyToNuvio(profileId, toNuvio, removeInNuvio));
    }
    if (deltaSize(toMovix) > 0) await step('pousseVersMovix', () => applyToMovix(toMovix));
    if (deltaSize(toSimkl) > 0) await step('pousseVersSimkl', () => applyToSimkl(toSimkl));

    if (deltaSize(removeInMovix) > 0) await step('retireDeMovix', () => applyRemovalsToMovix(removeInMovix));
    if (deltaSize(removeInSimkl) > 0) await step('retireDeSimkl', () => applyRemovalsToSimkl(removeInSimkl));

    // Les positions partent vers Simkl a chaque cycle, sans filtrage par delta: il ne les
    // conserve qu'une semaine, donc les repousser est justement ce qui les maintient.
    if (config.SIMKL_SCROBBLE && simkl.isAuthenticated()) {
      const positions = [...movix.progress.values()];
      if (positions.length > 0) await step('scrobbleSimkl', () => scrobbleToSimkl(positions));
    }

    // L'instantane n'est enregistre qu'en cas de succes complet: un echec partiel doit
    // etre rejoue au tour suivant, pas oublie.
    if (summary.ok) {
      saveState({
        movix: snapshot(movix, toMovix, removeInMovix),
        nuvio: snapshot(nuvioModel, toNuvio, removeInNuvio),
        simkl: snapshot(simklModel, toSimkl, removeInSimkl),
      });
    }

    lastRun = { at: new Date().toISOString(), summary };
    if (deltaSize(toNuvio) + deltaSize(toMovix) + deltaSize(toSimkl) > 0 || !summary.ok) {
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
