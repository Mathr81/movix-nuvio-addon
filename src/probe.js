const axios = require('axios');
const config = require('./config');
const cache = require('./cache');

/**
 * Mesure du debit d'un lien, pour l'afficher a cote de la resolution.
 *
 * Trois cas, par ordre de fiabilite:
 *  - master HLS: il annonce lui-meme BANDWIDTH et RESOLUTION par variante. Exact, et la
 *    hauteur qu'on y lit vaut mieux qu'un libelle "HD" fourni par la source.
 *  - playlist de segments (ce que renvoient la plupart des hosters une fois extraits):
 *    pas de BANDWIDTH, mais on peut peser un segment et le diviser par sa duree EXTINF.
 *  - fichier direct: taille / duree. Faute de duree connue, on affiche au moins la taille.
 *
 * Les hosters exigent presque tous un Referer de leur propre domaine: sans lui, HEAD et
 * GET repondent 403 et rien n'est mesurable. C'est la raison pour laquelle seul PurStream
 * (master HLS servi sans controle de referer) fonctionnait avant.
 *
 * Tout est best-effort: un echec renvoie un objet vide et ne bloque jamais un stream.
 */
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function client(url) {
  const origin = originOf(url);
  return axios.create({
    timeout: config.PROBE_TIMEOUT_MS,
    headers: {
      'User-Agent': DEFAULT_UA,
      // Le hoster attend le referer de sa propre page de lecture.
      ...(origin ? { Referer: `${origin}/`, Origin: origin } : {}),
    },
    validateStatus: () => true,
    maxRedirects: 5,
  });
}

/** Taille d'une ressource, par HEAD puis, si refuse, par un GET d'un seul octet. */
async function byteLength(url) {
  const http = client(url);

  const head = await http.head(url);
  if (head.status < 400) {
    const length = Number(head.headers['content-length']);
    if (length > 0) return length;
  }

  const ranged = await http.get(url, { headers: { Range: 'bytes=0-0' }, responseType: 'arraybuffer' });
  const contentRange = ranged.headers['content-range'];
  if (contentRange) return Number(/\/(\d+)$/.exec(contentRange)?.[1]) || 0;
  // Sans support des Range, un 200 complet expose quand meme la taille totale.
  if (ranged.status < 400) return Number(ranged.headers['content-length']) || 0;
  return 0;
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

/**
 * Playlist de segments: on pese le premier segment de taille significative et on le
 * divise par sa duree EXTINF. Le premier segment est parfois anormalement court (cle,
 * pub, amorce), d'ou le choix du plus long des trois premiers.
 */
async function probeMediaPlaylist(url, text) {
  const entries = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length && entries.length < 3; i += 1) {
    const duration = Number(/^#EXTINF:([\d.]+)/.exec(lines[i].trim())?.[1]);
    if (!Number.isFinite(duration) || duration <= 0) continue;
    const next = lines[i + 1]?.trim();
    if (!next || next.startsWith('#')) continue;
    entries.push({ duration, uri: new URL(next, url).toString() });
  }
  if (entries.length === 0) return {};

  const target = entries.reduce((best, e) => (e.duration > best.duration ? e : best));
  const length = await byteLength(target.uri);
  if (!length) return {};
  return { bitrate: Math.round((length * 8) / target.duration), estimated: true };
}

async function probeHls(url) {
  const { status, data } = await client(url).get(url, { responseType: 'text' });
  if (status >= 400 || typeof data !== 'string') return {};
  if (data.includes('#EXT-X-STREAM-INF')) return parseMaster(data) || {};
  if (data.includes('#EXTINF')) return probeMediaPlaylist(url, data);
  return {};
}

async function probeFile(url, durationSeconds) {
  const length = await byteLength(url);
  if (!length) return {};
  // Sans duree (episode dont TMDB ignore le runtime), la taille reste une information
  // utile pour comparer deux liens: on la remonte plutot que de ne rien afficher.
  if (!durationSeconds) return { bytes: length };
  return { bitrate: Math.round((length * 8) / durationSeconds), bytes: length, estimated: true };
}

/** @returns {Promise<{bitrate?, height?, bytes?, estimated?}>} */
async function probe(url, { durationSeconds } = {}) {
  if (!config.PROBE_BITRATE || !url) return {};

  return cache.wrap(`probe:${url}`, config.CACHE_TTL_MS, config.CACHE_EMPTY_TTL_MS, async () => {
    try {
      const isHls = /\.m3u8(\?|$)/i.test(url);
      const result = isHls ? await probeHls(url) : await probeFile(url, durationSeconds);
      if (!result || Object.keys(result).length === 0) {
        console.warn(`[probe] aucune mesure pour ${url.slice(0, 90)}`);
      }
      return result || {};
    } catch (err) {
      console.warn(`[probe] echec sur ${url.slice(0, 90)}: ${err.message}`);
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

function formatSize(bytes) {
  if (!bytes || bytes <= 0) return null;
  const gb = bytes / 1e9;
  return gb >= 1 ? `${gb.toFixed(1)} Go` : `${Math.round(bytes / 1e6)} Mo`;
}

module.exports = { probe, formatBitrate, formatSize };
