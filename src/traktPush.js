const config = require('./config');
const movixSync = require('./movixSync');
const trakt = require('./traktCloud');

const FAVORITES_LIST_NAME = 'Movix · Favoris';

/**
 * Import de l'historique Movix vers Trakt.
 *
 * Pourquoi Trakt plutot que (ou en plus de) le sync Nuvio: Nuvio scrobble nativement
 * vers Trakt, et les addons de recommandation de l'ecosysteme lisent Trakt. Une fois
 * l'historique importe ici, il devient exploitable par tout le monde -- et le sens
 * Nuvio -> Movix, impossible via le protocole d'addon, se fait naturellement puisque
 * Nuvio ecrit dans Trakt en continu.
 *
 * Trakt indexe par ids externes: on envoie directement l'id TMDB, sans conversion.
 */
function movieRef(id, watchedAt) {
  const ref = { ids: { tmdb: Number(id) } };
  if (watchedAt) ref.watched_at = watchedAt;
  return ref;
}

/**
 * Date de visionnage. Movix ne l'enregistre pas pour la plupart des entrees; plutot que
 * de tout dater d'aujourd'hui (ce qui remplirait "vu recemment" de 50 titres d'un coup),
 * on demande a Trakt d'utiliser la date de sortie via la valeur speciale "released".
 */
