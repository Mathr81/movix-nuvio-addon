const axios = require('axios');
const config = require('./config');
const cache = require('./cache');

/**
 * Mesure du debit d'un lien, pour l'afficher a cote de la resolution.
 *
 * Deux cas, deux methodes:
 *  - HLS: le master playlist annonce lui-meme un BANDWIDTH (et souvent une RESOLUTION)
 *    par variante. C'est la valeur exacte, gratuite, et elle donne au passage la vraie
 *    hauteur -- plus fiable qu'un libelle "HD" fourni par la source.
 *  - fichier direct: taille / duree. La taille vient d'un HEAD, la duree du runtime
 *    TMDB. C'est une estimation, mais elle classe correctement un 700 Mo d'un 4 Go.
 *
 * Tout est best-effort: un echec renvoie un objet vide et ne bloque jamais un stream.
 */
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function client() {
  return axios.create({
    timeout: config.PROBE_TIMEOUT_MS,
    headers: { 'User-Agent': DEFAULT_UA },
    // Un hoster peut repondre 403 sur HEAD tout en servant le GET: on gere nous-memes.
    validateStatus: () => true,
    maxRedirects: 5,
  });
}

/** `#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080` -> {bitrate, height}. */
function parseMaster(text) {
  const variants = [];
  const regex = /#EXT-X-STREAM-INF:([^\n]*)/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const attrs = match[1];
    const bandwidth = Number(/(?:^|,)BANDWIDTH=(\d+)/.exec(attrs)?.[1]);
    const resolution = /RESOLUTION=(\d+)x(\d+)/.exec(attrs);
    if (Number.isFinite(bandwidth) && bandwidth > 0) {
      variants.push({ bitrate: bandwidth, height: resolution ? Number(resolution[2]) : 0 });
    }
  }
  if (variants.length === 0) return null;

  // Le lecteur choisira la meilleure variante disponible: c'est celle-la qu'on annonce.
  return variants.reduce((best, v) => (v.bitrate > best.bitrate ? v : best));
}

async function probeHls(url) {
  const { status, data } = await client().get(url, { responseType: 'text' });
  if (status >= 400 || typeof data !== 'string') return {};
  if (!data.includes('#EXT-X-STREAM-INF')) return {}; // playlist de segments: rien a en tirer
  return parseMaster(data) || {};
}

async function probeFile(url, durationSeconds) {
  if (!durationSeconds) return {};

  const http = client();
  let length = 0;

  const head = await http.head(url);
  if (head.status < 400) length = Number(head.headers['content-length']) || 0;

  if (!length) {
    // Certains hosters refusent HEAD: un GET d'un seul octet donne la taille totale
    // via Content-Range sans telecharger le fichier.
    const ranged = await http.get(url, { headers: { Range: 'bytes=0-0' }, responseType: 'arraybuffer' });
    const contentRange = ranged.headers['content-range'];
    if (contentRange) length = Number(/\/(\d+)$/.exec(contentRange)?.[1]) || 0;
  }

  if (!length) return {};
  return { bitrate: Math.round((length * 8) / durationSeconds), estimated: true };
}

/** @returns {Promise<{bitrate?: number, height?: number, estimated?: boolean}>} */
async function probe(url, { durationSeconds } = {}) {
  if (!config.PROBE_BITRATE || !url) return {};

  return cache.wrap(`probe:${url}`, config.CACHE_TTL_MS, config.CACHE_EMPTY_TTL_MS, async () => {
    try {
      const isHls = /\.m3u8(\?|$)/i.test(url);
      return isHls ? await probeHls(url) : await probeFile(url, durationSeconds);
    } catch {
      return {};
    }
  });
}

function formatBitrate(bitsPerSecond) {
  if (!bitsPerSecond || bitsPerSecond <= 0) return null;
  const mbps = bitsPerSecond / 1e6;
  if (mbps >= 10) return `${Math.round(mbps)} Mb/s`;
  if (mbps >= 1) return `${mbps.toFixed(1)} Mb/s`;
  return `${Math.round(bitsPerSecond / 1000)} kb/s`;
}

module.exports = { probe, formatBitrate };
