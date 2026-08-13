const express = require('express');
const { getRouter } = require('stremio-addon-sdk');
const addonInterface = require('./src/addon');
const config = require('./src/config');
const { fetchAsVtt } = require('./src/subtitles');
const { resolveId } = require('./src/idResolver');
const { collectRawLinks } = require('./src/streamBuilder');
const { detectHoster } = require('./src/hosterExtract');
const { mainApi } = require('./src/movixClient');
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
app.get('/subtitle.vtt', async (req, res) => {
  const src = req.query.src;
  if (!src || !/^https?:\/\//i.test(src)) {
    return res.status(400).type('text/plain').send('parametre "src" manquant ou invalide');
  }
  // Ne relayer que vers OpenSubtitles: sans cette borne, la route serait un proxy HTTP ouvert.
  let host;
  try {
    host = new URL(src).hostname;
  } catch {
    return res.status(400).type('text/plain').send('parametre "src" invalide');
  }
  if (!/(^|\.)opensubtitles\.org$/i.test(host)) {
    return res.status(403).type('text/plain').send('host non autorise');
  }

  try {
    const vtt = await fetchAsVtt(src);
    res.type('text/vtt').send(vtt);
  } catch (err) {
    console.error(`[subtitle.vtt] echec pour ${src}: ${err.message}`);
    res.status(502).type('text/plain').send('sous-titre indisponible');
  }
});

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
  console.log(`Diagnostic     : /debug/movie/tmdb:157336  |  /debug/sync  |  /health`);

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
