const { mainApi } = require('../movixClient');

// PurStream est la seule source qui renvoie deja des URLs directes (pas d'embed a extraire).
async function getStreams({ tmdbId, type, season, episode }) {
  try {
    if (type === 'movie') {
      const { data } = await mainApi.get(`/api/purstream/movie/${tmdbId}/stream`);
      return (data.sources || [])
        .filter((s) => s.url)
        .map((s) => ({ url: s.url, sourceName: s.name ? `PurStream · ${s.name}` : 'PurStream', quality: s.format, direct: true }));
    }

    const { data } = await mainApi.get(`/api/purstream/tv/${tmdbId}/stream`, { params: { season, episode } });
    return (data.sources || [])
      .filter((s) => s.url)
      .map((s) => ({ url: s.url, sourceName: s.name ? `PurStream · ${s.name}` : 'PurStream', quality: s.format, direct: true }));
  } catch (err) {
    return [];
  }
}

module.exports = { name: 'PurStream', getStreams };
