const express = require('express');
const { getRouter } = require('stremio-addon-sdk');
const addonInterface = require('./src/addon');
const config = require('./src/config');
const { fetchAsVtt } = require('./src/subtitles');
const { resolveId } = require('./src/idResolver');
const { collectRawLinks, resolveStreams, buildStreams } = require('./src/streamBuilder');
const { breakerState: probeBreakerState } = require('./src/probe');
const { detectHoster, extractDirectUrl, normalizeEmbedUrl, breakerState } = require('./src/hosterExtract');
const { mainApi } = require('./src/movixClient');
const streamProxy = require('./src/streamProxy');
const addons = require('./src/addons');
const { pushToNuvio } = require('./src/nuvioPush');
const { pushToTrakt } = require('./src/traktPush');
const trakt = require('./src/traktCloud');
const { pushToSimkl } = require('./src/simklPush');
const simkl = require('./src/simklCloud');
const hub = require('./src/hub');

const app = express();

// Stremio/Nuvio interrogent l'addon depuis n'importe quelle origine.
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  next();
});

// --- Proxy de sous-titres -------------------------------------------------
// OpenSubtitles sert des .gz contenant du .srt; Stremio/Nuvio attendent du .vtt lisible
// directement. On telecharge, decompresse, convertit et sert a la volee.
async function serveSubtitle(src, res) {
  if (!src || !/^https?:\/\//i.test(src)) {
    console.warn(`[subtitle] source manquante ou invalide: ${JSON.stringify(String(src || '').slice(0, 120))}`);
    return res.status(400).type('text/plain').send('source de sous-titre manquante ou invalide');
  }

  // Ne relayer que vers OpenSubtitles: sans cette borne, la route serait un proxy HTTP ouvert.
  let host;
  try {
    host = new URL(src).hostname;
  } catch {
    console.warn(`[subtitle] source illisible: ${src.slice(0, 120)}`);
    return res.status(400).type('text/plain').send('source de sous-titre invalide');
  }
  if (!/(^|\.)opensubtitles\.org$/i.test(host)) {
    console.warn(`[subtitle] host non autorise: ${host}`);
    return res.status(403).type('text/plain').send('host non autorise');
  }

  try {
    const vtt = await fetchAsVtt(src);
    return res.type('text/vtt').send(vtt);
  } catch (err) {
    console.error(`[subtitle] echec pour ${src.slice(0, 120)}: ${err.message}`);
    return res.status(502).type('text/plain').send('sous-titre indisponible');
  }
}

// Forme servie aux lecteurs: la source est encodee dans le CHEMIN et l'URL se termine
// par ".vtt". Rien a mal interpreter en route, et l'extension rassure les lecteurs qui la
// verifient -- contrairement au parametre de requete, qu'un intermediaire peut tronquer.
app.get('/subtitle/:payload', (req, res) => {
  const encoded = String(req.params.payload).replace(/\.vtt$/i, '');
  let src;
  try {
    src = Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    src = '';
  }
  return serveSubtitle(src, res);
});

// Ancienne forme (?src=), conservee pour les liens deja distribues a un client.
app.get('/subtitle.vtt', (req, res) => serveSubtitle(req.query.src, res));

// --- Proxy de flux --------------------------------------------------------
// Rejoue les en-tetes (Origin/Referer/User-Agent...) exiges par les CDN des addons, que
// Nuvio/Stremio ne savent pas poser eux-memes, et reecrit les playlists m3u8 pour que les
// segments repassent par ici. Les URLs sont signees: sans ca, la route serait un relais
// HTTP ouvert (meme precaution que /subtitle.vtt ci-dessus).
streamProxy.mount(app);

