const { mainApi } = require('../movixClient');
const log = require('../log');

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
    let data;
    if (type === 'movie') {
      ({ data } = await mainApi.get(`/api/j1f/movie/${tmdbId}`));
    } else {
      ({ data } = await mainApi.get(`/api/j1f/tv/${tmdbId}/season/${season}`, { params: { episode } }));
    }
    if (data.success === false) {
      log.ok('1jour1film', tmdbId, `success=false: ${data.error || 'raison inconnue'}`);
      return [];
    }
    const results = extractPlayers(data);
    log.ok('1jour1film', tmdbId, `${results.length} lien(s) (cles reponse: ${Object.keys(data).join(',')})`);
    return results;
  } catch (err) {
    log.fail('1jour1film', tmdbId, err);
    return [];
  }
}

module.exports = { name: '1jour1film', getStreams };
