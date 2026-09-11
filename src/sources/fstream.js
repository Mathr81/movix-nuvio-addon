const { mainApi } = require('../integrations/movixClient');
const resolved = require('./resolved');
const log = require('../core/log');

// FStream: players.organized.{VFQ,VFF,VOSTFR,Default} -> [{url,type:'embed',quality,player}]
// (Mainapi/routes/fstream.js). Films: la map est a la racine sous `players`; series:
// sous `episodes[<n>].languages` (movieMapKey='players' / languageKey='languages' cote
// Movix, cf. respondWithResolvedSources).
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
      const { data } = await mainApi.get(`/api/fstream/movie/${tmdbId}`, { params: resolved.params() });
      // La route renvoie `players: players.organized` -- `data.players` EST deja la map
      // {VFQ,VFF,VOSTFR,Default}, il n'y a pas de niveau `.organized` en dessous.
      const { items, resolved: count } = resolved.applyAll(flattenOrganized(data.players), resolved.collect(data));
      log.ok('FStream', tmdbId, resolved.summary(items.length, count));
      return items;
    }

    // Series: la route renvoie l'ensemble de la saison, mais ne RESOUT que l'episode
    // designe par `episode` -- sans ce parametre, tout reste en liens embed.
    const { data } = await mainApi.get(`/api/fstream/tv/${tmdbId}/season/${season}`, {
      params: resolved.params({ episode }),
    });
    const table = resolved.collect(data);

    // Forme 1: `episodes` = map/array indexee par numero d'episode.
    const episodes = data.episodes;
    if (episodes && typeof episodes === 'object') {
      const entry = Array.isArray(episodes)
        ? episodes.find((e) => Number(e.episode_number ?? e.episode) === Number(episode))
        : episodes[String(episode)];
      if (entry) {
        const organized = entry.languages || entry.players || entry.organized || entry;
        const { items, resolved: count } = resolved.applyAll(flattenOrganized(organized), table);
        log.ok('FStream', tmdbId, `S${season}E${episode}: ${resolved.summary(items.length, count)}`);
        return items;
      }
    }

    // Forme 2: map de langues a plat, chaque player portant son numero d'episode.
    const all = flattenOrganized(data.players);
    const filtered = all.filter((p) => p.episode === undefined || Number(p.episode) === Number(episode));
    const { items, resolved: count } = resolved.applyAll(filtered, table);
    log.ok('FStream', tmdbId, `S${season}E${episode} (filtre): ${resolved.summary(items.length, count)}`);
    return items;
  } catch (err) {
    log.fail('FStream', tmdbId, err);
    return [];
  }
}

module.exports = { name: 'FStream', getStreams };
