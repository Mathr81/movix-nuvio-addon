const { mainApi } = require('../movixClient');

// FStream: players.organized.{VFQ,VFF,VOSTFR,Default} -> [{url,type:'embed',quality,player}]
// (Mainapi/routes/fstream.js:1568-1631).
function flattenOrganized(organized) {
  const out = [];
  for (const [lang, players] of Object.entries(organized || {})) {
    for (const p of players || []) {
      if (p.url) out.push({ url: p.url, player: p.player, quality: p.quality, lang, sourceName: 'FStream' });
    }
  }
  return out;
}

async function getStreams({ tmdbId, type, season, episode }) {
  try {
    if (type === 'movie') {
      const { data } = await mainApi.get(`/api/fstream/movie/${tmdbId}`);
      return flattenOrganized(data.players?.organized);
    }

    // Route saison entiere -- l'episode precis se filtre cote reponse si presente (structure
    // exacte non entierement documentee: a ajuster si le format differe en pratique).
    const { data } = await mainApi.get(`/api/fstream/tv/${tmdbId}/season/${season}`);
    const episodes = data.episodes || data.players?.episodes;
    if (Array.isArray(episodes)) {
      const ep = episodes.find((e) => Number(e.episode_number || e.episode) === Number(episode));
      return flattenOrganized(ep?.players?.organized || ep?.organized);
    }
    return flattenOrganized(data.players?.organized);
  } catch (err) {
    return [];
  }
}

module.exports = { name: 'FStream', getStreams };
