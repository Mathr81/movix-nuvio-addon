const { mainApi } = require('../movixClient');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractPlayers(data) {
  const players = data.players || data.links || [];
  return (Array.isArray(players) ? players : [])
    .filter((p) => p.url || p.link)
    .map((p) => ({ url: p.url || p.link, player: p.player || p.name, quality: p.quality, lang: p.lang, sourceName: 'Wiflix' }));
}

// Wiflix scrape en tache de fond et repond 202 {pending:true} pendant la premiere recherche
// (Mainapi/routes/wiflix.js:666-675) -- on patiente un peu avant de laisser tomber cette source.
async function pollUntilReady(path, params) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data, status } = await mainApi.get(path, { params, validateStatus: () => true });
    if (status === 202 && data?.pending) {
      await sleep(2500);
      continue;
    }
    if (status >= 200 && status < 300) return data;
    return null;
  }
  return null;
}

async function getStreams({ tmdbId, type, season, episode }) {
  try {
    if (type === 'movie') {
      const data = await pollUntilReady(`/api/wiflix/movie/${tmdbId}`);
      return data ? extractPlayers(data) : [];
    }
    const data = await pollUntilReady(`/api/wiflix/tv/${tmdbId}/${season}`, { episode });
    return data ? extractPlayers(data) : [];
  } catch (err) {
    return [];
  }
}

module.exports = { name: 'Wiflix', getStreams };
