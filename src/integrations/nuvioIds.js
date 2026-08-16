const cache = require('../core/cache');
const tmdbClient = require('./tmdb');

/**
 * Politique d'identifiants Nuvio -- un seul module la detient.
 *
 * Pourquoi elle existe: il y avait DEUX ecrivains vers Nuvio (le push direct
 * `nuvioPush` et le hub) et chacun fabriquait son `content_id` de son cote. Le push
 * suivait NUVIO_ID_PREFERENCE et ecrivait un id IMDb (`tt0903747`), le hub ecrivait
 * toujours `tmdb:1396`. Meme serie, deux cles: Nuvio affichait Breaking Bad en double,
 * avec une progression differente dans chaque exemplaire.
 *
 * La forme canonique est donc `tmdb:<id>`, pour tout le monde:
 *  - c'est ce que l'addon sert deja (`tmdb:1396` dans les catalogues et les metas), donc
 *    les entrees poussees correspondent aux fiches que Nuvio ouvre depuis cet addon;
 *  - la resolution TMDB est locale et sans appel reseau, la resolution IMDb demandait un
 *    aller-retour `/external_ids` par titre, avec repli silencieux sur `tmdb:` en cas
 *    d'echec -- ce qui produisait deja des doublons a lui seul.
 *
 * La LECTURE reste tolerante: les deux formes existent dans les comptes deja peuples,
 * et `toTmdbId` les ramene toutes a un id TMDB numerique.
 */

/** Forme canonique ecrite dans Nuvio. */
function contentIdFor(tmdbId) {
  return `tmdb:${tmdbId}`;
}

/** `video_id` d'un episode; identique au content_id pour un film. */
function videoIdFor(contentId, season, episode) {
  return season ? `${contentId}:${season}:${episode}` : contentId;
}

/** Un id IMDb (`tt0903747`) -- forme heritee, a fusionner vers `tmdb:`. */
function isLegacyId(contentId) {
  return /^tt\d+$/.test(String(contentId ?? ''));
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

module.exports = { contentIdFor, videoIdFor, isLegacyId, toTmdbId };
