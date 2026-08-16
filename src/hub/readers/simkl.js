const simkl = require('../../integrations/simklCloud');
const { emptyModel, libKey, watchedKey } = require('../model');

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

module.exports = { readSimkl };