function watchedAtValue(raw) {
  if (raw) {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return config.TRAKT_WATCHED_AT === 'now' ? new Date().toISOString() : 'released';
}

function stripWatchedAt(payload) {
  return {
    movies: (payload.movies || []).map(({ ids }) => ({ ids })),
    shows: (payload.shows || []).map((show) => ({
      ids: show.ids,
      seasons: (show.seasons || []).map((s) => ({
        number: s.number,
        episodes: (s.episodes || []).map(({ number }) => ({ number })),
      })),
    })),
  };
}

async function buildHistory() {
  const [movies, series, episodes] = await Promise.all([
    movixSync.getWatched('movie'),
    movixSync.getWatched('series'),
    movixSync.getWatchedEpisodes(),
  ]);

  // Les episodes vus sont regroupes par serie puis par saison: c'est la structure
  // imbriquee qu'attend /sync/history (shows > seasons > episodes).
  const shows = new Map();
  for (const ep of episodes) {
    if (!shows.has(ep.showId)) shows.set(ep.showId, new Map());
    const seasons = shows.get(ep.showId);
    if (!seasons.has(ep.season)) seasons.set(ep.season, []);
    seasons.get(ep.season).push({ number: ep.episode, watched_at: watchedAtValue(null) });
  }

  // Une serie marquee "vue" sans detail d'episodes n'est pas envoyee: Trakt refuse un
  // show sans saisons dans /sync/history, et marquer toute la serie serait faux.
  const seriesWithoutEpisodes = series.filter((item) => !shows.has(Number(item.id))).length;

  return {
    payload: {
      movies: movies.map((item) => movieRef(item.id, watchedAtValue(item.watchedAt || item.addedAt))),
      shows: [...shows.entries()].map(([showId, seasons]) => ({
        ids: { tmdb: Number(showId) },
        seasons: [...seasons.entries()].map(([number, eps]) => ({ number, episodes: eps })),
      })),
    },
    seriesWithoutEpisodes,
  };
}

async function buildWatchlist() {
  const [movies, series] = await Promise.all([
    movixSync.getCollection('watchlist', 'movie'),
    movixSync.getCollection('watchlist', 'series'),
  ]);
  return {
    movies: movies.map((item) => ({ ids: { tmdb: Number(item.id) } })),
    shows: series.map((item) => ({ ids: { tmdb: Number(item.id) } })),
  };
}

async function buildFavorites() {
  const [movies, series] = await Promise.all([
    movixSync.getCollection('favorites', 'movie'),
    movixSync.getCollection('favorites', 'series'),
  ]);
  return {
    movies: movies.map((item) => ({ ids: { tmdb: Number(item.id) } })),
    shows: series.map((item) => ({ ids: { tmdb: Number(item.id) } })),
  };
}

/** Trakt n'expose pas d'import de progression: chaque position se pousse via un scrobble. */
async function buildPlayback() {
  const entries = await movixSync.getAllProgress();

  return entries
    .map((e) => {
      const percent = (e.position / e.duration) * 100;
      if (!Number.isFinite(percent) || percent <= 0) return null;
      // Au-dela de 95 % le titre est termine: le laisser dans "en cours" plutot qu'en
      // historique n'aurait pas de sens, et Trakt le nettoierait de toute facon.
      if (percent >= 95) return null;

      return e.type === 'series'
        ? { show: { ids: { tmdb: e.id } }, episode: { season: e.season, number: e.episode }, progress: Number(percent.toFixed(2)) }
        : { movie: { ids: { tmdb: e.id } }, progress: Number(percent.toFixed(2)) };
    })
    .filter(Boolean);
}

/** Retrouve (ou cree) la liste privee ou sont copies les favoris Movix. */
async function ensureFavoritesList() {
  const lists = await trakt.listUserLists();
  const existing = (Array.isArray(lists) ? lists : []).find((l) => l.name === FAVORITES_LIST_NAME);
  if (existing) return existing.ids.trakt;

  const created = await trakt.createList(FAVORITES_LIST_NAME);
  console.log(`[trakt-push] liste "${FAVORITES_LIST_NAME}" creee`);
  return created.ids.trakt;
}

function countOf(result, field = 'added') {
  const bucket = result?.[field] || {};
  return Object.values(bucket).reduce((sum, n) => sum + (Number(n) || 0), 0);
}

async function pushToTrakt({ dryRun = false } = {}) {
  if (!trakt.isAuthenticated()) {
    return { ok: false, error: 'Trakt non autorise -- lance `npm run trakt:auth` une fois' };
  }

  const [history, watchlist, favorites, playback] = await Promise.all([
    buildHistory(),
    buildWatchlist(),
    buildFavorites(),
    buildPlayback(),
  ]);

  const summary = {
    ok: true,
    dryRun,
    history: {
      movies: history.payload.movies.length,
      shows: history.payload.shows.length,
      episodes: history.payload.shows.reduce((n, s) => n + s.seasons.reduce((m, se) => m + se.episodes.length, 0), 0),
      seriesIgnoreesSansEpisodes: history.seriesWithoutEpisodes,
    },
    watchlist: { movies: watchlist.movies.length, shows: watchlist.shows.length },
    favoris: { movies: favorites.movies.length, shows: favorites.shows.length },
    reprises: playback.length,
  };

  if (dryRun) {
    summary.samples = {
      history: { movies: history.payload.movies.slice(0, 1), shows: history.payload.shows.slice(0, 1) },
      watchlist: watchlist.movies.slice(0, 1),
      playback: playback.slice(0, 1),
    };
    console.log('[trakt-push] simulation (dryRun), aucun envoi');
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
      console.error(`[trakt-push] ${name}: ${err.message}`);
    }
  };

  if (summary.history.movies + summary.history.episodes > 0) {
    await run('history', async () => {
      try {
        const res = await trakt.addToHistory(history.payload);
        return { ajoutes: countOf(res), introuvables: countOf(res, 'not_found') };
      } catch (err) {
        // La valeur "released" de watched_at n'est pas acceptee pour tous les titres
        // (date de sortie inconnue cote Trakt). On rejoue alors sans date: Trakt utilise
        // l'heure courante, ce qui vaut mieux que de perdre tout l'historique.
        if (config.TRAKT_WATCHED_AT !== 'now' && err.status >= 400) {
          console.warn('[trakt-push] history refuse avec watched_at="released", nouvel essai sans date');
          const res = await trakt.addToHistory(stripWatchedAt(history.payload));
          return { ajoutes: countOf(res), introuvables: countOf(res, 'not_found'), sansDate: true };
        }
        throw err;
      }
    });
  }

  if (watchlist.movies.length + watchlist.shows.length > 0) {
    await run('watchlist', async () => {
      const res = await trakt.addToWatchlist(watchlist);
      return { ajoutes: countOf(res), deja: countOf(res, 'existing'), introuvables: countOf(res, 'not_found') };
    });
  }

  if (favorites.movies.length + favorites.shows.length > 0) {
    await run('favoris', async () => {
      const listId = await ensureFavoritesList();
      const res = await trakt.addToList(listId, favorites);
      return { ajoutes: countOf(res), deja: countOf(res, 'existing') };
    });
  }

  if (playback.length > 0) {
    await run('reprises', async () => {
      let ok = 0;
      let ignores = 0;
      for (const entry of playback) {
        try {
          const res = await trakt.scrobblePause(entry);
          if (res) ok += 1;
          else ignores += 1; // 409: session deja en cours cote Trakt
        } catch (err) {
          ignores += 1;
          console.warn(`[trakt-push] reprise ignoree: ${err.message}`);
        }
      }
      return { enregistrees: ok, ignorees: ignores };
    });
  }

  console.log('[trakt-push] termine:', JSON.stringify(summary));
  return summary;
}

module.exports = { pushToTrakt };
