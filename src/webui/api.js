const fs = require('fs');
const axios = require('axios');
const express = require('express');
const config = require('../core/config');
const paths = require('../core/paths');
const journal = require('../core/journal');
const journalIndex = require('./journalIndex');
const diagnostics = require('../diagnostics');
const tmdb = require('../integrations/tmdb');
const { mainApi } = require('../integrations/movixClient');
const trakt = require('../integrations/traktCloud');
const simkl = require('../integrations/simklCloud');
const hub = require('../hub');
const addons = require('../addons');
const sources = require('../sources');
const resolvedSources = require('../sources/resolved');
const livetv = require('../livetv');
const streamProxy = require('../streaming/streamProxy');
const subsync = require('../streaming/subtitles/sync');
const { breakerState: extractBreakerState } = require('../streaming/hosterExtract');
const { breakerState: probeBreakerState } = require('../streaming/probe');
const logBuffer = require('./logBuffer');
const actions = require('./actions');
const { version } = require('../../package.json');

const TMDB_IMG = 'https://image.tmdb.org/t/p';
const startedAt = Date.now();

function fileInfo(file) {
  try {
    const stat = fs.statSync(file);
    return { size: stat.size, modifiedAt: stat.mtime.toISOString() };
  } catch {
    return null;
  }
}

// --- Joignabilite des services amont ----------------------------------------
// Une requete legere par service, mise en cache 20 s: la page d'accueil se rafraichit
// toute seule, et elle ne doit pas devenir une source de trafic vers Movix.
async function ping(name, request) {
  const began = Date.now();
  try {
    const response = await request();
    return { name, ok: response.status < 500, status: response.status, ms: Date.now() - began };
  } catch (err) {
    return { name, ok: false, error: err.code || err.message, ms: Date.now() - began };
  }
}

let upstreamCache = null;
async function upstream() {
  if (upstreamCache && Date.now() - upstreamCache.at < 20000) return upstreamCache.value;
  const checks = [
    ping('TMDB', () =>
      axios.get('https://api.themoviedb.org/3/configuration', {
        params: { api_key: config.TMDB_API_KEY },
        timeout: 6000,
        validateStatus: () => true,
      }),
    ),
  ];
  // N'importe quelle reponse HTTP prouve que Mainapi est joignable: c'est ce qu'on veut
  // savoir ici, pas si la racine a un sens pour lui.
  if (config.MAIN_API_BASE_URL) {
    checks.push(ping('Movix (Mainapi)', () => mainApi.get('/', { timeout: 6000, validateStatus: () => true })));
  }
  const value = await Promise.all(checks);
  upstreamCache = { at: Date.now(), value };
  return value;
}

/** Les catalogues Live TV viennent de Movix: on borne l'attente pour ne pas figer la page. */
async function liveTvSummary() {
  if (!livetv.enabled()) return { enabled: false };
  try {
    const catalogs = await Promise.race([
      livetv.catalogs(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('delai depasse')), 4000)),
    ]);
    return { enabled: true, catalogs: catalogs.length };
  } catch (err) {
    return { enabled: true, error: err.message };
  }
}

async function overview() {
  const [services, liveTv, ffmpeg] = await Promise.all([upstream(), liveTvSummary(), subsync.enabled()]);
  const memory = process.memoryUsage();

  return {
    process: {
      version,
      node: process.version,
      startedAt: new Date(startedAt).toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      rssBytes: memory.rss,
      heapBytes: memory.heapUsed,
    },
    config: {
      publicUrl: config.PUBLIC_URL || null,
      manifestUrl: `${(config.PUBLIC_URL || `http://127.0.0.1:${config.PORT}`).replace(/\/+$/, '')}/manifest.json`,
      idFormat: config.ID_FORMAT,
      streamList: config.STREAM_LIST,
      tmdbLanguage: config.TMDB_LANGUAGE,
      tmdbKeyConfigured: !!config.TMDB_API_KEY,
    },
    services,
    movix: {
      mainApi: config.MAIN_API_BASE_URL || null,
      vipKeyConfigured: !!config.VIP_ACCESS_KEY,
      // Sans VIP, Movix ne resout plus aucun flux: premier point a verifier quand la
      // liste de streams est vide.
      serverResolve: resolvedSources.enabled(),
      accountConfigured: !!(config.MOVIX_JWT && config.MOVIX_USER_ID),
    },
    sources: sources.map((s) => s.name),
    addons: addons.describe(),
    breakers: { extraction: extractBreakerState(), sonde: probeBreakerState() },
    streamProxy: {
      enabled: config.STREAM_PROXY_ENABLED,
      baseUrl: streamProxy.publicBase(),
      secretConfigured: !!config.STREAM_PROXY_SECRET,
    },
    subtitles: {
      enabled: config.SUBTITLES_ENABLED,
      providers: config.SUBTITLE_PROVIDERS,
      autosync: config.SUBTITLE_AUTOSYNC,
      ffmpeg,
    },
    liveTv,
    trackers: trackers(),
    hub: hub.status(),
    storage: {
      cache: config.CACHE_PERSIST ? fileInfo(config.CACHE_FILE || paths.inData('cache.json')) : null,
      hubState: fileInfo(hub.STATE_FILE),
      journal: fileInfo(journal.JOURNAL_FILE),
    },
  };
}

