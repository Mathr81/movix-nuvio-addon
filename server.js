// En tout premier: la page Logs de la WebUI doit voir aussi les avertissements que la
// config emet des son chargement.
require('./src/webui/logBuffer').install();

const express = require('express');
const { getRouter } = require('stremio-addon-sdk');
const addonInterface = require('./src/addon');
const config = require('./src/core/config');
const { servedVtt, readPayload, isAllowedHost } = require('./src/streaming/subtitles');
const subsync = require('./src/streaming/subtitles/sync');
const diagnostics = require('./src/diagnostics');
const resolvedSources = require('./src/sources/resolved');
const livetv = require('./src/livetv');
const { mainApi } = require('./src/integrations/movixClient');
const streamProxy = require('./src/streaming/streamProxy');
const addons = require('./src/addons');
const { pushToNuvio } = require('./src/integrations/nuvioPush');
const nuvioCloud = require('./src/integrations/nuvioCloud');
const nuvioMerge = require('./src/integrations/nuvioMerge');
const contentIds = require('./src/integrations/contentIds');
const { pushToTrakt } = require('./src/integrations/traktPush');
const trakt = require('./src/integrations/traktCloud');
const { pushToSimkl } = require('./src/integrations/simklPush');
const simkl = require('./src/integrations/simklCloud');
const simklLibrary = require('./src/integrations/simklLibrary');
const hub = require('./src/hub');
const { startCodeAuth } = require('./src/webui/actions');
const webui = require('./src/webui');

const app = express();

// Stremio/Nuvio interrogent l'addon depuis n'importe quelle origine.
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  next();
});

// --- Proxy de sous-titres -------------------------------------------------
// Les fournisseurs servent du .vtt (vdrk) ou un .gz contenant du .srt (OpenSubtitles);
// Stremio/Nuvio n'attendent que du .vtt. On telecharge, convertit, retire les repliques
// publicitaires et sert a la volee.
async function serveSubtitle(payload, res) {
  const src = payload && payload.url;
  if (!src || !/^https?:\/\//i.test(src)) {
    console.warn(`[subtitle] source manquante ou invalide: ${JSON.stringify(String(src || '').slice(0, 120))}`);
    return res.status(400).type('text/plain').send('source de sous-titre manquante ou invalide');
  }

  // Ne relayer que vers les hotes des fournisseurs declares: sans cette borne, la route
  // serait un proxy HTTP ouvert. La liste vient du module de sous-titres, donc ajouter un
  // fournisseur n'oblige plus a penser a l'autoriser ici.
  let host;
  try {
    host = new URL(src).hostname;
  } catch {
    console.warn(`[subtitle] source illisible: ${src.slice(0, 120)}`);
    return res.status(400).type('text/plain').send('source de sous-titre invalide');
  }
  if (!isAllowedHost(host)) {
    console.warn(`[subtitle] host non autorise: ${host}`);
    return res.status(403).type('text/plain').send('host non autorise');
  }

  try {
    // C'est ICI que le calage a lieu, et pas au moment ou la liste est construite: quand le
    // lecteur reclame le fichier, la lecture a deja commence, donc le flux a caler n'est
    // plus une supposition (cf. src/streaming/playback.js).
    const { vtt, plan } = await servedVtt(payload);
    // En-tete de diagnostic: `curl -I` sur l'URL d'une piste dit ce qui lui a ete applique.
    res.setHeader('X-Movix-Subsync', plan ? subsync.describe(plan).replace(/\s+/g, ' ') : 'aucun calage');
    return res.type('text/vtt').send(vtt);
  } catch (err) {
    console.error(`[subtitle] echec pour ${src.slice(0, 120)}: ${err.message}`);
    return res.status(502).type('text/plain').send('sous-titre indisponible');
  }
}

// Forme servie aux lecteurs: la source est encodee dans le CHEMIN et l'URL se termine
// par ".vtt". Rien a mal interpreter en route, et l'extension rassure les lecteurs qui la
// verifient -- contrairement au parametre de requete, qu'un intermediaire peut tronquer.
app.get('/subtitle/:payload', (req, res) => serveSubtitle(readPayload(req.params.payload), res));

// Ancienne forme (?src=), conservee pour les liens deja distribues a un client.
app.get('/subtitle.vtt', (req, res) => serveSubtitle({ url: req.query.src }, res));

