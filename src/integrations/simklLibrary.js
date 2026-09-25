const fs = require('fs');
const path = require('path');
const config = require('../core/config');
const paths = require('../core/paths');
const simkl = require('./simklCloud');
const { emptyModel, libKey, watchedKey } = require('../hub/model');

/**
 * Copie locale de la bibliotheque Simkl, tenue a jour selon le modele en deux phases de
 * la documentation (guides/sync):
 *
 *   1. premiere lecture: `/sync/all-items/<type>` complet, un type apres l'autre;
 *   2. ensuite: `/sync/activities` d'abord (quelques octets). Rien n'a bouge -> on s'arrete.
 *      Un type a bouge -> `/sync/all-items/<type>?date_from=<horodatage sauvegarde>`, qui ne
 *      rend que les titres modifies. `removed_from_list` a bouge -> liste des seuls ids
 *      Simkl (`extended=simkl_ids_only`), pour retrouver les titres retires, que
 *      `date_from` ne signale jamais.
 *
 * La version precedente relisait cinq listes completes a chaque cycle du hub (toutes les
 * 20 s), ce que la doc designe comme le motif qui fait suspendre un `client_id`.
 *
 * Trois details de l'API guident la lecture:
 *   - les episodes n'arrivent qu'avec `extended=full`, et pour les titres termines
 *     seulement avec `include_all_episodes=yes`: sans lui, une serie finie semblait n'avoir
 *     aucun episode vu, et le hub les renvoyait sans fin;
 *   - l'anime a son propre compartiment (`anime`), que rien ne lisait: tout titre classe
 *     anime par Simkl etait invisible;
 *   - les ids externes sont des CHAINES, et un id TMDB n'a de sens qu'avec son type: c'est
 *     le compartiment (movies / shows / anime + `anime_type`) qui le donne.
 *
 * Les ecritures du hub sont reportees ici des qu'elles reussissent (`pending`): entre deux
 * lectures reelles, le hub voit donc Simkl tel qu'il sera, et ne renvoie rien deux fois.
 */
const STORE_FILE = paths.inData('simkl-library.json');
const LIBRARY_STATUSES = new Set(['plantowatch', 'watching', 'hold']);
// Delai au-dela duquel une ecriture acceptee mais toujours absente de la lecture est
// tenue pour classee ailleurs par Simkl (autre id, autre type): on cesse de l'attendre.
const PENDING_GRACE_MS = 60 * 60 * 1000;

const TYPES = [
  { type: 'movies', bucket: 'movies', params: { extended: 'full' } },
  { type: 'shows', bucket: 'tv_shows', params: { extended: 'full', include_all_episodes: 'yes' } },
  // `full_anime_seasons` ajoute a chaque episode sa position TVDB (`tvdb: {season, episode}`),
  // celle qu'utilisent TMDB et le reste du hub, au lieu de la numerotation par cour d'AniDB.
  { type: 'anime', bucket: 'anime', params: { extended: 'full_anime_seasons', include_all_episodes: 'yes' } },
];

let store = null;

function blankStore() {
  return { version: 2, activities: null, checkedAt: 0, items: {}, pending: {}, unmatched: {}, playback: {}, scrobbled: {} };
}

function load() {
  if (store) return store;
  try {
    const saved = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    // Format anterieur: on repart d'une lecture complete plutot que de le traduire.
    store = saved.version === blankStore().version ? { ...blankStore(), ...saved } : blankStore();
  } catch {
    store = blankStore();
  }
  return store;
}

function save() {
  fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
  fs.writeFileSync(STORE_FILE, JSON.stringify(store));
}

function reset() {
  store = blankStore();
  try {
    fs.unlinkSync(STORE_FILE);
  } catch {
    // deja absent
  }
}

const tmdbOf = (ids) => {
  const id = Number(ids?.tmdb);
  return Number.isFinite(id) && id > 0 ? id : null;
};

/** Une entree de `/sync/all-items` -> element du cache. */
function toItem(bucketType, row) {
  const media = row.movie || row.show;
  const simklId = Number(media?.ids?.simkl);
  if (!Number.isFinite(simklId)) return null;

  const animeType = row.anime_type || media?.anime_type || null;
  const kind = bucketType === 'movies' || (bucketType === 'anime' && animeType === 'movie') ? 'movie' : 'series';

  const episodes = [];
  if (kind === 'series') {
    for (const season of row.seasons || []) {
      for (const ep of season.episodes || []) {
        // Anime: la position TVDB quand Simkl la fournit, sinon sa propre numerotation.
        const s = Number(ep.tvdb?.season ?? season.number);
        const e = Number(ep.tvdb?.episode ?? ep.number);
        if (Number.isFinite(s) && Number.isFinite(e)) episodes.push(`${s}:${e}`);
      }
    }
  }

  return {
    simkl: simklId,
    kind,
    tmdb: tmdbOf(media.ids),
    title: media.title || null,
    year: media.year || null,
    status: row.status || null,
    addedAt: row.added_to_watchlist_at || null,
    lastWatchedAt: row.last_watched_at || null,
    episodes,
  };
}