// --- Diagnostic -----------------------------------------------------------
// Montre ce que chaque source a reellement renvoye, avant extraction. Utile quand
// Nuvio affiche "aucun stream" sans qu'on sache quelle etape a lache.
app.get('/debug/:type/:id', async (req, res) => {
  try {
    const { type, id } = req.params;
    const { tmdbId, season, episode } = await resolveId(type, id);
    const raw = await collectRawLinks({ tmdbId, type, season, episode });

    res.json({
      tmdbId,
      type,
      season,
      episode,
      total: raw.length,
      links: raw.map((r) => ({
        source: r.sourceName,
        url: r.url,
        player: r.player,
        lang: r.lang,
        quality: r.quality,
        direct: !!r.direct,
        hoster: r.direct ? 'n/a (lien direct)' : detectHoster(r.url, r.player) || 'AUCUN EXTRACTEUR',
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Diagnostic de l'extraction: ce que chaque embed est devenu, et pourquoi.
// Montre l'URL reellement envoyee au service (apres normalisation du domaine) et le
// message d'erreur qu'il a rendu -- "Invalid URL" designe un domaine refuse, pas un
// extracteur manquant, et ces deux causes sont indiscernables dans la liste de streams.
app.get('/debug/extract/:type/:id', async (req, res) => {
  try {
    const { type, id } = req.params;
    const { tmdbId, season, episode } = await resolveId(type, id);
    const raw = await collectRawLinks({ tmdbId, type, season, episode });
    const embeds = raw.filter((r) => !r.direct && r.url);

    const results = await Promise.all(
      embeds.map(async (item) => {
        const hoster = detectHoster(item.url, item.player);
        if (!hoster) {
          return { source: item.sourceName, url: item.url, hoster: null, issue: 'aucun extracteur' };
        }
        const outcome = await extractDirectUrl(item.url, item.player);
        return {
          source: item.sourceName,
          hoster,
          url: item.url,
          urlEnvoyee: normalizeEmbedUrl(hoster, item.url),
          ok: outcome.ok,
          resultat: outcome.ok ? outcome.url : undefined,
          issue: outcome.ok ? undefined : `${outcome.reason}${outcome.status ? ` (${outcome.status})` : ''}`,
          erreurService: outcome.error,
        };
      }),
    );

    res.json({
      tmdbId,
      total: embeds.length,
      extraits: results.filter((r) => r.ok).length,
      // Hebergeurs momentanement ecartes: sans ca, un "0/3" ressemble a une extraction
      // ratee alors qu'aucune requete n'a ete envoyee.
      ecartes: breakerState(),
      parHebergeur: Object.fromEntries(
        [...new Set(results.map((r) => r.hoster || 'inconnu'))].map((h) => [
          h,
          `${results.filter((r) => r.hoster === h && r.ok).length}/${results.filter((r) => r.hoster === h).length}`,
        ]),
      ),
      liens: results,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Diagnostic de la mesure de debit: ce que la sonde a REELLEMENT obtenu par lien, avant
// mise en forme. C'est la difference entre "aucune mesure" et "mesure aberrante", que le
// libelle affiche dans Nuvio ne permet plus de distinguer.
app.get('/debug/streams/:type/:id', async (req, res) => {
  try {
    const { type, id } = req.params;
    const { tmdbId, season, episode } = await resolveId(type, id);
    // `wait`: on veut l'etat FINAL des mesures, pas celui de la premiere reponse.
    const resolved = await resolveStreams({ tmdbId, type, season, episode, wait: true });

    res.json({
      tmdbId,
      type,
      // Cette liste montre TOUT ce qui a ete resolu; le mode compact en masque une partie
      // a l'affichage. Donner les deux nombres evite de croire a une source perdue.
      mode: config.STREAM_LIST,
      total: resolved.length,
      affichesDansNuvio: (await buildStreams({ tmdbId, type, season, episode })).length,
      // Voies de mesure momentanement ecartees (un service qui ne repond plus).
      ecartes: probeBreakerState(),
      streams: resolved.map((r) => ({
        source: r.sourceName,
        proxifie: streamProxy.isProxied(r.url),
        cible: streamProxy.targetOf(r.url) || r.url,
        qualiteAnnoncee: r.quality || null,
        // La resolution telle que le master l'annonce, et le palier qui en decoule. Un film
        // en scope (1920x800) doit sortir en 1080p: c'est la largeur qui le dit.
        resolution: r.width && r.height ? `${r.width}x${r.height}` : r.height || null,
        palier: r.tier || null,
        hauteurRetenue: r.height || null,
        debitBps: r.bitrate || null,
        // "declare" = lu dans le master HLS (AVERAGE-BANDWIDTH), "mesure" = calcule sur des
        // segments peses, "aucun" = la sonde n'a rien pu obtenir.
        origineDebit: r.bitrate ? (r.bitrateEstimated ? 'mesure' : 'declare') : 'aucun',
        segmentsPeses: r.bitrateSamples || null,
        tailleOctets: r.bytes || null,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

// --- Trakt ---------------------------------------------------------------
// Autorisation par device code: la reponse renvoie immediatement le code a saisir,
// l'attente de validation se poursuit cote serveur (elle peut durer plusieurs minutes).
app.post('/trakt/auth', async (_req, res) => {
  try {
    const started = await new Promise((resolve, reject) => {
      const done = trakt.deviceAuth({ onCode: (device) => resolve(device) });
      done.catch(reject);
      done.then(() => console.log('[trakt] autorisation terminee'), () => {});
    });
    res.json({
      ok: true,
      code: started.user_code,
      url: started.verification_url,
      expiresInSeconds: started.expires_in,
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
    const started = await new Promise((resolve, reject) => {
      const done = simkl.pinAuth({ onCode: (device) => resolve(device) });
      done.catch(reject);
      done.then(() => console.log('[simkl] autorisation terminee'), () => {});
    });
    res.json({ ok: true, code: started.user_code, url: started.verification_url, expiresInSeconds: started.expires_in });
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

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    mainApi: config.MAIN_API_BASE_URL || null,
    proxiesEmbed: config.PROXIES_EMBED_BASE_URL || null,
    vipKeyConfigured: !!config.VIP_ACCESS_KEY,
    subtitlesEnabled: config.SUBTITLES_ENABLED,
    publicUrl: config.PUBLIC_URL || null,
    streamProxy: {
      enabled: config.STREAM_PROXY_ENABLED,
      baseUrl: streamProxy.publicBase(),
      secretConfigured: !!config.STREAM_PROXY_SECRET,
    },
    addons: addons.describe().filter((a) => a.enabled).map((a) => a.id),
    traktAuthenticated: trakt.isAuthenticated(),
    simklAuthenticated: simkl.isAuthenticated(),
  });
});

// Routes Stremio standard (manifest, catalog, meta, stream, subtitles).
app.use(getRouter(addonInterface));

app.listen(config.PORT, () => {
  console.log(`Movix addon (perso) demarre sur le port ${config.PORT} (toutes interfaces)`);
  console.log(`Manifest local : http://127.0.0.1:${config.PORT}/manifest.json`);
  if (config.PUBLIC_URL) console.log(`Manifest public : ${config.PUBLIC_URL}/manifest.json`);
  console.log(`Diagnostic     : /debug/movie/tmdb:157336  |  /debug/extract/movie/tmdb:157336  |  /debug/streams/...`);
  console.log(`                 /debug/sync  |  /debug/addons  |  /health`);

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
