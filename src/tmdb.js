const axios = require('axios');
const config = require('./config');

const tmdb = axios.create({
  baseURL: 'https://api.themoviedb.org/3',
  timeout: 10000,
  params: { api_key: config.TMDB_API_KEY, language: config.TMDB_LANGUAGE },
});

function mediaOf(type) {
  return type === 'series' ? 'tv' : 'movie';
}

async function trending(type, page = 1) {
  const { data } = await tmdb.get(`/trending/${mediaOf(type)}/week`, { params: { page } });
  return data.results || [];
}

async function popular(type, page = 1) {
  const { data } = await tmdb.get(`/${mediaOf(type)}/popular`, { params: { page } });
  return data.results || [];
}

async function search(type, query, page = 1) {
  const { data } = await tmdb.get(`/search/${mediaOf(type)}`, { params: { query, page } });
  return data.results || [];
}

async function topRated(type, page = 1) {
  const { data } = await tmdb.get(`/${mediaOf(type)}/top_rated`, { params: { page } });
  return data.results || [];
}

/** Nouveautes: sorties en salles / a l'affiche pour les films, series en cours de diffusion. */
async function nowPlaying(type, page = 1) {
  const path = type === 'series' ? '/tv/on_the_air' : '/movie/now_playing';
  const { data } = await tmdb.get(path, { params: { page, region: config.TMDB_REGION } });
  return data.results || [];
}

/** Discover, utilise pour le filtrage par genre. */
async function discover(type, { genreId: gid, page = 1, sortBy = 'popularity.desc' } = {}) {
  const { data } = await tmdb.get(`/discover/${mediaOf(type)}`, {
    params: {
      page,
      sort_by: sortBy,
      with_genres: gid,
      // Evite que les titres confidentiels sans votes remontent devant les vrais succes.
      'vote_count.gte': sortBy.startsWith('vote_average') ? 200 : undefined,
    },
  });
  return data.results || [];
}

/**
 * Discover brut: les parametres declares dans catalogs.json sont transmis tels quels a
 * TMDB, ce qui rend une rangee personnalisee aussi expressive que l'API elle-meme.
 */
async function discoverWith(type, params = {}, page = 1) {
  const { data } = await tmdb.get(`/discover/${mediaOf(type)}`, { params: { page, ...params } });
  return data.results || [];
}

/** Recupere plusieurs fiches TMDB en parallele (catalogues personnels issus du sync). */
async function detailsMany(items) {
  const settled = await Promise.allSettled(
    items.map((item) => details(item.type, item.id).then((d) => ({ ...d, __source: item }))),
  );
  return settled.filter((r) => r.status === 'fulfilled').map((r) => r.value);
}

async function details(type, tmdbId) {
  const { data } = await tmdb.get(`/${mediaOf(type)}/${tmdbId}`, { params: { append_to_response: 'credits' } });
  return data;
}

/** Titres proches d'un titre donne, selon TMDB (base des recommandations locales). */
async function recommendations(type, tmdbId, page = 1) {
  const { data } = await tmdb.get(`/${mediaOf(type)}/${tmdbId}/recommendations`, { params: { page } });
  return data.results || [];
}

async function season(tmdbId, seasonNumber) {
  const { data } = await tmdb.get(`/tv/${tmdbId}/season/${seasonNumber}`);
  return data;
}

async function findByImdbId(imdbId) {
  const { data } = await tmdb.get(`/find/${imdbId}`, { params: { external_source: 'imdb_id' } });
  return data;
}

/**
 * Recupere l'id IMDB (ttXXXXXXX) a partir d'un id TMDB.
 * Necessaire pour /api/imdb/:type/:id cote Mainapi, qui attend un id IMDB et pas TMDB
 * (le frontend fait exactement ce detour, cf. WatchMovie.tsx:759-762).
 */
async function getImdbId(type, tmdbId) {
  const path = type === 'series' ? `/tv/${tmdbId}/external_ids` : `/movie/${tmdbId}/external_ids`;
  const { data } = await tmdb.get(path);
  return data.imdb_id || null;
}

module.exports = {
  trending,
  popular,
  topRated,
  nowPlaying,
  discover,
  discoverWith,
  search,
  details,
  detailsMany,
  recommendations,
  season,
  findByImdbId,
  getImdbId,
};
