const { mainApi } = require('../movixClient');

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
    if (type === 'movie') {
      const { data } = await mainApi.get(`/api/cpasmal/movie/${tmdbId}`);
      return extractLinks(data);
    }
    const { data } = await mainApi.get(`/api/cpasmal/tv/${tmdbId}/${season}/${episode}`);
    return extractLinks(data);
  } catch (err) {
    return [];
  }
}

module.exports = { name: 'Cpasmal', getStreams };
