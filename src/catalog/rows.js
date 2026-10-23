/**
 * Rangees integrees, dans l'ordre d'affichage -- l'accueil "facon Netflix".
 *
 * Trois sortes de rangees:
 *  - `source: 'watchlist' | 'favorites' | 'trakt'`: listes personnelles, servies telles
 *    quelles (cf. addon.js);
 *  - `source: 'reco' | 'trending'`: listes calculees, passees par le moteur (feed.js);
 *  - `discover: { movie, series }`: un jeu de parametres TMDB Discover par type. Un type
 *    absent = la rangee n'existe pas pour lui. Les dates relatives (`today`, `today-120`,
 *    `today+1`, en jours) sont resolues a chaque appel.
 *
 * L'ORDRE COMPTE DOUBLEMENT: c'est celui de l'accueil, et c'est aussi la priorite du
 * dedoublonnage -- un titre appartient a la premiere rangee qui le montre, les suivantes
 * piochent plus loin dans leur propre liste. D'ou l'alternance entre rangees "larges"
 * (plateformes, tendances) et rangees thematiques: les secondes ne se retrouvent pas
 * reduites aux restes des premieres.
 *
 * `rotate: false` fige l'ordre de la source (tendances, nouveautes: la fraicheur EST le
 * classement). Les autres rangees tirent chaque jour un melange different de leurs
 * meilleurs titres, pondere par les gouts du profil.
 */

/** Discover trie par popularite, avec un plancher de votes contre les titres confidentiels. */
const pop = (votes, params = {}) => ({ sort_by: 'popularity.desc', 'vote_count.gte': votes, ...params });

/** Rangee "Sur <plateforme>": catalogue de la plateforme en France. */
const provider = (id) => ({
  movie: pop(50, { with_watch_providers: id, watch_region: 'FR' }),
  series: pop(20, { with_watch_providers: id, watch_region: 'FR' }),
});

