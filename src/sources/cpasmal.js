const { mainApi } = require('../integrations/movixClient');
const resolved = require('./resolved');
const log = require('../core/log');

/**
 * Cpasmal -- `links` = { vf: [{server, url}], vostfr: [...] } (Mainapi/routes/cpasmal.js).
 *
 * Une seule forme sert le film comme l'episode: la route serie prend son episode dans
 * le CHEMIN (`/tv/:tmdbid/:season/:episode`), pas en query. Rien a cibler en plus, donc,
 * `resolve=1` suffit -- cote Movix la bascule est declaree en `movieMapKey: 'links'`
 * pour les deux routes.
 */
function flattenByLang(map) {
  const out = [];
  for (const [lang, links] of Object.entries(map || {})) {
    if (!Array.isArray(links)) continue;
    for (const l of links) {
      const url = l?.url || l?.link;
      if (url) out.push({ url, player: l.server || l.player || l.name, lang, sourceName: 'Cpasmal' });
    }
  }
  return out;
}

async function getStreams({ tmdbId, type, season, episode }) {
  try {
    const path =
      type === 'movie' ? `/api/cpasmal/movie/${tmdbId}` : `/api/cpasmal/tv/${tmdbId}/${season}/${episode}`;
    const { data } = await mainApi.get(path, { params: resolved.params() });

    const { items, resolved: count } = resolved.applyAll(flattenByLang(data.links), resolved.collect(data));
    log.ok('Cpasmal', tmdbId, `${resolved.summary(items.length, count)} (notFound=${data.notFound})`);
    return items;
  } catch (err) {
    log.fail('Cpasmal', tmdbId, err);
    return [];
  }
}

module.exports = { name: 'Cpasmal', getStreams };
