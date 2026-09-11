const { mainApi } = require('../integrations/movixClient');
const resolved = require('./resolved');
const log = require('../core/log');

/**
 * Coflix, monte sur /api/tmdb/:type/:id malgre le nom de la route (Mainapi/routes/tmdb.js).
 *
 *   film  : `player_links` a la racine
 *   serie : `current_episode.player_links` -- la route sert DEJA un seul episode par
 *           appel (`?season=&episode=`), d'ou ce conteneur dedie.
 *
 * Lecteur: { decoded_url, quality, language }. Le champ d'URL est `decoded_url`, pas
 * `link` ni `url`: l'ancienne lecture ne voyait donc aucun lien.
 */
function collectPlayers(links) {
  return (Array.isArray(links) ? links : [])
    .map((p) => ({
      url: p.decoded_url || p.link || p.url,
      player: p.player || p.name,
      quality: p.quality,
      lang: p.language,
      sourceName: 'Coflix',
    }))
    .filter((p) => p.url);
}

async function getStreams({ tmdbId, type, season, episode }) {
  try {
    const mediaType = type === 'series' ? 'tv' : 'movie';
    const params = mediaType === 'tv' ? resolved.params({ season, episode }) : resolved.params();
    const { data } = await mainApi.get(`/api/tmdb/${mediaType}/${tmdbId}`, { params });

    const links = mediaType === 'tv' ? data.current_episode?.player_links : data.player_links;
    const collected = collectPlayers(links);

    // L'iframe de secours n'est pas un lien d'hebergeur: le serveur ne la resout pas et
    // nous non plus. Elle ne vaut que comme "ouvrir dans le navigateur".
    if (data.iframe_src) collected.push({ url: data.iframe_src, sourceName: 'Coflix' });

    const { items, resolved: count } = resolved.applyAll(collected, resolved.collect(data));
    log.ok('Coflix', tmdbId, resolved.summary(items.length, count));
    return items;
  } catch (err) {
    log.fail('Coflix', tmdbId, err);
    return [];
  }
}

module.exports = { name: 'Coflix', getStreams };