const ROWS = [
  { id: 'watchlist', name: 'Ma liste', source: 'watchlist', requires: 'personal' },
  { id: 'reco', name: 'Recommandé pour toi', source: 'reco', requires: 'reco', rotate: false },
  { id: 'trakt-reco', name: 'Recommandé par Trakt', source: 'trakt', requires: 'trakt' },
  { id: 'trending', name: 'Tendances de la semaine', source: 'trending', rotate: false },
  {
    id: 'new',
    name: { movie: 'Nouveautés', series: 'Nouvelles séries' },
    rotate: false,
    discover: {
      // Sortie numerique/physique/TV en France: ce qui est visible chez soi, pas en salle.
      // `primary_release_date` en plus: sans lui, une ressortie numerique (Le Parrain...)
      // passait pour une nouveaute.
      movie: pop(20, {
        'primary_release_date.gte': 'today-365',
        'release_date.gte': 'today-120',
        'release_date.lte': 'today',
        with_release_type: '4|5|6',
        region: 'FR',
      }),
      series: pop(10, { 'first_air_date.gte': 'today-150', 'first_air_date.lte': 'today' }),
    },
  },
  {
    id: 'airing',
    name: 'Nouveaux épisodes cette semaine',
    rotate: false,
    discover: { series: pop(50, { 'air_date.gte': 'today-7', 'air_date.lte': 'today+1' }) },
  },
  { id: 'netflix', name: 'Sur Netflix', discover: provider(8) },
  {
    id: 'france',
    name: { movie: 'Cinéma français', series: 'Séries françaises' },
    discover: { movie: pop(100, { with_original_language: 'fr' }), series: pop(20, { with_original_language: 'fr' }) },
  },
  {
    id: 'thriller',
    name: { movie: 'Thrillers haletants', series: 'Mystères & suspense' },
    discover: {
      movie: pop(300, { with_genres: 53, 'vote_average.gte': 6.3 }),
      series: pop(100, { with_genres: 9648, 'vote_average.gte': 7 }),
    },
  },
  { id: 'prime', name: 'Sur Prime Video', discover: provider(119) },
  {
    id: 'comedy',
    name: 'Comédies',
    discover: {
      movie: pop(300, { with_genres: 35, 'vote_average.gte': 6.2 }),
      series: pop(100, { with_genres: 35, 'vote_average.gte': 6.8 }),
    },
  },
  {
    id: 'anime',
    name: { movie: "Films d'animation", series: 'Animes' },
    discover: {
      movie: pop(300, { with_genres: 16, 'vote_average.gte': 6.8 }),
      series: pop(100, { with_genres: 16, with_original_language: 'ja' }),
    },
  },
  { id: 'disney', name: 'Sur Disney+', discover: provider(337) },
  {
    id: 'action',
    name: { movie: 'Action à couper le souffle', series: 'Action & aventure' },
    discover: {
      movie: pop(500, { with_genres: 28, 'vote_average.gte': 6.2 }),
      series: pop(150, { with_genres: 10759, 'vote_average.gte': 7 }),
    },
  },
  {
    id: 'korea',
    name: { movie: 'Cinéma coréen', series: 'K-dramas' },
    discover: {
      movie: pop(150, { with_original_language: 'ko' }),
      series: pop(50, { with_original_language: 'ko', with_genres: 18 }),
    },
  },
  {
    id: 'scifi',
    name: { movie: 'Science-fiction', series: 'Science-fiction & fantastique' },
    discover: {
      movie: pop(500, { with_genres: 878, 'vote_average.gte': 6.3 }),
      series: pop(150, { with_genres: 10765, 'vote_average.gte': 7 }),
    },
  },
  { id: 'apple', name: 'Sur Apple TV+', discover: provider(350) },
  {
    id: 'crime',
    name: { movie: 'Polars & gangsters', series: 'Séries policières' },
    discover: {
      movie: pop(400, { with_genres: 80, 'vote_average.gte': 6.5 }),
      series: pop(150, { with_genres: 80, 'vote_average.gte': 7.2 }),
    },
  },
  { id: 'horror', name: 'Frissons garantis', discover: { movie: pop(300, { with_genres: 27, 'vote_average.gte': 6 }) } },
  {
    id: 'gems',
    name: 'Pépites méconnues',
    poolPages: 5,
    discover: {
      // Concerts, documentaires et telefilms ecartes: notes tres haut par une poignee de
      // fans, ils trustaient la rangee sans etre des "films".
      movie: {
        sort_by: 'vote_average.desc',
        'vote_average.gte': 7.3,
        'vote_count.gte': 300,
        'vote_count.lte': 2500,
        without_genres: '99,10402,10770',
      },
      series: { sort_by: 'vote_average.desc', 'vote_average.gte': 8, 'vote_count.gte': 100, 'vote_count.lte': 1000, without_genres: '99' },
    },
  },
  { id: 'canal', name: 'Sur Canal+', discover: provider(381) },
  { id: 'truestory', name: "Inspirés d'histoires vraies", discover: { movie: pop(300, { with_keywords: 9672 }) } },
  {
    id: 'acclaimed',
    name: 'Acclamés par la critique',
    poolPages: 5,
    genres: true,
    discover: {
      movie: { sort_by: 'vote_average.desc', 'vote_count.gte': 3000 },
      series: { sort_by: 'vote_average.desc', 'vote_count.gte': 800 },
    },
  },
  { id: 'miniseries', name: 'Mini-séries à dévorer', discover: { series: pop(100, { with_type: 2, 'vote_average.gte': 7 }) } },
  { id: 'romance', name: 'Romances', discover: { movie: pop(300, { with_genres: 10749, 'vote_average.gte': 6.3 }) } },
  { id: 'max', name: 'Sur HBO Max', discover: provider(1899) },
  {
    id: 'cult',
    name: { movie: 'Cultes des années 80-90', series: 'Séries cultes' },
    discover: {
      movie: pop(1500, { 'primary_release_date.gte': '1980-01-01', 'primary_release_date.lte': '1999-12-31' }),
      series: pop(300, { 'first_air_date.gte': '1985-01-01', 'first_air_date.lte': '2009-12-31' }),
    },
  },
  { id: 'heist', name: 'Casses & arnaques', discover: { movie: pop(200, { with_keywords: '10051|191845' }) } },
  {
    id: 'docs',
    name: { movie: 'Documentaires', series: 'Séries documentaires' },
    discover: {
      movie: pop(100, { with_genres: 99, 'vote_average.gte': 6.8 }),
      series: pop(30, { with_genres: 99, 'vote_average.gte': 7.5, 'first_air_date.gte': '2010-01-01' }),
    },
  },
  {
    id: 'family',
    name: 'En famille',
    discover: { movie: pop(500, { with_genres: 10751 }), series: pop(50, { with_genres: '10751|10762' }) },
  },
  // Rangee de navigation seulement: son genre est OBLIGATOIRE, ce qui la tient hors de
  // l'accueil (ou elle n'aurait eu que les restes des autres) et la place dans l'onglet
  // Decouvrir.
  {
    id: 'popular',
    name: 'Populaires en France',
    genres: 'required',
    discover: {
      movie: pop(50, { watch_region: 'FR', with_watch_monetization_types: 'flatrate' }),
      series: pop(20, { watch_region: 'FR', with_watch_monetization_types: 'flatrate' }),
    },
  },
  { id: 'favorites', name: 'Mes favoris', source: 'favorites', requires: 'personal' },
];

/** Types pour lesquels une rangee existe. */
function typesOf(row) {
  if (row.discover && (row.discover.movie || row.discover.series)) {
    return ['movie', 'series'].filter((type) => row.discover[type]);
  }
  return ['movie', 'series'];
}

/**
 * Parametres Discover d'une rangee pour un type. Une rangee de catalogs.json peut donner
 * un objet plat, commun aux deux types.
 */
function discoverFor(row, type) {
  const d = row.discover;
  if (!d) return null;
  if (d.movie || d.series) return d[type] || null;
  return d;
}

/** `today`, `today-120`, `today+1` -> date ISO du jour decale d'autant de jours. */
function resolveDates(params) {
  const out = {};
  for (const [key, value] of Object.entries(params)) {
    const match = typeof value === 'string' && value.match(/^today([+-]\d+)?$/);
    out[key] = match ? new Date(Date.now() + Number(match[1] || 0) * 86400000).toISOString().slice(0, 10) : value;
  }
  return out;
}

module.exports = { ROWS, typesOf, discoverFor, resolveDates };
