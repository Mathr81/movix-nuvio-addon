const { mainApi } = require('../movixClient');
const log = require('../log');

// Liens communautaires stockes en MySQL et exposes par /api/links/:type/:id (admin.js:110).
// C'est la source "custom" + "mp4" du site: chaque entree est soit une chaine, soit un objet
// {url, label, language, isVip}. Les .mp4 sont directement jouables (pas d'extraction),
// le reste sont des embeds a resoudre (cf. WatchMovie.tsx:228-269).
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
      const { data } = await mainApi.get(`/api/links/movie/${tmdbId}`);
      const results = normalizeLinks(data?.data?.links);
      log.ok('Links', tmdbId, `${results.length} lien(s) communautaire(s) (${results.filter((r) => r.direct).length} direct)`);
      return results;
    }

    // Series: la route renvoie soit l'episode demande, soit toute la serie si on
    // n'envoie pas season/episode. On cible l'episode pour eviter de tout ramener.
    const { data } = await mainApi.get(`/api/links/tv/${tmdbId}`, { params: { season, episode } });
    const rows = Array.isArray(data?.data) ? data.data : data?.data ? [data.data] : [];
    const match =
      rows.find(
        (r) => Number(r.season_number) === Number(season) && Number(r.episode_number) === Number(episode),
      ) || (rows.length === 1 ? rows[0] : null);

    const results = normalizeLinks(match?.links);
    log.ok('Links', tmdbId, `${results.length} lien(s) communautaire(s) pour S${season}E${episode}`);
    return results;
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
