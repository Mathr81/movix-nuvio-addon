const { mainApi } = require('../movixClient');
const log = require('../log');

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
    let data;
    if (type === 'movie') {
      data = await pollUntilReady(`/api/wiflix/movie/${tmdbId}`);
    } else {
      data = await pollUntilReady(`/api/wiflix/tv/${tmdbId}/${season}`, { episode });
    }
    if (!data) {
      log.ok('Wiflix', tmdbId, 'pas de reponse exploitable (toujours pending ou statut inattendu)');
      return [];
    }
    const results = extractPlayers(data);
    log.ok('Wiflix', tmdbId, `${results.length} lien(s) (success=${data.success}, cles: ${Object.keys(data).join(',')})`);
    return results;
  } catch (err) {
    log.fail('Wiflix', tmdbId, err);
    return [];
  }
}

module.exports = { name: 'Wiflix', getStreams };
