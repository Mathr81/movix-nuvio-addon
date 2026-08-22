const { addonBuilder } = require('stremio-addon-sdk');
const manifest = require('./manifest');
const tmdbClient = require('./integrations/tmdb');
const config = require('./core/config');
const cache = require('./core/cache');
const { resolveId } = require('./catalog/idResolver');
const { buildStreams, prefetchNextEpisode } = require('./streaming/streamBuilder');
const { buildSubtitles } = require('./streaming/subtitles');
const { genreId } = require('./catalog/genres');
const movixSync = require('./integrations/movixSync');
const trakt = require('./integrations/traktCloud');
const { personalRecommendations } = require('./catalog/recommend');
const catalogs = require('./catalog/catalogs');
const ids = require('./integrations/contentIds');

const TMDB_POSTER_BASE = 'https://image.tmdb.org/t/p/w500';
const TMDB_BACKDROP_BASE = 'https://image.tmdb.org/t/p/w1280';

const builder = new addonBuilder(manifest);

/**
 * Les ids servis suivent ID_FORMAT (cf. integrations/contentIds.js). En mode imdb, cela
 * demande une resolution TMDB -> IMDb par titre: `toCatalogMetas` les mene de front pour
 * une page entiere, et le cache 24 h fait que seul le premier affichage la paye.
 */
function toCatalogMetas(items, type) {
  return Promise.all(items.map(async (item) => ({ ...toCatalogMeta(item, type), id: await ids.contentIdFor(type, item.id) })));
}

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
  const entries = await movixSync.getCollection(kind === 'watchlist' ? 'watchlist' : 'favorites', type);

  const slice = entries.slice((page - 1) * perPage, page * perPage);
  if (slice.length === 0) return [];

  // Les titres sont rendus tels quels. La progression y figurait autrefois ("S1E4 · 45%")
  // faute de mieux -- un addon ne peut pas positionner la reprise de lecture. Maintenant
  // que le hub pousse les positions vers Nuvio Sync et Simkl, qui la gerent nativement,
  // cette annotation ne faisait plus que surcharger les libelles.
  const detailed = await tmdbClient.detailsMany(slice.map((e) => ({ id: e.id, type })));
  return toCatalogMetas(detailed, type);
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
  return toCatalogMetas(detailed, type);
}

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  const page = extra?.skip ? Math.floor(Number(extra.skip) / 20) + 1 : 1;
  const genre = extra?.genre;
  // ID_FORMAT fait partie de la cle: la rangee des recommandations Trakt est memoisee
  // DEJA mise en forme, donc un changement de format doit invalider ce qui est en cache
  // plutot que de continuer a servir des ids de l'ancienne forme.
  const cacheKey = `catalog:${ids.format()}:${type}:${id}:${extra?.search || ''}:${genre || ''}:${page}`;
  const def = catalogs.find(id);
  const kind = def?.builtin;

  try {
    // Les catalogues personnels ont leur propre cache (TTL sync) et ne sont pas memoises ici,
    // sinon ajouter un film a sa liste sur le site mettrait 30 min a apparaitre.
    if (kind === 'watchlist' || kind === 'favorites') {
      return { metas: await personalCatalog(kind, type, page) };
    }

    // Recommandations locales: un calcul = 12 appels TMDB, a ne pas refaire a chaque
    // ouverture de l'accueil.
    if (kind === 'reco') {
      const items = await cache.wrap(cacheKey, config.CACHE_TTL_MS, config.CACHE_EMPTY_TTL_MS, () =>
        personalRecommendations(type),
      );
      return { metas: await toCatalogMetas(items, type) };
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

    return { metas: await toCatalogMetas(items, type) };
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

  const contentId = await ids.contentIdFor(type, tmdbId);
  const meta = {
    id: contentId,
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
          id: ids.videoIdFor(contentId, s.season_number, ep.episode_number),
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

/**
 * Detection du rafraichissement insistant.
 *
 * Le protocole Stremio n'a pas de "recharge": une demande de streams ressemble a toutes les
 * autres, et le cache repond la meme liste. Or quand on rouvre la meme fiche trois fois en
 * quelques secondes, ce n'est pas par hasard -- c'est qu'on cherche autre chose que ce qui
 * s'affiche. Ce geste EST le signal, et c'est le seul dont on dispose.
 *
 * Le premier affichage compte pour un, d'ou un seuil a 3: ouvrir puis rafraichir deux fois.
 * Deux aurait suffi en theorie, mais certains lecteurs demandent les streams deux fois pour
 * une seule ouverture -- le cache ne servirait alors plus jamais a rien.
 * Le compteur repart a zero apres un scan, pour ne pas en relancer un a chaque demande.
 */
const recentRequests = new Map();

function wantsRescan(key) {
  if (config.STREAM_REFRESH_HITS <= 0) return false;

  const now = Date.now();
  const times = (recentRequests.get(key) || []).filter((t) => now - t < config.STREAM_REFRESH_WINDOW_MS);
  times.push(now);

  if (times.length >= config.STREAM_REFRESH_HITS) {
    recentRequests.delete(key);
    console.log(
      `[stream] ${times.length} demandes en ${Math.round((now - times[0]) / 1000)}s sur ${key} -- nouveau scan, sans le cache`,
    );
    return true;
  }

  recentRequests.set(key, times);
  // Menage: sans ca, la table grossit d'une entree par fiche ouverte, indefiniment.
  if (recentRequests.size > 200) {
    for (const [otherKey, stamps] of recentRequests) {
      if (now - stamps[stamps.length - 1] > config.STREAM_REFRESH_WINDOW_MS) recentRequests.delete(otherKey);
    }
  }
  return false;
}

builder.defineStreamHandler(async ({ type, id }) => {
  try {
    const { tmdbId, season, episode } = await resolveId(type, id);
    const refresh = wantsRescan(`${type}:${id}`);
    const streams = await buildStreams({ tmdbId, type, season, episode, refresh });
    // Apres avoir repondu, pas avant: c'est du confort pour la suite, jamais un delai ici.
    prefetchNextEpisode({ tmdbId, type, season, episode });
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
    // La cle de contenu voyage dans l'URL de chaque piste: c'est elle qui permettra, au
    // moment ou le lecteur ira chercher le fichier, de savoir QUEL flux est en cours et
    // donc sur quoi caler (cf. streaming/playback.js). Le protocole, lui, ne le dit pas.
    const bind = config.SUBTITLE_AUTOSYNC ? { kind: 'c', ref: `${type}:${tmdbId}:${season ?? ''}:${episode ?? ''}` } : null;
    const subtitles = await buildSubtitles({ type, tmdbId, season, episode, publicBaseUrl, bind });
    return { subtitles };
  } catch (err) {
    console.error('[subtitles] erreur:', err.message);
    return { subtitles: [] };
  }
});

module.exports = builder.getInterface();
// Expose pour les bancs d'essai: la regle de declenchement d'un rescan se verifie sans
// avoir a simuler tout le protocole Stremio.
module.exports.wantsRescan = wantsRescan;
