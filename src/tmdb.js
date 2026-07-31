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

async function details(type, tmdbId) {
  const { data } = await tmdb.get(`/${mediaOf(type)}/${tmdbId}`, { params: { append_to_response: 'credits' } });
  return data;
}

async function season(tmdbId, seasonNumber) {
  const { data } = await tmdb.get(`/tv/${tmdbId}/season/${seasonNumber}`);
  return data;
}

async function findByImdbId(imdbId) {
  const { data } = await tmdb.get(`/find/${imdbId}`, { params: { external_source: 'imdb_id' } });
  return data;
}

module.exports = { trending, popular, search, details, season, findByImdbId };