function ingest(bucketType, data) {
  let count = 0;
  for (const row of data?.[bucketType] || []) {
    const item = toItem(bucketType, row);
    if (!item) continue;
    store.items[item.simkl] = item;
    count += 1;
  }
  return count;
}

/** Ids Simkl encore presents cote serveur, tous types confondus. */
function idsIn(data) {
  const ids = new Set();
  for (const bucket of ['movies', 'shows', 'anime']) {
    for (const row of data?.[bucket] || []) {
      const id = Number((row.movie || row.show)?.ids?.simkl);
      if (Number.isFinite(id)) ids.add(id);
    }
  }
  return ids;
}

const stamp = (activities, bucket, field = 'all') => activities?.[bucket]?.[field] || null;

async function refreshPlayback() {
  const rows = await simkl.playback();
  const byKey = {};
  const bySimkl = new Map(Object.values(store.items).map((i) => [i.simkl, i]));
  for (const row of Array.isArray(rows) ? rows : []) {
    const media = row.movie || row.show;
    const tmdb = tmdbOf(media?.ids) || bySimkl.get(Number(media?.ids?.simkl))?.tmdb;
    if (!tmdb) continue;
    const key = row.movie
      ? watchedKey('movie', tmdb)
      : watchedKey('series', tmdb, Number(row.episode?.tvdb_season ?? row.episode?.season), Number(row.episode?.tvdb_number ?? row.episode?.number));
    byKey[key] = { progress: Number(row.progress) || 0, pausedAt: row.paused_at || row.watched_at || null };
  }
  store.playback = byKey;
}

/**
 * Met le cache a jour, au plus une fois par SIMKL_POLL_INTERVAL_MS. Rend `false` si Simkl
 * n'a pas pu etre lu (non autorise, en pause, erreur): le hub l'ignore alors ce tour-ci.
 */
async function sync({ force = false } = {}) {
  load();
  if (!simkl.available()) return false;
  if (!force && store.activities && Date.now() - store.checkedAt < config.SIMKL_POLL_INTERVAL_MS) return true;

  try {
    const activities = await simkl.activities();
    const previous = store.activities;
    let changed = false;

    for (const { type, bucket, params } of TYPES) {
      const now = stamp(activities, bucket);
      const before = stamp(previous, bucket);
      if (previous && now && now === before) continue;
      // Pas encore de reference pour ce type: lecture complete. Sinon, le seul delta.
      const data = await simkl.allItems({ type, ...params, ...(previous && before ? { date_from: before } : {}) });
      const n = ingest(type, data);
      if (previous) console.log(`[simkl] ${type}: ${n} titre(s) modifie(s) depuis ${before}`);
      changed = true;
    }

    const removedMoved = ['movies', 'tv_shows', 'anime'].some(
      (b) => previous && stamp(activities, b, 'removed_from_list') !== stamp(previous, b, 'removed_from_list'),
    );
    if (removedMoved) {
      const present = idsIn(await simkl.allItems({ extended: 'simkl_ids_only' }));
      const cached = Object.keys(store.items);
      // Une reponse vide face a un cache plein ressemble davantage a une panne qu'a une
      // bibliotheque videe d'un coup: dans le doute, on ne retire rien.
      if (present.size > 0 || cached.length === 0) {
        const gone = cached.filter((id) => !present.has(Number(id)));
        for (const id of gone) delete store.items[id];
        if (gone.length) console.log(`[simkl] ${gone.length} titre(s) retire(s) cote Simkl`);
      }
      changed = true;
    }

    const playbackMoved = ['movies', 'tv_shows', 'anime'].some(
      (b) => !previous || stamp(activities, b, 'playback') !== stamp(previous, b, 'playback'),
    );
    if (playbackMoved) await refreshPlayback();

    store.activities = activities;
    store.checkedAt = Date.now();
    if (changed) settlePending();
    save();
    return true;
  } catch (err) {
    console.warn(`[simkl] lecture impossible: ${err.message}`);
    return false;
  }
}

// --- Modeles pour le hub --------------------------------------------------------------

