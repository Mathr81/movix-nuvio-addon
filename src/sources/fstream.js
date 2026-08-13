const { mainApi } = require('../movixClient');
const log = require('../log');

// FStream: players.organized.{VFQ,VFF,VOSTFR,Default} -> [{url,type:'embed',quality,player}]
// (Mainapi/routes/fstream.js:1568-1631).
function flattenOrganized(organized) {
  const out = [];
  for (const [lang, players] of Object.entries(organized || {})) {
    if (!Array.isArray(players)) continue;
    for (const p of players) {
      if (p && p.url) {
        out.push({ url: p.url, player: p.player, quality: p.quality, lang, episode: p.episode, sourceName: 'FStream' });
      }
    }
  }
  return out;
}

async function getStreams({ tmdbId, type, season, episode }) {
  try {
    if (type === 'movie') {
      const { data } = await mainApi.get(`/api/fstream/movie/${tmdbId}`);
      // La route renvoie `players: players.organized` (fstream.js:1571) -- `data.players` EST
      // deja la map {VFQ,VFF,VOSTFR,Default}, il n'y a pas de niveau `.organized` en dessous.
      const results = flattenOrganized(data.players);
      log.ok('FStream', tmdbId, `${results.length} lien(s) (total annonce=${data.total}, success=${data.success})`);
      return results;
    }

    // Series: la route renvoie l'ensemble de la saison. Les players portent un champ
    // `episode` (voir getSeriesPlayersForUrl -> apiEpisodes), on filtre dessus.
    const { data } = await mainApi.get(`/api/fstream/tv/${tmdbId}/season/${season}`);

    // Forme 1: `episodes` = map/array indexee par numero d'episode.
    const episodes = data.episodes;
    if (episodes && typeof episodes === 'object') {
      const entry = Array.isArray(episodes)
        ? episodes.find((e) => Number(e.episode_number ?? e.episode) === Number(episode))
        : episodes[String(episode)];
      if (entry) {
        const organized = entry.languages || entry.players || entry.organized || entry;
        const results = flattenOrganized(organized);
        log.ok('FStream', tmdbId, `${results.length} lien(s) pour S${season}E${episode} (via data.episodes)`);
        return results;
      }
    }

    // Forme 2: map de langues a plat, chaque player portant son numero d'episode.
    const all = flattenOrganized(data.players);
    const results = all.filter((p) => p.episode === undefined || Number(p.episode) === Number(episode));
    log.ok('FStream', tmdbId, `${results.length}/${all.length} lien(s) pour S${season}E${episode} (filtre par episode)`);
    return results;
  } catch (err) {
    log.fail('FStream', tmdbId, err);
    return [];
  }
}

module.exports = { name: 'FStream', getStreams };
