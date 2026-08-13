const { addonBuilder } = require('stremio-addon-sdk');
const manifest = require('./manifest');
const tmdbClient = require('./tmdb');
const config = require('./config');
const cache = require('./cache');
const { resolveId } = require('./idResolver');
const { buildStreams } = require('./streamBuilder');
const { buildSubtitles } = require('./subtitles');
const { genreId } = require('./genres');
const movixSync = require('./movixSync');
const trakt = require('./traktCloud');
const { personalRecommendations } = require('./recommend');
const catalogs = require('./catalogs');

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

/**
 * Catalogues personnels: les entrees synchronisees ne portent qu'un id + un titre,
 * on repasse par TMDB pour obtenir des fiches completes (affiche, synopsis...).
 */
async function personalCatalog(kind, type, page) {
  const perPage = 20;
  const entries =
    kind === 'continue'
      ? await movixSync.getContinueWatching(type)
      : await movixSync.getCollection(kind === 'watchlist' ? 'watchlist' : 'favorites', type);

  const slice = entries.slice((page - 1) * perPage, page * perPage);
  if (slice.length === 0) return [];

  // detailsMany ne renvoie que la fiche TMDB: on re-associe par id pour retrouver la
  // progression et l'episode en cours portes par l'entree de sync d'origine.
  const bySyncId = new Map(slice.map((e) => [Number(e.id), e]));
  const detailed = await tmdbClient.detailsMany(slice.map((e) => ({ id: e.id, type })));

  return detailed.map((d) => {
    const meta = toCatalogMeta(d, type);
    const source = bySyncId.get(Number(d.id)) || {};
    // La progression est affichee dans le libelle: le protocole Stremio ne permet pas a
    // un addon de positionner la reprise de lecture, on peut seulement l'indiquer.
    const progress = Number(source.progress);
    const parts = [];
    if (source.currentEpisode) parts.push(`S${source.currentEpisode.season}E${source.currentEpisode.episode}`);
    if (Number.isFinite(progress) && progress > 0 && progress < 100) parts.push(`${Math.round(progress)}%`);
    if (parts.length > 0) meta.name = `${meta.name} · ${parts.join(' · ')}`;
    return meta;
  });
}

/**
 * Recommandations Trakt. Trakt ne renvoie que des identifiants et des metadonnees
 * textuelles: on repasse par TMDB pour les affiches, comme pour les catalogues perso.
 */
async function traktRecommendations(type, page) {
  const perPage = 20;
  const rows = await trakt.recommendations(type, { limit: 100 });

  const tmdbIds = rows
    .map((row) => (row.movie || row.show || row).ids?.tmdb)
    .filter(Boolean)
    .slice((page - 1) * perPage, page * perPage);
  if (tmdbIds.length === 0) return [];

  const detailed = await tmdbClient.detailsMany(tmdbIds.map((tmdbId) => ({ id: tmdbId, type })));
  return detailed.map((d) => toCatalogMeta(d, type));
}

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  const page = extra?.skip ? Math.floor(Number(extra.skip) / 20) + 1 : 1;
  const genre = extra?.genre;
  const cacheKey = `catalog:${type}:${id}:${extra?.search || ''}:${genre || ''}:${page}`;
  const def = catalogs.find(id);
  const kind = def?.builtin;

  try {
    // Les catalogues personnels ont leur propre cache (TTL sync) et ne sont pas memoises ici,
    // sinon ajouter un film a sa liste sur le site mettrait 30 min a apparaitre.
    if (kind === 'continue' || kind === 'watchlist' || kind === 'favorites') {
      return { metas: await personalCatalog(kind, type, page) };
    }

    // Recommandations locales: un calcul = 12 appels TMDB, a ne pas refaire a chaque
    // ouverture de l'accueil.
    if (kind === 'reco') {
      const items = await cache.wrap(cacheKey, config.CACHE_TTL_MS, config.CACHE_EMPTY_TTL_MS, () =>
        personalRecommendations(type),
      );
      return { metas: items.map((item) => toCatalogMeta(item, type)) };
    }

    // Les recommandations changent lentement (Trakt les recalcule au fil de l'historique)
    // mais chaque appel coute un aller-retour Trakt + N fiches TMDB: on memoise la page.
    if (kind === 'trakt-reco') {
      return {
        metas: await cache.wrap(cacheKey, config.CACHE_TTL_MS, config.CACHE_EMPTY_TTL_MS, () =>
          traktRecommendations(type, page),
        ),
      };
    }

    const items = await cache.wrap(cacheKey, config.CACHE_TTL_MS, config.CACHE_EMPTY_TTL_MS, async () => {
      if (extra?.search) return tmdbClient.search(type, extra.search, page);

      // Rangee personnalisee (catalogs.json): les parametres Discover font foi, le genre
      // choisi dans l'interface vient s'y ajouter sans les ecraser.
      if (def && !kind) {
        const gid = genreId(type, genre);
        return tmdbClient.discoverWith(type, { ...def.discover, ...(gid ? { with_genres: gid } : {}) }, page);
      }

      const gid = genreId(type, genre);
      if (gid) {
        const sortBy = kind === 'toprated' ? 'vote_average.desc' : 'popularity.desc';
        return tmdbClient.discover(type, { genreId: gid, page, sortBy });
      }

      if (kind === 'trending') return tmdbClient.trending(type, page);
      if (kind === 'toprated') return tmdbClient.topRated(type, page);
      if (kind === 'new') return tmdbClient.nowPlaying(type, page);
      return tmdbClient.popular(type, page);
    });

    return { metas: items.map((item) => toCatalogMeta(item, type)) };
  } catch (err) {
    // Une panne TMDB passagere ne doit pas faire echouer la rangee entiere cote Nuvio:
    // mieux vaut une ligne vide + un log explicite qu'une erreur opaque dans l'interface.
    const status = err.response?.status;
    console.error(`[catalog] ${type}/${id} echec: status=${status ?? 'n/a'} msg=${err.message}`);
    return { metas: [] };
  }
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
