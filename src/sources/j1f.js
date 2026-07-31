const { mainApi } = require('../movixClient');

// 1jour1film (Mainapi/routes/j1f.js:349-375) -- forme exacte des players non entierement
// documentee, on tente les cles habituelles (url/link, player/name) de facon defensive.
function extractPlayers(data) {
  const raw = data.players || data.links || [];
  const flat = Array.isArray(raw) ? raw : Object.values(raw).flat();
  return flat
    .filter((p) => p.url || p.link)
    .map((p) => ({ url: p.url || p.link, player: p.player || p.name, quality: p.quality, lang: p.lang, sourceName: '1jour1film' }));
}

async function getStreams({ tmdbId, type, season, episode }) {
  try {
    if (type === 'movie') {
      const { data } = await mainApi.get(`/api/j1f/movie/${tmdbId}`);
      return data.success === false ? [] : extractPlayers(data);
    }
    const { data } = await mainApi.get(`/api/j1f/tv/${tmdbId}/season/${season}`, { params: { episode } });
    return data.success === false ? [] : extractPlayers(data);
  } catch (err) {
    return [];
  }
}

module.exports = { name: '1jour1film', getStreams };
