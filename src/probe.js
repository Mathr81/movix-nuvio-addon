const axios = require('axios');
const config = require('./config');
const cache = require('./cache');

/**
 * Mesure du debit d'un lien, pour l'afficher a cote de la resolution.
 *
 * Trois cas, par ordre de fiabilite:
 *  - master HLS: il annonce lui-meme BANDWIDTH et RESOLUTION par variante. Exact.
 *  - playlist de segments (ce que renvoient la plupart des hosters extraits): pas de
 *    BANDWIDTH, mais on peut peser un segment et le diviser par sa duree EXTINF.
 *  - fichier direct: taille / duree. Faute de duree connue, on affiche au moins la taille.
 *
 * Le point dur est l'acces. Les CDN des hosters refusent tout ce qui ne vient pas de leur
 * page de lecture. Le site ne les joint pas davantage depuis le navigateur: il passe par
 * son proxy (`buildProxyUrl` -> `<PROXY>/proxy/<url>`, cf. src/config/runtime.ts:19), et
 * ce proxy pose les Origin/Referer attendus par domaine (cf. API/miscs/bypass403.py:120).
 * On fait pareil: tentative directe avec le referer de la page d'embed, puis repli par le
 * proxy si la mesure echoue.
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

/** Meme forme que buildProxyUrl cote site, et que la route /proxy/<path:target> de bypass403. */
function throughProxy(url) {
  const base = config.PROBE_PROXY_BASE_URL.replace(/\/+$/, '');
  return `${base}/proxy/${url}`;
}

/**
 * Un "acces": comment joindre une URL. En direct on ajoute le referer attendu; via le
 * proxy c'est lui qui s'en charge, et y ajouter les notres n'aurait aucun effet.
 */
function directAccess(refererUrl) {
  const origin = originOf(refererUrl);
  const http = axios.create({
    timeout: config.PROBE_TIMEOUT_MS,
    headers: { 'User-Agent': DEFAULT_UA, ...(origin ? { Referer: `${origin}/`, Origin: origin } : {}) },
    validateStatus: () => true,
    maxRedirects: 5,
  });
  return { http, resolve: (url) => url, label: 'direct' };
}

function proxyAccess() {
  const http = axios.create({
    timeout: config.PROBE_TIMEOUT_MS,
    headers: { 'User-Agent': DEFAULT_UA },
    validateStatus: () => true,
    maxRedirects: 5,
  });
  return { http, resolve: throughProxy, label: 'proxy' };
}

/** Taille d'une ressource, par HEAD puis, si refuse, par un GET d'un seul octet. */
async function byteLength(access, url) {
  const target = access.resolve(url);

  const head = await access.http.head(target);
  if (head.status < 400) {
    const length = Number(head.headers['content-length']);
    if (length > 0) return length;
  }

  // Le proxy du site retire Content-Length de ses reponses (bypass403.py:149), mais
  // laisse passer Content-Range: c'est cette voie qui fonctionne a travers lui.
  const ranged = await access.http.get(target, { headers: { Range: 'bytes=0-0' }, responseType: 'arraybuffer' });
  const contentRange = ranged.headers['content-range'];
  if (contentRange) return Number(/\/(\d+)$/.exec(contentRange)?.[1]) || 0;
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
 * Playlist de segments: on pese un segment et on le divise par sa duree EXTINF. Le
 * premier est souvent anormalement court (amorce, pub), d'ou le choix du plus long des
 * trois premiers.
 */
async function probeMediaPlaylist(access, url, text) {
  const entries = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length && entries.length < 3; i += 1) {
    const duration = Number(/^#EXTINF:([\d.]+)/.exec(lines[i].trim())?.[1]);
    if (!Number.isFinite(duration) || duration <= 0) continue;
    const next = lines[i + 1]?.trim();
    if (!next || next.startsWith('#')) continue;
    // Les URI de segments sont relatives a la playlist d'origine, pas a l'URL proxifiee.
    entries.push({ duration, uri: new URL(next, url).toString() });
  }
  if (entries.length === 0) return {};

  const target = entries.reduce((best, e) => (e.duration > best.duration ? e : best));
  const length = await byteLength(access, target.uri);
  if (!length) return {};
  return { bitrate: Math.round((length * 8) / target.duration), estimated: true };
}

async function probeHls(access, url) {
  const { status, data } = await access.http.get(access.resolve(url), { responseType: 'text' });
  if (status >= 400 || typeof data !== 'string') return {};
  if (data.includes('#EXT-X-STREAM-INF')) return parseMaster(data) || {};
  if (data.includes('#EXTINF')) return probeMediaPlaylist(access, url, data);
  return {};
}

async function probeFile(access, url, durationSeconds) {
  const length = await byteLength(access, url);
  if (!length) return {};
  // Sans duree (episode dont TMDB ignore le runtime), la taille reste comparable d'un
  // lien a l'autre: on la remonte plutot que de ne rien afficher.
  if (!durationSeconds) return { bytes: length };
  return { bitrate: Math.round((length * 8) / durationSeconds), bytes: length, estimated: true };
}

async function attempt(access, url, durationSeconds) {
  const isHls = /\.m3u8(\?|$)/i.test(url);
  return isHls ? probeHls(access, url) : probeFile(access, url, durationSeconds);
}

/**
 * @param {string} url URL du media a mesurer
 * @param {{durationSeconds?: number, refererUrl?: string}} options
 *        refererUrl = page d'embed d'origine (voe.sx/...), pas le CDN: c'est elle que le
 *        hoster attend en Referer, et l'origine du CDN ne suffit pas.
 * @returns {Promise<{bitrate?, height?, bytes?, estimated?}>}
 */
async function probe(url, { durationSeconds, refererUrl } = {}) {
  if (!config.PROBE_BITRATE || !url) return {};

  return cache.wrap(`probe:${url}`, config.CACHE_TTL_MS, config.CACHE_EMPTY_TTL_MS, async () => {
    const accesses = [directAccess(refererUrl || url)];
    if (config.PROBE_PROXY_BASE_URL) accesses.push(proxyAccess());

    for (const access of accesses) {
      try {
        const result = await attempt(access, url, durationSeconds);
        if (result && Object.keys(result).length > 0) return result;
      } catch (err) {
        console.warn(`[probe] ${access.label} a echoue sur ${url.slice(0, 80)}: ${err.message}`);
      }
    }

    console.warn(
      `[probe] aucune mesure pour ${url.slice(0, 80)}` +
        (config.PROBE_PROXY_BASE_URL ? '' : ' -- renseigne PROBE_PROXY_BASE_URL pour passer par le proxy du site'),
    );
    return {};
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
