const { mainApi } = require('../integrations/movixClient');
const resolved = require('./resolved');
const log = require('../core/log');

// Liens communautaires stockes en MySQL et exposes par /api/links/:type/:id (admin.js).
// C'est la source "custom" + "mp4" du site: chaque entree est soit une chaine, soit un objet
// {url, label, language, isVip}. Les .mp4 sont directement jouables (pas d'extraction),
// le reste sont des embeds a resoudre.
//
// Une entree pouvant etre une CHAINE NUE, le serveur ne peut pas y greffer de champ
// `m3u8Url`: il rend a la place une table parallele `m3u8ByPlayer` (lien -> m3u8), que
// `resolved.collect` sait lire. Pour une serie, la resolution n'a lieu que si `season` ET
// `episode` sont fournis -- sinon la requete porte sur tous les episodes, et Movix refuse
// d'en extraire une saison entiere.
function normalizeLinks(rawLinks) {
  const out = [];
  const seen = new Set();

  for (const item of Array.isArray(rawLinks) ? rawLinks : []) {
    const url = typeof item === 'string' ? item : item && typeof item.url === 'string' ? item.url : null;
    if (!url || seen.has(url)) continue;
    seen.add(url);

    const isDirect = /\.(mp4|mkv|webm|m3u8)(\?|$)/i.test(url);
    const label = (typeof item === 'object' && item?.label) || (isDirect ? 'Viblix' : undefined);
    const language = typeof item === 'object' ? item?.language : undefined;

    out.push({
      url,
      direct: isDirect,
      player: label,
      lang: language,
      sourceName: isDirect ? `Movix · ${label || 'Direct'}` : 'Movix · Communauté',
    });
  }
  return out;
}

async function getStreams({ tmdbId, type, season, episode }) {
  try {
    if (type === 'movie') {
      const { data } = await mainApi.get(`/api/links/movie/${tmdbId}`, { params: resolved.params() });
      const { items, resolved: count } = resolved.applyAll(
        normalizeLinks(data?.data?.links),
        resolved.collect(data),
      );
      log.ok('Links', tmdbId, `${resolved.summary(items.length, count)} (${items.filter((r) => r.direct).length} jouable(s) sans extraction)`);
      return items;
    }

    // Series: la route renvoie soit l'episode demande, soit toute la serie si on
    // n'envoie pas season/episode. On cible l'episode pour eviter de tout ramener.
    const { data } = await mainApi.get(`/api/links/tv/${tmdbId}`, {
      params: resolved.params({ season, episode }),
    });
    const rows = Array.isArray(data?.data) ? data.data : data?.data ? [data.data] : [];
    const match =
      rows.find(
        (r) => Number(r.season_number) === Number(season) && Number(r.episode_number) === Number(episode),
      ) || (rows.length === 1 ? rows[0] : null);

    const { items, resolved: count } = resolved.applyAll(normalizeLinks(match?.links), resolved.collect(data));
    log.ok('Links', tmdbId, `S${season}E${episode}: ${resolved.summary(items.length, count)}`);
    return items;
  } catch (err) {
    // 404 = aucun lien enregistre pour ce titre, cas normal et frequent.
    if (err.response?.status === 404) {
      log.ok('Links', tmdbId, 'aucun lien communautaire enregistre');
      return [];
    }
    log.fail('Links', tmdbId, err);
    return [];
  }
}

module.exports = { name: 'Links', getStreams };
