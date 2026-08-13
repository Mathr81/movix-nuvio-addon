const { mainApi } = require('../movixClient');
const log = require('../log');

// Voirdrama (dramas asiatiques), series uniquement: /api/drama/tv/:tmdbid?season=&episode=
// La route refuse explicitement type=movie (voirdrama.js:305-310).
// Reponse: {success, data: [{name, link}]} ou `name` est le hoster (Voe, Uqload,
// Doodstream, Ok.ru, Upstream...) et `link` un embed a extraire (voirdrama.js:206-211).
async function getStreams({ tmdbId, type, season, episode }) {
  if (type !== 'series') return [];

  try {
    const { data } = await mainApi.get(`/api/drama/tv/${tmdbId}`, { params: { season, episode } });

    const results = (Array.isArray(data?.data) ? data.data : [])
      .filter((s) => s.link)
      .map((s) => ({ url: s.link, player: s.name, sourceName: 'Voirdrama' }));

    log.ok('Voirdrama', tmdbId, `${results.length} lien(s) pour S${season}E${episode}`);
    return results;
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