function trackers() {
  return {
    nuvio: {
      configured: !!config.NUVIO_EMAIL,
      pushIntervalMs: config.NUVIO_PUSH_INTERVAL_MS,
      idFormat: config.ID_FORMAT,
    },
    trakt: {
      configured: !!config.TRAKT_CLIENT_ID,
      authenticated: trakt.isAuthenticated(),
      pushIntervalMs: config.TRAKT_PUSH_INTERVAL_MS,
    },
    simkl: {
      configured: !!config.SIMKL_CLIENT_ID,
      pushIntervalMs: config.SIMKL_PUSH_INTERVAL_MS,
      ...simkl.status(),
    },
  };
}

// --- Recherche TMDB -----------------------------------------------------------
function toCard(item, type) {
  const date = item.release_date || item.first_air_date || '';
  return {
    type,
    id: `tmdb:${item.id}`,
    tmdbId: item.id,
    title: item.title || item.name,
    originalTitle: item.original_title || item.original_name,
    year: date.slice(0, 4) || null,
    poster: item.poster_path ? `${TMDB_IMG}/w342${item.poster_path}` : null,
    backdrop: item.backdrop_path ? `${TMDB_IMG}/w780${item.backdrop_path}` : null,
    overview: item.overview || '',
    rating: item.vote_average ? Math.round(item.vote_average * 10) / 10 : null,
    popularity: item.popularity || 0,
  };
}

async function search(query, type) {
  const types = type === 'movie' || type === 'series' ? [type] : ['movie', 'series'];
  const results = await Promise.all(
    types.map(async (t) => (await tmdb.search(t, query)).map((item) => toCard(item, t))),
  );
  return results.flat().sort((a, b) => b.popularity - a.popularity).slice(0, 30);
}

async function titleInfo(type, tmdbId) {
  const data = await tmdb.details(type, tmdbId);
  const card = toCard(data, type);
  return {
    ...card,
    runtime: data.runtime || data.episode_run_time?.[0] || null,
    genres: (data.genres || []).map((g) => g.name),
    seasons:
      type === 'series'
        ? (data.seasons || [])
            .filter((s) => s.season_number > 0)
            .map((s) => ({ number: s.season_number, name: s.name, episodes: s.episode_count }))
        : [],
  };
}

async function seasonEpisodes(tmdbId, number) {
  const data = await tmdb.season(tmdbId, number);
  return (data.episodes || []).map((e) => ({
    number: e.episode_number,
    name: e.name,
    airDate: e.air_date,
    still: e.still_path ? `${TMDB_IMG}/w300${e.still_path}` : null,
  }));
}

// --- Routeur --------------------------------------------------------------------
function send(res, pending) {
  Promise.resolve(pending)
    .then((body) => res.json(body))
    .catch((err) => {
      const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 502;
      res.status(status).json({ ok: false, error: err.message, status: err.status, body: err.body });
    });
}

function router() {
  const api = express.Router();
  api.use(express.json());

  api.get('/overview', (_req, res) => send(res, overview()));

  api.get('/search', (req, res) => {
    const query = String(req.query.q || '').trim();
    if (!query) return res.json([]);
    send(res, search(query, req.query.type));
  });

  api.get('/tmdb/:type/:tmdbId', (req, res) => send(res, titleInfo(req.params.type, req.params.tmdbId)));
  api.get('/tmdb/series/:tmdbId/season/:number', (req, res) =>
    send(res, seasonEpisodes(req.params.tmdbId, Number(req.params.number))),
  );

  // Quatre appels distincts: l'interface affiche chaque bloc des qu'il arrive, et la
  // mesure des flux peut prendre plusieurs secondes de plus que le reste.
  api.get('/title/:type/:id/links', (req, res) => send(res, diagnostics.rawLinks(req.params.type, req.params.id)));
  api.get('/title/:type/:id/extract', (req, res) =>
    send(res, diagnostics.extraction(req.params.type, req.params.id)),
  );
  api.get('/title/:type/:id/streams', (req, res) => send(res, diagnostics.streams(req.params.type, req.params.id)));
  api.get('/title/:type/:id/subsync', (req, res) =>
    send(res, diagnostics.subtitleSync(req.params.type, req.params.id, { compute: req.query.compute === '1' })),
  );

  api.get('/sync', (req, res) =>
    send(
      res,
      journalIndex.list({ limit: Math.min(Number(req.query.limit) || 40, 500) }).then((cycles) => ({
        hub: hub.status(),
        trackers: trackers(),
        journalEnabled: config.HUB_JOURNAL,
        cycles,
        actions: actions.describe(),
      })),
    ),
  );

  api.get('/journal/:cycle', (req, res) =>
    send(res, journalIndex.entries(req.params.cycle, { limit: Math.min(Number(req.query.limit) || 500, 5000) })),
  );

  api.post('/actions/:name', (req, res) => {
    const params = { ...(req.body || {}), dryRun: req.query.dryRun === '1' || req.body?.dryRun === true };
    send(res, actions.run(req.params.name, params));
  });

  api.get('/logs', (req, res) => res.json(logBuffer.since(Number(req.query.after) || 0)));

  // Flux SSE: l'historique d'abord (depuis `Last-Event-ID` en cas de reconnexion), puis
  // chaque nouvelle ligne. Le commentaire periodique empeche Nginx de couper la connexion.
  api.get('/logs/stream', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const emit = (entry) => res.write(`id: ${entry.id}\ndata: ${JSON.stringify(entry)}\n\n`);
    const after = Number(req.headers['last-event-id']) || 0;
    for (const entry of logBuffer.since(after)) emit(entry);

    const unsubscribe = logBuffer.subscribe(emit);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  return api;
}

module.exports = { router };
