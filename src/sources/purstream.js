const { mainApi } = require('../integrations/movixClient');
const log = require('../core/log');

/**
 * PurStream -- la seule source Movix qui a toujours rendu des URLs directes, sans embed a
 * extraire. Elle n'a donc pas besoin de `resolve=1`.
 *
 * Deux choses ont change cote Movix, toutes deux transparentes ici:
 *  - l'hote de l'API amont est resolu dynamiquement (`purstream.wiki/api/status`), l'ancien
 *    `api.purstream.cc` etant mort;
 *  - pour un VIP, l'URL rendue passe par `/cinep-proxy` et porte une SIGNATURE `exp`+`sig`
 *    valable 12 h. On la relaie telle quelle -- la reconstruire ou en retirer les
 *    parametres la rendrait invalide. La duree de vie du cache de streams
 *    (STREAM_TTL_MS, 30 min par defaut) reste tres en deca de ces 12 h.
 */
async function getStreams({ tmdbId, type, season, episode }) {
  try {
    let data;
    if (type === 'movie') {
      ({ data } = await mainApi.get(`/api/purstream/movie/${tmdbId}/stream`));
    } else {
      ({ data } = await mainApi.get(`/api/purstream/tv/${tmdbId}/stream`, { params: { season, episode } }));
    }

    const results = (data.sources || [])
      .filter((s) => s.url)
      .map((s) => ({ url: s.url, sourceName: s.name ? `PurStream · ${s.name}` : 'PurStream', quality: s.format, direct: true }));

    log.ok('PurStream', tmdbId, `${results.length} source(s) directe(s) (reponse brute: ${JSON.stringify(data).slice(0, 200)})`);
    return results;
  } catch (err) {
    log.fail('PurStream', tmdbId, err);
    return [];
  }
}

module.exports = { name: 'PurStream', getStreams };
