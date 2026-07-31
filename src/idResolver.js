const tmdbClient = require('./tmdb');

// Formats acceptes: "tmdb:12345", "tmdb:12345:1:2" (serie), "tt1234567", "tt1234567:1:2".
async function resolveId(type, rawId) {
  const parts = rawId.split(':');

  if (parts[0] === 'tmdb') {
    return {
      tmdbId: parts[1],
      season: parts[2] !== undefined ? Number(parts[2]) : undefined,
      episode: parts[3] !== undefined ? Number(parts[3]) : undefined,
    };
  }

  if (parts[0].startsWith('tt')) {
    const found = await tmdbClient.findByImdbId(parts[0]);
    const media = type === 'series' ? found.tv_results?.[0] : found.movie_results?.[0];
    if (!media) throw new Error(`TMDB introuvable pour ${parts[0]}`);
    return {
      tmdbId: String(media.id),
      season: parts[1] !== undefined ? Number(parts[1]) : undefined,
      episode: parts[2] !== undefined ? Number(parts[2]) : undefined,
    };
  }

  throw new Error(`Format d'id non supporte: ${rawId}`);
}

module.exports = { resolveId };