function confirmedModel() {
  const model = emptyModel();
  for (const item of Object.values(load().items)) {
    if (!item.tmdb) continue;
    if (LIBRARY_STATUSES.has(item.status)) {
      model.library.set(libKey(item.kind, item.tmdb), { type: item.kind, id: item.tmdb, kind: 'watchlist', addedAt: item.addedAt });
    }
    if (item.kind === 'movie') {
      if (item.status === 'completed') {
        model.watched.set(watchedKey('movie', item.tmdb), { type: 'movie', id: item.tmdb, watchedAt: item.lastWatchedAt });
      }
      continue;
    }
    for (const ep of item.episodes) {
      const [season, episode] = ep.split(':').map(Number);
      model.watched.set(watchedKey('series', item.tmdb, season, episode), { type: 'series', id: item.tmdb, season, episode });
    }
  }
  return model;
}

/**
 * Ce que Simkl possede OU possedera: le confirme, plus toute presence dans une liste
 * quelle qu'elle soit (un titre termine n'est plus "a voir", mais le remettre en
 * `plantowatch` le retrograderait), plus les ecritures en attente et les titres que
 * Simkl n'a pas su identifier (inutile de les renvoyer).
 */
function knownModel(confirmed) {
  const model = { library: new Map(confirmed.library), watched: new Map(confirmed.watched), progress: new Map() };
  for (const item of Object.values(store.items)) {
    if (item.tmdb && item.status !== 'dropped') model.library.set(libKey(item.kind, item.tmdb), true);
  }
  for (const map of [store.pending, store.unmatched]) {
    for (const entry of Object.values(map)) model[entry.kind].set(entry.key, true);
  }
  return model;
}

/** Instantane lu par le hub, ou `null` quand Simkl n'est pas lisible ce tour-ci. */
async function read() {
  if (!(await sync())) return null;
  const confirmed = confirmedModel();
  return { confirmed, known: knownModel(confirmed) };
}

// --- Report des ecritures -------------------------------------------------------------

// Indexe par categorie ET cle: pour un film, `movie:<id>` designe aussi bien sa place en
// liste que son visionnage, et l'un ne doit pas effacer l'autre.
const slot = (kind, key) => `${kind}|${key}`;

function markPending(kind, keys) {
  load();
  const at = Date.now();
  for (const key of keys) store.pending[slot(kind, key)] = { kind, key, at };
  save();
}

function markUnmatched(kind, keys) {
  load();
  const at = Date.now();
  for (const key of keys) {
    store.unmatched[slot(kind, key)] = { kind, key, at };
    delete store.pending[slot(kind, key)];
  }
  save();
}

/** Apres une vraie lecture: ce qui est apparu n'est plus en attente; ce qui tarde trop non plus. */
function settlePending() {
  const confirmed = confirmedModel();
  const listed = new Set(
    Object.values(store.items)
      .filter((i) => i.tmdb && i.status !== 'dropped')
      .map((i) => libKey(i.kind, i.tmdb)),
  );
  for (const [id, entry] of Object.entries(store.pending)) {
    const seen = entry.kind === 'library' ? listed.has(entry.key) : confirmed.watched.has(entry.key);
    if (seen) delete store.pending[id];
    else if (Date.now() - entry.at > PENDING_GRACE_MS) {
      store.unmatched[id] = { ...entry, at: Date.now() };
      delete store.pending[id];
    }
  }
}

function findItem(type, tmdb) {
  return Object.values(load().items).find((i) => i.kind === type && i.tmdb === tmdb) || null;
}

/** Retraits reussis: reportes tout de suite, sans attendre la prochaine lecture. */
function applyRemoved({ library = [], watched = [] }) {
  load();
  for (const [kind, keys] of [['library', library], ['watched', watched]]) {
    for (const key of keys) {
      delete store.pending[slot(kind, key)];
      delete store.unmatched[slot(kind, key)];
    }
  }
  for (const key of library) {
    const [type, id] = key.split(':');
    const item = findItem(type === 'series' ? 'series' : 'movie', Number(id));
    if (item) delete store.items[item.simkl];
  }
  for (const key of watched) {
    const [type, id, season, episode] = key.split(':');
    if (type === 'movie') {
      // Retirer un film de l'historique le retire de la bibliotheque entiere cote Simkl.
      const item = findItem('movie', Number(id));
      if (item) delete store.items[item.simkl];
    } else {
      const item = findItem('series', Number(id));
      if (item) item.episodes = item.episodes.filter((ep) => ep !== `${season}:${episode}`);
    }
  }
  save();
}

function playbackOf(key) {
  return load().playback[key] || null;
}

function lastScrobble(key) {
  return load().scrobbled[key] || null;
}

function noteScrobble(key, progress) {
  load();
  store.scrobbled[key] = { progress, at: Date.now() };
  store.playback[key] = { progress, pausedAt: new Date().toISOString() };
  save();
}

module.exports = {
  sync,
  read,
  findItem,
  markPending,
  markUnmatched,
  applyRemoved,
  playbackOf,
  lastScrobble,
  noteScrobble,
  reset,
  STORE_FILE,
};
