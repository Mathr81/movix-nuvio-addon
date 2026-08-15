const axios = require('axios');
const config = require('../config');
const cache = require('../cache');
const tmdbClient = require('../tmdb');
const streamProxy = require('../streamProxy');

/**
 * Boite a outils commune aux addons.
 *
 * Un addon n'a pas a savoir comment sont signes les liens du proxy, ni comment on
 * interroge TMDB, ni quel User-Agent presenter: il decrit ce que SA source attend, et
 * appelle ces helpers. C'est ce qui fait qu'ajouter une source revient a ecrire un seul
 * fichier de resolution, sans toucher au reste.
 */

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const ACCEPT_LANGUAGE = 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7';

/**
 * En-tetes "Client Hints" d'un Chrome recent, tels qu'un navigateur les envoie vers un
 * autre domaine. Certains WAF les exigent pour croire au navigateur.
 */
function chromeHints() {
  return {
    'sec-ch-ua': '"Not=A?Brand";v="99", "Google Chrome";v="131", "Chromium";v="131"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'cross-site',
    priority: 'u=1, i',
  };
}

/** "Le Loup de Wall Street" -> "le-loup-de-wall-street" */
function slugify(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function createHttp({ baseURL, headers, timeout = 10000 } = {}) {
  return axios.create({
    baseURL,
    timeout,
    headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': ACCEPT_LANGUAGE, ...headers },
  });
}

/**
 * Identite du titre, telle qu'une source externe la reconnait: elle n'a pas d'id TMDB a
 * nous proposer, seulement un titre et une annee.
 *
 * `title` suit TMDB_LANGUAGE (francais par defaut, ce que cherchent les sites FR),
 * `originalTitle` est le titre d'origine -- celui des sites internationaux.
 */
async function titleOf(type, tmdbId) {
  return cache.wrap(`addon-meta:${type}:${tmdbId}`, config.CACHE_TTL_MS, config.CACHE_EMPTY_TTL_MS, async () => {
    const details = await tmdbClient.details(type, tmdbId);
    const title = details.title || details.name || '';
    const originalTitle = details.original_title || details.original_name || title;
    const date = details.release_date || details.first_air_date || '';
    return { title, originalTitle, year: date.slice(0, 4), slug: slugify(originalTitle) };
  });
}

/**
 * Ids TMDB INTERNES de la saison et de l'episode -- a ne pas confondre avec leurs numeros.
 * Certains sites les portent dans l'URL de leur page de lecture, donc dans le Referer que
 * leur CDN attend (ex: /media/tmdb-tv-273240-off-campus/421523/7061243).
 *
 * Une saison entiere tient en un appel: on met en cache la saison, pas l'episode, pour
 * qu'une serie regardee d'affilee ne repaye jamais TMDB.
 */
async function episodeRef(tmdbId, seasonNumber, episodeNumber) {
  const season = await cache.wrap(
    `addon-season:${tmdbId}:${seasonNumber}`,
    config.CACHE_TTL_MS,
    config.CACHE_EMPTY_TTL_MS,
    async () => {
      const data = await tmdbClient.season(tmdbId, seasonNumber);
      return {
        seasonId: data?.id || null,
        episodes: Object.fromEntries((data?.episodes || []).map((ep) => [ep.episode_number, ep.id])),
      };
    },
  );
  return { seasonId: season.seasonId, episodeId: season.episodes?.[episodeNumber] || null };
}

/**
 * Transforme une URL de flux en URL jouable par Nuvio/Stremio: le lien pointe sur notre
 * proxy, qui rejouera `spec.headers` a chaque segment.
 *
 * Rendre l'URL brute quand le proxy est coupe est volontaire: la source reste visible et
 * echouera franchement a la lecture, au lieu de disparaitre sans explication.
 */
function proxied(url, spec) {
  if (!config.STREAM_PROXY_ENABLED) return url;
  return streamProxy.proxyUrl(url, spec);
}

module.exports = {
  BROWSER_UA,
  ACCEPT_LANGUAGE,
  chromeHints,
  slugify,
  createHttp,
  titleOf,
  episodeRef,
  proxied,
};