// --- WebUI ------------------------------------------------------------------
// Tableau de bord sous /ui (sante, testeur de titre, synchro, logs). Cf. src/webui/.
webui.mount(app);

// --- Proxy de flux --------------------------------------------------------
// Rejoue les en-tetes (Origin/Referer/User-Agent...) exiges par les CDN des addons, que
// Nuvio/Stremio ne savent pas poser eux-memes, et reecrit les playlists m3u8 pour que les
// segments repassent par ici. Les URLs sont signees: sans ca, la route serait un relais
// HTTP ouvert (meme precaution que /subtitle.vtt ci-dessus).
streamProxy.mount(app);

// --- Diagnostic -----------------------------------------------------------
async function sendDiagnostic(res, pending) {
  try {
    res.json(await pending);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// Montre ce que chaque source a reellement renvoye, avant extraction. Utile quand
// Nuvio affiche "aucun stream" sans qu'on sache quelle etape a lache.
// --- Diagnostic Nuvio -----------------------------------------------------
// Declarees AVANT `/debug/:type/:id`: Express prend la premiere route qui
// correspond, et ce motif generique capturait `/debug/nuvio/sample` en le lisant
// comme type=nuvio, id=sample -- d'ou un "Format d'id non supporte: sample".
// Entrees Nuvio encore identifiees par un id IMDb: c'est ce qui faisait apparaitre la
// meme serie en double. Lecture seule -- `POST /nuvio/merge` fait la fusion.
app.get('/debug/nuvio/duplicates', async (_req, res) => {
  try {
    const profileId = await hub.resolveProfileId();
    res.json({
      profileId,
      format: contentIds.format(),
      aFusionner: await nuvioMerge.countLegacy(profileId),
    });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

// Ce que l'API Nuvio expose reellement (tables + RPC). Sert a savoir si une suppression
// est possible: les endpoints `sync_push_*` sont additifs et ne retirent jamais rien.
app.get('/debug/nuvio/api', async (_req, res) => {
  try {
    res.json(await nuvioCloud.listEndpoints());
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

// Forme reelle d'une ligne Nuvio (noms de champs + signature des RPC de suppression).
// C'est ce qui evite de deviner quelle cle la fonction attend.
app.get('/debug/nuvio/sample', async (_req, res) => {
  try {
    const profileId = await hub.resolveProfileId();
    const [progress, watched, endpoints] = await Promise.all([
      nuvioCloud.pullWatchProgress(profileId).catch(() => []),
      nuvioCloud.pullWatchedItems(profileId).catch(() => []),
      nuvioCloud.listEndpoints(),
    ]);
    const deleteRpcs = endpoints.rpcs.filter((n) => /(delete|remove)/i.test(n));

    // Les tables telles que PostgREST les expose: une colonne de cle que `sync_pull_*`
    // ne projette pas (l'equivalent de `progress_key` pour les elements vus) n'apparait
    // que la. Un refus RLS est une reponse en soi, on la rapporte plutot que d'echouer.
    const brut = {};
    for (const table of ['watch_progress', 'watched_items', 'library_items']) {
      if (!endpoints.tables.includes(table)) continue;
      try {
        const rows = await nuvioCloud.readRows(table, { profile_id: `eq.${profileId}` });
        brut[table] = { champs: Object.keys(rows[0] || {}), exemple: rows[0] || null };
      } catch (err) {
        brut[table] = { erreur: err.message.slice(0, 200) };
      }
    }

    res.json({
      profileId,
      progress: { champs: Object.keys(progress[0] || {}), exemple: progress[0] || null },
      watched: { champs: Object.keys(watched[0] || {}), exemple: watched[0] || null },
      tables: endpoints.tables,
      tablesLues: brut,
      signatures: Object.fromEntries(
        await Promise.all(deleteRpcs.map(async (n) => [n, await nuvioCloud.rpcParameters(n)])),
      ),
    });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

app.get('/debug/:type/:id', (req, res) => sendDiagnostic(res, diagnostics.rawLinks(req.params.type, req.params.id)));

// Diagnostic de l'extraction: ce que chaque embed est devenu, et pourquoi (cf. src/diagnostics.js).
app.get('/debug/extract/:type/:id', (req, res) =>
  sendDiagnostic(res, diagnostics.extraction(req.params.type, req.params.id)),
);

// Diagnostic de la mesure de debit: ce que la sonde a REELLEMENT obtenu par lien.
app.get('/debug/streams/:type/:id', (req, res) =>
  sendDiagnostic(res, diagnostics.streams(req.params.type, req.params.id)),
);

// Diagnostic du calage des sous-titres. `?compute=1` force le calcul au lieu de se
// contenter de ce qui est deja en cache -- c'est la facon de le tester sans lancer Nuvio.
app.get('/debug/subsync/:type/:id', (req, res) => {
  const compute = req.query.compute === '1' || req.query.compute === 'true';
  sendDiagnostic(res, diagnostics.subtitleSync(req.params.type, req.params.id, { compute }));
});

// Etat du registre d'addons: lesquels sont charges, lesquels sont ecartes et pourquoi.
app.get('/debug/addons', (_req, res) => {
  res.json({
    proxyEnabled: config.STREAM_PROXY_ENABLED,
    proxyBaseUrl: streamProxy.publicBase(),
    proxySecretConfigured: !!config.STREAM_PROXY_SECRET,
    addons: addons.describe(),
  });
});

// Diagnostic sync: montre la reponse brute de Mainapi pour chaque forme d'URL testee,
// sans le cache, pour identifier precisement pourquoi les catalogues personnels sont vides.
app.get('/debug/sync', async (_req, res) => {
  if (!config.MOVIX_JWT || !config.MOVIX_USER_ID) {
    return res.json({ configured: false, hint: 'Renseigne MOVIX_JWT et MOVIX_USER_ID dans .env' });
  }

  const base = `/api/sync/${config.MOVIX_USER_TYPE}/${config.MOVIX_USER_ID}`;
  const candidates = config.MOVIX_PROFILE_ID ? [`${base}/${config.MOVIX_PROFILE_ID}`, base] : [base];
  const attempts = [];

  for (const url of candidates) {
    try {
      const { status, data } = await mainApi.get(url, {
        headers: { Authorization: `Bearer ${config.MOVIX_JWT}` },
        validateStatus: () => true,
      });
      const body = typeof data === 'string' ? data.slice(0, 400) : data;
      attempts.push({
        url,
        status,
        keys: data?.data ? Object.keys(data.data) : undefined,
        body: data?.data ? undefined : body,
      });
    } catch (err) {
      attempts.push({ url, error: err.message });
    }
  }

  res.json({
    configured: true,
    userType: config.MOVIX_USER_TYPE,
    profileIdSet: !!config.MOVIX_PROFILE_ID,
    spoofedOrigin: config.SPOOFED_ORIGIN,
    attempts,
  });
});

// --- Push vers Nuvio Sync ------------------------------------------------
// POST (et non GET) car l'operation ecrit dans le compte Nuvio.
// ?dryRun=1 calcule et affiche le resultat sans rien envoyer.
app.post('/nuvio/push', async (req, res) => {
  const dryRun = req.query.dryRun === '1' || req.query.dryRun === 'true';
  try {
    const summary = await pushToNuvio({ dryRun });
    res.status(summary.ok ? 200 : 400).json(summary);
  } catch (err) {
    const status = err.response?.status;
    const body = err.response?.data;
    console.error(`[nuvio-push] echec: status=${status ?? 'n/a'} msg=${err.message}`);
    res.status(502).json({ ok: false, error: err.message, status, body });
  }
});

// ?dryRun=1 montre ce qui serait fusionne sans rien ecrire.
app.post('/nuvio/merge', async (req, res) => {
  const dryRun = req.query.dryRun === '1' || req.query.dryRun === 'true';
  try {
    const summary = await hub.mergeNuvioIds({ dryRun });
    res.status(summary.ok ? 200 : 400).json(summary);
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

// --- Trakt ---------------------------------------------------------------
// Autorisation par device code: la reponse renvoie immediatement le code a saisir,
// l'attente de validation se poursuit cote serveur (elle peut durer plusieurs minutes).
app.post('/trakt/auth', async (_req, res) => {
  try {
    res.json({
      ...(await startCodeAuth('trakt', trakt.deviceAuth)),
      hint: 'Saisis le code sur cette URL, puis redemarre l\'addon pour activer la rangee de recommandations.',
    });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

app.post('/trakt/push', async (req, res) => {
  const dryRun = req.query.dryRun === '1' || req.query.dryRun === 'true';
  try {
    const summary = await pushToTrakt({ dryRun });
    res.status(summary.ok ? 200 : 400).json(summary);
  } catch (err) {
    console.error(`[trakt-push] echec: ${err.message}`);
    res.status(502).json({ ok: false, error: err.message, status: err.status, body: err.body });
  }
});

// --- Hub de synchronisation ----------------------------------------------
// Declenchement manuel d'un cycle (le hub tourne aussi en boucle si HUB_ENABLED).
app.post('/hub/sync', async (req, res) => {
  const dryRun = req.query.dryRun === '1' || req.query.dryRun === 'true';
  try {
    const summary = await hub.runCycle({ dryRun });
    res.status(summary.ok === false ? 400 : 200).json(summary);
  } catch (err) {
    console.error(`[hub] echec: ${err.message}`);
    res.status(502).json({ ok: false, error: err.message });
  }
});

app.get('/hub/status', (_req, res) => res.json(hub.status()));

// --- Simkl ---------------------------------------------------------------
// Meme principe que Trakt, sans la limite d'une seule application connectee.
app.post('/simkl/auth', async (_req, res) => {
  try {
    res.json(await startCodeAuth('simkl', simkl.pinAuth));
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

app.post('/simkl/push', async (req, res) => {
  const dryRun = req.query.dryRun === '1' || req.query.dryRun === 'true';
  try {
    const summary = await pushToSimkl({ dryRun });
    res.status(summary.ok ? 200 : 400).json(summary);
  } catch (err) {
    console.error(`[simkl-push] echec: ${err.message}`);
    res.status(502).json({ ok: false, error: err.message, status: err.status, body: err.body });
  }
});

// Repart de zero: oublie la copie locale de Simkl (et les titres qu'il n'avait pas su
// identifier), puis la relit en entier. Une lecture complete, donc a garder pour les cas
// ou le cache est suspect -- la doc Simkl reserve ce genre de lecture a la premiere synchro.
app.post('/simkl/resync', async (_req, res) => {
  try {
    simklLibrary.reset();
    const ok = await simklLibrary.sync({ force: true });
    res.status(ok ? 200 : 502).json({ ok, simkl: simkl.status() });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

app.get('/simkl/status', (_req, res) => res.json(simkl.status()));

app.get('/health', async (_req, res) => {
  res.json({
    ok: true,
    mainApi: config.MAIN_API_BASE_URL || null,
    vipKeyConfigured: !!config.VIP_ACCESS_KEY,
    // Sans VIP, Movix ne resout plus aucun flux: c'est le premier point a verifier quand
    // la liste de streams est vide.
    serverResolve: resolvedSources.enabled(),
    subtitlesEnabled: config.SUBTITLES_ENABLED,
    subtitleAutosync: config.SUBTITLE_AUTOSYNC && (await subsync.enabled()),
    publicUrl: config.PUBLIC_URL || null,
    streamProxy: {
      enabled: config.STREAM_PROXY_ENABLED,
      baseUrl: streamProxy.publicBase(),
      secretConfigured: !!config.STREAM_PROXY_SECRET,
    },
    addons: addons.describe().filter((a) => a.enabled).map((a) => a.id),
    traktAuthenticated: trakt.isAuthenticated(),
    simklAuthenticated: simkl.isAuthenticated(),
    simkl: simkl.status(),
  });
});

// --- TV en direct ---------------------------------------------------------
// Ces ressources sont servies AVANT le routeur du SDK, et volontairement hors de lui:
// `addonBuilder` fige son manifest au demarrage, alors que la liste des catalogues Live TV
// est fournie par Movix et change en cours de route (les rangees "rencontres" suivent les
// matchs en cours). Un manifest construit a chaque requete est la seule facon de la
// refleter sans redemarrer l'addon.
//
// Le SDK garde tout le reste (films, series, sous-titres): ces routes-la ne repondent que
// pour le type `tv`, et passent la main sinon.
function stremioExtra(raw) {
  // Stremio encode ses parametres optionnels dans le CHEMIN: `skip=100&genre=Sport`.
  const out = {};
  for (const pair of decodeURIComponent(raw || '').split('&')) {
    const [key, value] = pair.split('=');
    if (key && value !== undefined) out[key] = value;
  }
  return out;
}

app.get('/manifest.json', async (_req, res) => {
  const liveCatalogs = await livetv.catalogs();
  if (liveCatalogs.length === 0) return res.json(addonInterface.manifest);

  res.json({
    ...addonInterface.manifest,
    types: [...addonInterface.manifest.types, 'tv'],
    idPrefixes: [...(addonInterface.manifest.idPrefixes || []), livetv.ID_PREFIX],
    catalogs: [...addonInterface.manifest.catalogs, ...liveCatalogs],
  });
});

app.get('/catalog/tv/:catalogId.json', async (req, res, next) => {
  if (!livetv.enabled()) return next();
  const metas = await livetv.catalog(req.params.catalogId);
  res.json({ metas, cacheMaxAge: 60 });
});

app.get('/catalog/tv/:catalogId/:extra.json', async (req, res, next) => {
  if (!livetv.enabled()) return next();
  const { skip } = stremioExtra(req.params.extra);
  const metas = await livetv.catalog(req.params.catalogId, { skip: Number(skip) || 0 });
  res.json({ metas, cacheMaxAge: 60 });
});

app.get('/meta/tv/:id.json', async (req, res, next) => {
  if (!livetv.enabled() || !livetv.isLiveTvId(req.params.id)) return next();
  const meta = await livetv.meta(req.params.id);
  res.json({ meta: meta || null });
});

app.get('/stream/tv/:id.json', async (req, res, next) => {
  if (!livetv.enabled() || !livetv.isLiveTvId(req.params.id)) return next();
  const streams = await livetv.streams(req.params.id);
  // Pas de cache cote lecteur: une URL de direct tourne, et une reprise sur une URL
  // perimee echoue en silence.
  res.json({ streams, cacheMaxAge: 0 });
});

// Routes Stremio standard (manifest, catalog, meta, stream, subtitles).
app.use(getRouter(addonInterface));

app.listen(config.PORT, () => {
  console.log(`Movix addon (perso) demarre sur le port ${config.PORT} (toutes interfaces)`);
  console.log(`Manifest local : http://127.0.0.1:${config.PORT}/manifest.json`);
  if (config.PUBLIC_URL) console.log(`Manifest public : ${config.PUBLIC_URL}/manifest.json`);
  console.log(`Diagnostic     : /debug/movie/tmdb:157336  |  /debug/extract/movie/tmdb:157336  |  /debug/streams/...`);
  console.log(`                 /debug/subsync/movie/tmdb:157336?compute=1 (calage des sous-titres)`);
  console.log(`                 /debug/sync  |  /debug/addons  |  /health`);
  if (config.WEBUI_ENABLED) console.log(`WebUI          : http://127.0.0.1:${config.PORT}/ui/`);

  if (config.NUVIO_PUSH_INTERVAL_MS > 0 && config.NUVIO_EMAIL) {
    const minutes = Math.round(config.NUVIO_PUSH_INTERVAL_MS / 60000);
    console.log(`Push Nuvio Sync automatique toutes les ${minutes} min`);
    setInterval(() => {
      pushToNuvio().catch((err) => console.error(`[nuvio-push] push periodique echoue: ${err.message}`));
    }, config.NUVIO_PUSH_INTERVAL_MS).unref();
  }

  if (config.TRAKT_PUSH_INTERVAL_MS > 0 && trakt.isAuthenticated()) {
    const minutes = Math.round(config.TRAKT_PUSH_INTERVAL_MS / 60000);
    console.log(`Push Trakt automatique toutes les ${minutes} min`);
    setInterval(() => {
      pushToTrakt().catch((err) => console.error(`[trakt-push] push periodique echoue: ${err.message}`));
    }, config.TRAKT_PUSH_INTERVAL_MS).unref();
  }

  hub.start();

  if (config.SIMKL_PUSH_INTERVAL_MS > 0 && simkl.isAuthenticated()) {
    const minutes = Math.round(config.SIMKL_PUSH_INTERVAL_MS / 60000);
    console.log(`Push Simkl automatique toutes les ${minutes} min`);
    setInterval(() => {
      pushToSimkl().catch((err) => console.error(`[simkl-push] push periodique echoue: ${err.message}`));
    }, config.SIMKL_PUSH_INTERVAL_MS).unref();
  }
});
