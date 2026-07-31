const { mainApi } = require('../movixClient');

// FrenchStream, monte sur /api/imdb/:type/:id (Mainapi/routes/tmdb.js:553).
// Film: {iframe_src, player_links}. Serie: series[].seasons[].episodes[].versions.<lang>.players[].
async function getStreams({ tmdbId, type, season, episode }) {
  try {
    const mediaType = type === 'series' ? 'tv' : 'movie';
    const { data } = await mainApi.get(`/api/imdb/${mediaType}/${tmdbId}`);

    if (mediaType === 'movie') {
      const links = data.player_links || [];
      const results = links
        .filter((p) => p.link || p.url)
        .map((p) => ({ url: p.link || p.url, player: p.player || p.name, sourceName: 'FrenchStream' }));
      if (data.iframe_src) results.push({ url: data.iframe_src, sourceName: 'FrenchStream' });
      return results;
    }

    const seasons = data.series?.[0]?.seasons || data.seasons || [];
    const seasonData =
      seasons.find((s) => Number(s.season_number || s.number) === Number(season)) || seasons[Number(season) - 1];
    const ep =
      seasonData?.episodes?.find((e) => Number(e.episode_number || e.number) === Number(episode)) ||
      seasonData?.episodes?.[Number(episode) - 1];

    const results = [];
    if (ep?.versions) {
      for (const [lang, versionData] of Object.entries(ep.versions)) {
        for (const p of versionData.players || []) {
          if (p.link || p.url) results.push({ url: p.link || p.url, player: p.name, lang, sourceName: 'FrenchStream' });
        }
      }
    }
    return results;
  } catch (err) {
    return [];
  }
}

module.exports = { name: 'FrenchStream', getStreams };
