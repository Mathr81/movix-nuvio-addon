const movixSync = require('../../integrations/movixSync');
const { emptyModel, libKey, watchedKey, progressKey } = require('../model');

/** Lecture du compte Movix vers le modele canonique (positions en secondes). */
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

module.exports = { readMovix };
