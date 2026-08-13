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

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    mainApi: config.MAIN_API_BASE_URL || null,
    proxiesEmbed: config.PROXIES_EMBED_BASE_URL || null,
    vipKeyConfigured: !!config.VIP_ACCESS_KEY,
    subtitlesEnabled: config.SUBTITLES_ENABLED,
    publicUrl: config.PUBLIC_URL || null,
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
});
