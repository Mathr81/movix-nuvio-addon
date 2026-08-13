const { mainApi } = require('../movixClient');
const log = require('../log');

// Cpasmal: {links: {vf: [...], vostfr: [...]}} (Mainapi/routes/cpasmal.js:61-63).
function extractLinks(data) {
  const out = [];
  for (const [lang, arr] of Object.entries(data.links || {})) {
    for (const l of arr || []) {
      const url = l.url || l.link;
      if (url) out.push({ url, player: l.player || l.name, quality: l.quality, lang, sourceName: 'Cpasmal' });
    }
  }
  return out;
}

async function getStreams({ tmdbId, type, season, episode }) {
  try {
    let data;
    if (type === 'movie') {
      ({ data } = await mainApi.get(`/api/cpasmal/movie/${tmdbId}`));
    } else {
      ({ data } = await mainApi.get(`/api/cpasmal/tv/${tmdbId}/${season}/${episode}`));
    }
    const results = extractLinks(data);
    log.ok('Cpasmal', tmdbId, `${results.length} lien(s) (notFound=${data.notFound}, cles: ${Object.keys(data).join(',')})`);
    return results;
  } catch (err) {
    log.fail('Cpasmal', tmdbId, err);
    return [];
  }
}

module.exports = { name: 'Cpasmal', getStreams };
