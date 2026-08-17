const config = require('../core/config');
const cache = require('../core/cache');
const tmdbClient = require('./tmdb');

/**
 * Politique d'identifiants de contenu -- un seul module la detient.
 *
 * Elle gouverne DEUX choses qui doivent imperativement s'accorder:
 *  1. les ids que l'addon SERT (catalogues, metas, videos d'episodes);
 *  2. les `content_id` ecrits dans Nuvio (push direct et hub).
 *
 * Pourquoi elles ne peuvent pas diverger: Nuvio enregistre la progression sous l'id de
 * la fiche qu'il lit. Servir `tmdb:1396` tout en poussant `tt0903747` cree deux entrees
 * pour la meme serie -- c'est exactement le doublon Breaking Bad. Il y avait meme
 * autrefois deux ecrivains avec deux politiques differentes.
 *
 * ID_FORMAT arbitre:
 *  - `imdb`  : `tt0903747`. Aligne sur Cinemeta et sur l'essentiel de l'ecosysteme
 *              Stremio/Nuvio, donc les fiches et la progression se recoupent avec les
 *              autres addons installes. Coute une resolution TMDB -> IMDb par titre
 *              (mise en cache 24 h, la correspondance ne changeant jamais).
 *  - `tmdb`  : `tmdb:1396`. Aucun appel supplementaire, mais isole des addons qui
 *              indexent par IMDb.
 *
 * La LECTURE reste tolerante aux deux formes, quel que soit le reglage: les comptes
 * deja peuples contiennent les deux, et `toTmdbId` les ramene a un id TMDB numerique.
 */
const FORMAT = config.ID_FORMAT === 'imdb' ? 'imdb' : 'tmdb';

/** Forme configuree, pour les logs et les routes de diagnostic. */
function format() {
  return FORMAT;
}

/**
 * Id a ECRIRE/SERVIR pour un titre TMDB.
 *
 * En mode imdb, un titre sans correspondance IMDb retombe sur `tmdb:<id>` plutot que
 * d'etre omis: mieux vaut une fiche joignable sous une autre forme que pas de fiche.
 */
async function contentIdFor(type, tmdbId) {
  if (FORMAT !== 'imdb') return `tmdb:${tmdbId}`;

  const key = `imdbOf:${type}:${tmdbId}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached || `tmdb:${tmdbId}`;

  let imdb = null;
  try {
    imdb = await tmdbClient.getImdbId(type, tmdbId);
  } catch {
    imdb = null;
  }
  cache.set(key, imdb, 24 * 60 * 60 * 1000);
  return imdb || `tmdb:${tmdbId}`;
}

/** Plusieurs titres d'un coup (une page de catalogue), sans serialiser les appels. */
function contentIdsFor(type, tmdbIds) {
  return Promise.all(tmdbIds.map((id) => contentIdFor(type, id)));
}

/** `video_id` d'un episode; identique au content_id pour un film. */
function videoIdFor(contentId, season, episode) {
  return season ? `${contentId}:${season}:${episode}` : contentId;
}

const isImdb = (contentId) => /^tt\d+$/.test(String(contentId ?? ''));
const isTmdb = (contentId) => /^tmdb:\d+$/.test(String(contentId ?? ''));

/**
 * Id qui n'est PAS dans la forme configuree -- donc a fusionner. Ce qui est "herite"
 * depend du reglage: en mode imdb ce sont les `tmdb:`, en mode tmdb les `tt`.
 */
function isForeign(contentId) {
  return FORMAT === 'imdb' ? isTmdb(contentId) : isImdb(contentId);
}

/**
 * Ramene n'importe quelle forme (`tmdb:1396`, `1396`, `tt0903747`) a un id TMDB.
 * La correspondance IMDb <-> TMDB ne change jamais: cache long (24 h).
 */
async function toTmdbId(contentId, type) {
  if (contentId === null || contentId === undefined) return null;
  const raw = String(contentId);

  if (raw.startsWith('tmdb:')) return Number(raw.slice(5)) || null;
  if (/^\d+$/.test(raw)) return Number(raw);
  if (!raw.startsWith('tt')) return null;

  const key = `tmdbOf:${raw}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  let id = null;
  try {
    const found = await tmdbClient.findByImdbId(raw);
    const list = type === 'series' ? found.tv_results : found.movie_results;
    id = list?.[0]?.id || null;
  } catch {
    id = null;
  }
  cache.set(key, id, 24 * 60 * 60 * 1000);
  return id;
}

module.exports = { format, contentIdFor, contentIdsFor, videoIdFor, isImdb, isTmdb, isForeign, toTmdbId };
