// Ids de genres TMDB (stables). Libelles en francais pour coller a l'interface du site.
const MOVIE_GENRES = {
  Action: 28,
  Aventure: 12,
  Animation: 16,
  Comédie: 35,
  Crime: 80,
  Documentaire: 99,
  Drame: 18,
  Familial: 10751,
  Fantastique: 14,
  Histoire: 36,
  Horreur: 27,
  Musique: 10402,
  Mystère: 9648,
  Romance: 10749,
  'Science-Fiction': 878,
  Thriller: 53,
  Guerre: 10752,
  Western: 37,
};

const SERIES_GENRES = {
  'Action & Aventure': 10759,
  Animation: 16,
  Comédie: 35,
  Crime: 80,
  Documentaire: 99,
  Drame: 18,
  Familial: 10751,
  Jeunesse: 10762,
  Mystère: 9648,
  Réalité: 10764,
  'Sci-Fi & Fantastique': 10765,
  Soap: 10766,
  'Guerre & Politique': 10768,
  Western: 37,
};

function genreMap(type) {
  return type === 'series' ? SERIES_GENRES : MOVIE_GENRES;
}

function genreNames(type) {
  return Object.keys(genreMap(type));
}

function genreId(type, name) {
  if (!name) return undefined;
  return genreMap(type)[name];
}

module.exports = { genreNames, genreId };
