const { mainApi } = require('../movixClient');
const log = require('../log');

// PurStream est la seule source qui renvoie deja des URLs directes (pas d'embed a extraire).
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
