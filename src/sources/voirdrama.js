const { mainApi } = require('../integrations/movixClient');
const resolved = require('./resolved');
const log = require('../core/log');

// Voirdrama (dramas asiatiques), series uniquement: /api/drama/tv/:tmdbid?season=&episode=
// La route refuse explicitement type=movie (voirdrama.js:305-310).
// Reponse: {success, data: [{name, link}]} ou `name` est le hoster (Voe, Uqload,
// Doodstream, Ok.ru, Upstream...) et `link` un embed a extraire (voirdrama.js:206-211).
async function getStreams({ tmdbId, type, season, episode }) {
  if (type !== 'series') return [];

  try {
    const { data } = await mainApi.get(`/api/drama/tv/${tmdbId}`, {
      params: resolved.params({ season, episode }),
    });

    const collected = (Array.isArray(data?.data) ? data.data : [])
      .filter((s) => s.link)
      .map((s) => ({ url: s.link, player: s.name, sourceName: 'Voirdrama' }));

    const { items, resolved: count } = resolved.applyAll(collected, resolved.collect(data));
    log.ok('Voirdrama', tmdbId, `S${season}E${episode}: ${resolved.summary(items.length, count)}`);
    return items;
  } catch (err) {
    if (err.response?.status === 404) {
      log.ok('Voirdrama', tmdbId, 'non trouve sur Voirdrama');
      return [];
    }
    log.fail('Voirdrama', tmdbId, err);
    return [];
  }
}

module.exports = { name: 'Voirdrama', getStreams };
