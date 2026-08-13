const { mainApi } = require('../movixClient');
const log = require('../log');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Les players Wiflix ont la forme {name, url, episode, type} ou `type` porte la version
// (vf/vostfr) et `name` le domaine du hoster (wiflix.js:389-394, 432-437).
function extractPlayers(data, episode) {
  const players = Array.isArray(data.players) ? data.players : [];
  return players
    .filter((p) => p.url)
    // La route TV renvoie TOUTE la saison: sans ce filtre, l'episode 1 remonterait
    // les liens de tous les episodes.
    .filter((p) => episode === undefined || p.episode === undefined || Number(p.episode) === Number(episode))
    .map((p) => ({ url: p.url, player: p.name, lang: p.type, sourceName: 'Wiflix' }));
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
      data = await pollUntilReady(`/api/wiflix/tv/${tmdbId}/${season}`);
    }
    if (!data) {
      log.ok('Wiflix', tmdbId, 'pas de reponse exploitable (toujours pending ou statut inattendu)');
      return [];
    }
    const total = Array.isArray(data.players) ? data.players.length : 0;
    const results = extractPlayers(data, type === 'movie' ? undefined : episode);
    log.ok('Wiflix', tmdbId, `${results.length}/${total} lien(s) retenus (success=${data.success})`);
    return results;
  } catch (err) {
    log.fail('Wiflix', tmdbId, err);
    return [];
  }
}

module.exports = { name: 'Wiflix', getStreams };
