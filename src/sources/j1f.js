const { mainApi } = require('../integrations/movixClient');
const resolved = require('./resolved');
const log = require('../core/log');

/**
 * 1jour1film (Mainapi/routes/j1f.js).
 *
 *   film  : `players`     = { vf: [...], vostfr: [...] }
 *   serie : `episodes[N]` = { vf: [...], vostfr: [...], label }
 *
 * Lecteur: { name: <domaine>, url, type: 'iframe'|'mp4', label, source }.
 * `type: 'mp4'` designe un fichier directement jouable -- il n'y a rien a extraire, et
 * le passer a l'extraction le ferait rejeter comme "hebergeur inconnu".
 */
function flattenByLang(map) {
  const out = [];
  for (const [lang, players] of Object.entries(map || {})) {
    if (!Array.isArray(players)) continue;
    for (const p of players) {
      if (!p || !p.url) continue;
      out.push({
        url: p.url,
        player: p.name,
        lang,
        quality: p.label || undefined,
        direct: p.type === 'mp4',
        sourceName: '1jour1film',
      });
    }
  }
  return out;
}

async function getStreams({ tmdbId, type, season, episode }) {
  try {
    const { data } =
      type === 'movie'
        ? await mainApi.get(`/api/j1f/movie/${tmdbId}`, { params: resolved.params() })
        : await mainApi.get(`/api/j1f/tv/${tmdbId}/season/${season}`, { params: resolved.params({ episode }) });

    if (data.pending) {
      log.ok('1jour1film', tmdbId, 'scraping en cours cote Movix -- rien pour ce passage');
      return [];
    }
    if (data.success === false) {
      log.ok('1jour1film', tmdbId, `success=false: ${data.error || 'raison inconnue'}`);
      return [];
    }

    const map = type === 'movie' ? data.players : data.episodes?.[String(episode)];
    const { items, resolved: count } = resolved.applyAll(flattenByLang(map), resolved.collect(data));

    const scope = type === 'movie' ? '' : `S${season}E${episode}: `;
    log.ok('1jour1film', tmdbId, `${scope}${resolved.summary(items.length, count)}`);
    return items;
  } catch (err) {
    log.fail('1jour1film', tmdbId, err);
    return [];
  }
}

module.exports = { name: '1jour1film', getStreams };
