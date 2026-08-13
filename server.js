const express = require('express');
const { getRouter } = require('stremio-addon-sdk');
const addonInterface = require('./src/addon');
const config = require('./src/config');
const { fetchAsVtt } = require('./src/subtitles');
const { resolveId } = require('./src/idResolver');
const { collectRawLinks } = require('./src/streamBuilder');
const { detectHoster } = require('./src/hosterExtract');

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
  console.log(`Diagnostic     : /debug/movie/tmdb:157336  |  /health`);
});
