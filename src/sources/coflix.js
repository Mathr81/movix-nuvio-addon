const { mainApi } = require('../movixClient');
const log = require('../log');

// Coflix, monte sur /api/tmdb/:type/:id malgre le nom de la route (Mainapi/routes/tmdb.js:302).
async function getStreams({ tmdbId, type, season, episode }) {
  try {
    const mediaType = type === 'series' ? 'tv' : 'movie';
    const params = mediaType === 'tv' ? { season, episode } : undefined;
    const { data } = await mainApi.get(`/api/tmdb/${mediaType}/${tmdbId}`, { params });

    const links = data.player_links || [];
    const results = links
      .filter((p) => p.link || p.url)
      .map((p) => ({
        url: p.link || p.url,
        player: p.player || p.name,
        quality: p.is_hd ? '1080p' : undefined,
        sourceName: 'Coflix',
      }));

    if (data.iframe_src) results.push({ url: data.iframe_src, sourceName: 'Coflix' });

    log.ok('Coflix', tmdbId, `${results.length} lien(s) (cles reponse: ${Object.keys(data).join(',')})`);
    return results;
  } catch (err) {
    log.fail('Coflix', tmdbId, err);
    return [];
  }
}

module.exports = { name: 'Coflix', getStreams };
