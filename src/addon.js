const { addonBuilder } = require('stremio-addon-sdk');
const manifest = require('./manifest');
const tmdbClient = require('./tmdb');
const config = require('./config');
const cache = require('./cache');
const { resolveId } = require('./idResolver');
const { buildStreams } = require('./streamBuilder');
const { buildSubtitles } = require('./subtitles');

const TMDB_POSTER_BASE = 'https://image.tmdb.org/t/p/w500';
const TMDB_BACKDROP_BASE = 'https://image.tmdb.org/t/p/w1280';

const builder = new addonBuilder(manifest);

function toCatalogMeta(item, type) {
  return {
    id: `tmdb:${item.id}`,
    type,
    name: item.title || item.name,
    poster: item.poster_path ? `${TMDB_POSTER_BASE}${item.poster_path}` : undefined,
    releaseInfo: (item.release_date || item.first_air_date || '').slice(0, 4),
    description: item.overview,
  };
}

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  const page = extra?.skip ? Math.floor(Number(extra.skip) / 20) + 1 : 1;
  const cacheKey = `catalog:${type}:${id}:${extra?.search || ''}:${page}`;

  const items = await cache.wrap(cacheKey, config.CACHE_TTL_MS, config.CACHE_EMPTY_TTL_MS, async () => {
    if (extra?.search) return tmdbClient.search(type, extra.search, page);
    if (id.endsWith('trending')) return tmdbClient.trending(type, page);
    return tmdbClient.popular(type, page);
  });

  return { metas: items.map((item) => toCatalogMeta(item, type)) };
});

builder.defineMetaHandler(async ({ type, id }) => {
  const { tmdbId } = await resolveId(type, id);
  // Une serie declenche un fetch TMDB par saison -- sans cache, chaque ouverture de fiche
  // repaye la totalite de ces appels.
  const details = await cache.wrap(`meta:${type}:${tmdbId}`, config.CACHE_TTL_MS, config.CACHE_EMPTY_TTL_MS, () =>
    tmdbClient.details(type, tmdbId),
  );

  const meta = {
    id: `tmdb:${tmdbId}`,
    type,
    name: details.title || details.name,
    poster: details.poster_path ? `${TMDB_POSTER_BASE}${details.poster_path}` : undefined,
    background: details.backdrop_path ? `${TMDB_BACKDROP_BASE}${details.backdrop_path}` : undefined,
    description: details.overview,
    releaseInfo: (details.release_date || details.first_air_date || '').slice(0, 4),
    genres: (details.genres || []).map((g) => g.name),
    cast: (details.credits?.cast || []).slice(0, 10).map((c) => c.name),
    runtime: details.runtime ? `${details.runtime} min` : undefined,
  };

  if (type === 'series') {
    const seasonNumbers = (details.seasons || []).map((s) => s.season_number).filter((n) => n > 0);
    const seasonsData = await cache.wrap(`seasons:${tmdbId}`, config.CACHE_TTL_MS, config.CACHE_EMPTY_TTL_MS, () =>
      Promise.all(seasonNumbers.map((n) => tmdbClient.season(tmdbId, n).catch(() => null))),
    );

    meta.videos = seasonsData
      .filter(Boolean)
      .flatMap((s) =>
        (s.episodes || []).map((ep) => ({
          id: `tmdb:${tmdbId}:${s.season_number}:${ep.episode_number}`,
          title: ep.name,
          season: s.season_number,
          episode: ep.episode_number,
          released: ep.air_date ? new Date(ep.air_date).toISOString() : undefined,
          thumbnail: ep.still_path ? `${TMDB_POSTER_BASE}${ep.still_path}` : undefined,
        })),
      );
  }

  return { meta };
});

builder.defineStreamHandler(async ({ type, id }) => {
  try {
    const { tmdbId, season, episode } = await resolveId(type, id);
    const streams = await buildStreams({ tmdbId, type, season, episode });
    return { streams };
  } catch (err) {
    console.error('[stream] erreur:', err.message);
    return { streams: [] };
  }
});

builder.defineSubtitlesHandler(async ({ type, id }) => {
  try {
    const { tmdbId, season, episode } = await resolveId(type, id);
    // Les sous-titres sont servis par notre propre route /subtitle.vtt (conversion .gz -> .vtt),
    // il faut donc une URL que l'appareil de lecture sait joindre.
    const publicBaseUrl = config.PUBLIC_URL || `http://127.0.0.1:${config.PORT}`;
    const subtitles = await buildSubtitles({ type, tmdbId, season, episode, publicBaseUrl });
    return { subtitles };
  } catch (err) {
    console.error('[subtitles] erreur:', err.message);
    return { subtitles: [] };
  }
});

module.exports = builder.getInterface();
