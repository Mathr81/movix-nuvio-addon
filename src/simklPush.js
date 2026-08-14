const config = require('./config');
const cache = require('./cache');
const movixSync = require('./movixSync');
const simkl = require('./simklCloud');
const tmdbClient = require('./tmdb');

/**
 * Import de la bibliotheque et de l'historique Movix vers Simkl.
 *
 * Simkl est le tracker que Nuvio integre nativement sans la limite d'une seule app
 * connectee imposee par Trakt gratuit. Une fois l'import fait, Nuvio scrobble tout seul
 * vers Simkl: l'historique reste a jour sans relancer quoi que ce soit.
 *
 * Limite connue: l'API Simkl n'expose aucun endpoint de position de lecture. Les points
 * de reprise a la seconde pres passent donc par le push Nuvio Sync (voir nuvioPush.js),
 * pas par ici.
 */

/** Titre + annee: Simkl s'en sert comme filet quand l'id externe ne matche pas. */
async function describe(type, tmdbId) {
  try {
    const details = await cache.wrap(`meta:${type}:${tmdbId}`, config.CACHE_TTL_MS, config.CACHE_EMPTY_TTL_MS, () =>
      tmdbClient.details(type, tmdbId),
    );
    const date = details.release_date || details.first_air_date || '';
    return { title: details.title || details.name, year: Number(date.slice(0, 4)) || undefined };
  } catch {
    return {};
  }
}

/**
 * Simkl est historiquement indexe par TVDb/IMDb cote series: pour elles on resout aussi
 * l'id IMDb, universel, sinon une partie des titres reste introuvable.
 */
async function externalIds(type, tmdbId) {
  const ids = { tmdb: Number(tmdbId) };
  if (type !== 'series') return ids;

  const key = `imdb:series:${tmdbId}`;
  let imdb = cache.get(key);
  if (imdb === undefined) {
    try {
      imdb = await tmdbClient.getImdbId('series', tmdbId);
    } catch {
      imdb = null;
    }
    cache.set(key, imdb, 24 * 60 * 60 * 1000);
  }
  if (imdb) ids.imdb = imdb;
  return ids;
}

async function entry(type, tmdbId, extra = {}) {
  const [ids, described] = await Promise.all([externalIds(type, tmdbId), describe(type, tmdbId)]);
  return { ...described, ids, ...extra };
}

async function settleAll(promises, label) {
  const settled = await Promise.allSettled(promises);
  const failures = settled.filter((r) => r.status === 'rejected');
  if (failures.length > 0) {
    console.warn(`[simkl-push] ${failures.length} entree(s) ignoree(s) dans ${label}: ${failures[0].reason?.message}`);
  }
  return settled.filter((r) => r.status === 'fulfilled').map((r) => r.value);
}

async function buildHistory() {
  const [movies, episodes] = await Promise.all([movixSync.getWatched('movie'), movixSync.getWatchedEpisodes()]);

  // Regroupement serie > saison > episodes, structure attendue par /sync/history.
  const shows = new Map();
  for (const ep of episodes) {
    if (!shows.has(ep.showId)) shows.set(ep.showId, new Map());
    const seasons = shows.get(ep.showId);
    if (!seasons.has(ep.season)) seasons.set(ep.season, []);
    seasons.get(ep.season).push({ number: ep.episode });
  }

  const [movieEntries, showEntries] = await Promise.all([
    settleAll(
      movies.map((item) => {
        const watchedAt = Date.parse(item.watchedAt || item.addedAt || '');
        return entry('movie', item.id, Number.isFinite(watchedAt) ? { watched_at: new Date(watchedAt).toISOString() } : {});
      }),
      'l\'historique films',
    ),
    settleAll(
      [...shows.entries()].map(([showId, seasons]) =>
        entry('series', showId, {
          seasons: [...seasons.entries()].map(([number, eps]) => ({ number, episodes: eps })),
        }),
      ),
      'l\'historique series',
    ),
  ]);

  return { movies: movieEntries, shows: showEntries };
}

