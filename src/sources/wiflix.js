const { mainApi } = require('../integrations/movixClient');
const resolved = require('./resolved');
const log = require('../core/log');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wiflix -- deux formes, une par type de contenu (Mainapi/routes/wiflix.js).
 *
 *   film  : `players`     = { vf: [...], vostfr: [...] }   (scrape sur cinestream.info)
 *   serie : `episodes[N]` = { vf: [...], vostfr: [...] }   (scrape sur flemmix)
 *
 * Les deux sont des MAPS par langue, pas des tableaux. L'ancienne lecture
 * (`Array.isArray(data.players)`) ne rendait donc plus rien du tout: les films tombaient
 * sur un objet, et les series lisaient une cle qui n'existe plus depuis que la route
 * regroupe ses lecteurs par episode.
 *
 * Chaque lecteur: { name: <domaine de l'hebergeur>, url, episode, type: 'VF'|'VOSTFR' }.
 */
function flattenByLang(map) {
  const out = [];
  for (const [lang, players] of Object.entries(map || {})) {
    if (!Array.isArray(players)) continue;
    for (const p of players) {
      if (p && p.url) out.push({ url: p.url, player: p.name, lang: p.type || lang, sourceName: 'Wiflix' });
    }
  }
  return out;
}

// Wiflix scrape en tache de fond et repond 202 {pending:true} pendant la premiere
// recherche -- on patiente un peu avant de laisser tomber cette source.
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
    const data =
      type === 'movie'
        ? await pollUntilReady(`/api/wiflix/movie/${tmdbId}`, resolved.params())
        : await pollUntilReady(`/api/wiflix/tv/${tmdbId}/${season}`, resolved.params({ episode }));

    if (!data) {
      log.ok('Wiflix', tmdbId, 'pas de reponse exploitable (toujours pending ou statut inattendu)');
      return [];
    }
    if (data.success === false) {
      log.ok('Wiflix', tmdbId, `success=false: ${data.error || 'raison inconnue'}`);
      return [];
    }

    const map = type === 'movie' ? data.players : data.episodes?.[String(episode)];
    const { items, resolved: count } = resolved.applyAll(flattenByLang(map), resolved.collect(data));

    const scope = type === 'movie' ? '' : `S${season}E${episode}: `;
    log.ok('Wiflix', tmdbId, `${scope}${resolved.summary(items.length, count)}`);
    return items;
  } catch (err) {
    log.fail('Wiflix', tmdbId, err);
    return [];
  }
}

module.exports = { name: 'Wiflix', getStreams };
