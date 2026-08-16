const movixSync = require('../../integrations/movixSync');
const { parseKey, describe } = require('../model');

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

module.exports = { applyToMovix, applyRemovalsToMovix };