/**
 * Repartition dans les statuts Simkl. Contrairement a Nuvio, qui n'a qu'une
 * bibliotheque plate, Simkl distingue plantowatch / watching / completed -- autant s'en
 * servir, c'est une information que Movix possede et que le reste perdait.
 *
 * Un titre n'ayant qu'un seul statut, l'ordre de priorite est: en cours de lecture
 * l'emporte sur "a voir". Les titres termines passent par /sync/history, qui les met en
 * "completed" tout seul.
 */
async function buildList() {
  const groups = await Promise.all([
    movixSync.getCollection('watchlist', 'movie'),
    movixSync.getCollection('watchlist', 'series'),
    movixSync.getCollection('favorites', 'movie'),
    movixSync.getCollection('favorites', 'series'),
    movixSync.getAllProgress(),
  ]);

  const inProgress = new Set(
    groups[4]
      // Au-dela de 95 % le titre est fini: il releve de l'historique, pas de "en cours".
      .filter((p) => p.duration > 0 && (p.position / p.duration) * 100 < 95)
      .map((p) => `${p.type}:${p.id}`),
  );

  const wanted = new Map();
  [
    ['movie', groups[0]],
    ['series', groups[1]],
    ['movie', groups[2]],
    ['series', groups[3]],
  ].forEach(([type, items]) => {
    for (const item of items) {
      const key = `${type}:${item.id}`;
      if (!wanted.has(key)) wanted.set(key, { type, id: item.id });
    }
  });
  // Un titre en cours de lecture merite sa place dans la liste meme s'il n'a jamais ete
  // ajoute a la watchlist du site.
  for (const key of inProgress) {
    if (!wanted.has(key)) {
      const [type, id] = key.split(':');
      wanted.set(key, { type, id: Number(id) });
    }
  }

  const entries = await settleAll(
    [...wanted.values()].map((e) =>
      entry(e.type, e.id, { to: inProgress.has(`${e.type}:${e.id}`) ? 'watching' : 'plantowatch' }).then((v) => ({
        ...v,
        __type: e.type,
      })),
    ),
    'la liste',
  );

  return {
    movies: entries.filter((e) => e.__type === 'movie').map(({ __type, ...rest }) => rest),
    shows: entries.filter((e) => e.__type === 'series').map(({ __type, ...rest }) => rest),
  };
}

async function pushToSimkl({ dryRun = false } = {}) {
  if (!simkl.isAuthenticated()) {
    return { ok: false, error: 'Simkl non autorise -- lance `npm run simkl:auth` une fois' };
  }

  const [history, list] = await Promise.all([buildHistory(), buildList()]);

  const summary = {
    ok: true,
    dryRun,
    history: {
      movies: history.movies.length,
      shows: history.shows.length,
      episodes: history.shows.reduce((n, s) => n + s.seasons.reduce((m, se) => m + se.episodes.length, 0), 0),
    },
    liste: { movies: list.movies.length, shows: list.shows.length },
  };

  if (dryRun) {
    summary.samples = { history: history.movies.slice(0, 1).concat(history.shows.slice(0, 1)), liste: list.movies.slice(0, 1) };
    console.log('[simkl-push] simulation (dryRun), aucun envoi');
    return summary;
  }

  summary.pushed = {};
  summary.errors = {};

  const run = async (name, fn) => {
    try {
      summary.pushed[name] = await fn();
    } catch (err) {
      summary.ok = false;
      summary.errors[name] = err.message;
      console.error(`[simkl-push] ${name}: ${err.message}`);
    }
  };

  if (summary.history.movies + summary.history.episodes > 0) {
    await run('history', () => simkl.addToHistory(history));
  }
  if (list.movies.length + list.shows.length > 0) {
    await run('liste', () => simkl.addToList(list));
  }

  console.log('[simkl-push] termine:', JSON.stringify(summary));
  return summary;
}

module.exports = { pushToSimkl };
