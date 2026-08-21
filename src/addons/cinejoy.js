const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../core/config');
const log = require('../core/log');
const kit = require('./kit');
const tmdb = require('../integrations/tmdb');
const streamProxy = require('../streaming/streamProxy');

/**
 * Cinejoy (cinejoy.to) -- source dont le client de scellement est un module WebAssembly
 * (crush.wasm), obtenu par retro-ingenierie. Le "canal scelle" lumen-gate-v2 fait
 * ECDH P-256 -> HKDF-SHA256 -> AES-256-GCM ; toute la crypto (cle serveur, salt, labels)
 * est embarquee dans le wasm, qu'on se contente de piloter :
 *
 *   seal_request(msg_ptr, msg_len, rnd_ptr, rnd_len, out_ptr, out_cap) -> len
 *   sortie = [prefixe 98 o : K_reponse(32) | 0x01 | ephPub(65)] | [corps reseau]
 *   corps reseau = 02 01 | ephPub(65) | iv(12) | ct+tag
 *   reponse chiffree = AES-256-GCM(K = prefixe[0:32], iv = resp[0:12],
 *                                  aad = "lumen-gate-v2\0" | 02 01 | ephPub)  (81 o)
 *
 * Contrairement au CLI de RE (playground), le POST part en `fetch` natif : depuis un
 * serveur, l'empreinte TLS passe le filtrage de l'endpoint sans curl-impersonate.
 *
 * La reponse porte l'URL d'un master HLS. Ses variantes video sont MUETTES (l'audio est une
 * rendition separee, `EXT-X-MEDIA:TYPE=AUDIO`). Pour offrir un vrai selecteur de qualite
 * cote Nuvio, on rend UNE entree par palier : chacune est un mini-master reconstruit
 * (la variante choisie + les pistes audio), servi par le proxy en playlist synthetique. Le
 * lecteur garde ainsi le son a la qualite exacte demandee.
 *
 * Films ET series : seul le payload change (`/Lisbon/movie` vs `/Lisbon/series`).
 */

// --- Scellement (crush.wasm) ----------------------------------------------
const WASM_PATH = path.join(__dirname, 'vendor', 'crush.wasm');
const VERSION = Buffer.from([0x02, 0x01]);
const AAD_LABEL = Buffer.from('lumen-gate-v2\0', 'binary');
const PREFIX_LEN = 32 + 1 + 65; // K_reponse(32) | flag(1) | ephPub(65)

let wasmModule = null;
try {
  wasmModule = new WebAssembly.Module(fs.readFileSync(WASM_PATH));
} catch (err) {
  console.warn(`[cinejoy] crush.wasm illisible (${err.message}) -- source desactivee`);
}

function sealRequest(plaintext) {
  const ex = new WebAssembly.Instance(wasmModule, {}).exports;
  const mem = () => new Uint8Array(ex.memory.buffer);
  const msgP = ex.alloc(plaintext.length);
  mem().set(plaintext, msgP);
  const rnd = crypto.randomBytes(64); // >= 44 o d'alea (cle ephemere + nonce)
  const rndP = ex.alloc(rnd.length);
  mem().set(rnd, rndP);
  const cap = plaintext.length + 256;
  const outP = ex.alloc(cap);
  const ret = ex.seal_request(msgP, plaintext.length, rndP, rnd.length, outP, cap);
  if (ret < 0) throw new Error(`seal_request a echoue (code ${ret})`);
  const whole = Buffer.from(mem().slice(outP, outP + ret));
  const wire = whole.subarray(PREFIX_LEN);
  if (wire[0] !== 0x02 || wire[1] !== 0x01 || wire[2] !== 0x04) {
    throw new Error(`corps reseau inattendu: ${wire.subarray(0, 3).toString('hex')}`);
  }
  return { wire, kResp: whole.subarray(0, 32), ephPub: wire.subarray(2, 67) };
}

function gcmOpen(key, iv, blob, aad) {
  const tag = blob.subarray(blob.length - 16);
  const data = blob.subarray(0, blob.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  if (aad && aad.length) decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

async function resolveSealed(requestObj) {
  const plaintext = Buffer.from(JSON.stringify(requestObj));
  const { wire, kResp, ephPub } = sealRequest(plaintext);
  const res = await fetch(config.CINEJOY_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain;charset=UTF-8',
      Origin: config.CINEJOY_ORIGIN,
      Referer: `${config.CINEJOY_ORIGIN}/`,
    },
    body: wire,
    signal: AbortSignal.timeout(config.CINEJOY_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  let resp = Buffer.from(await res.arrayBuffer());
  if (resp[0] === 0x02 && resp[1] === 0x01) resp = resp.subarray(2);
  const aad = Buffer.concat([AAD_LABEL, VERSION, ephPub]); // 81 octets
  const plain = gcmOpen(kResp, resp.subarray(0, 12), resp.subarray(12), aad).toString('utf8');
  return JSON.parse(plain);
}

// --- Master HLS -> mini-masters par qualite -------------------------------
/** Reecrit `URI="..."` en absolu par rapport a la base. */
function absMediaUri(line, base) {
  return line.replace(/URI="([^"]+)"/, (_, u) => `URI="${new URL(u, base).href}"`);
}

function parseMaster(text, base) {
  const lines = text.split(/\r?\n/);
  const header = lines.filter((l) => /^#EXTM3U|^#EXT-X-VERSION|^#EXT-X-INDEPENDENT-SEGMENTS/.test(l));
  const audio = lines.filter((l) => /^#EXT-X-MEDIA:/.test(l) && /TYPE=AUDIO/.test(l)).map((l) => absMediaUri(l, base));
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^#EXT-X-STREAM-INF:/.test(lines[i])) continue;
    const inf = lines[i];
    const uri = (lines[i + 1] || '').trim();
    if (!uri || uri.startsWith('#')) continue;
    const res = inf.match(/RESOLUTION=(\d+)x(\d+)/) || [];
    variants.push({
      inf,
      uri: new URL(uri, base).href,
      width: Number(res[1]) || 0,
      height: Number(res[2]) || 0,
      bw: Number((inf.match(/BANDWIDTH=(\d+)/) || [])[1] || 0),
    });
  }
  variants.sort((a, b) => b.height - a.height || b.bw - a.bw);
  return {
    header: header.length ? header : ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-INDEPENDENT-SEGMENTS'],
    audio,
    variants,
  };
}

function qualityLabel(v) {
  const name = v.height >= 2160 ? '4K' : v.height ? `${v.height}p` : '?';
  return `${name}${/VIDEO-RANGE=PQ|HDR/i.test(v.inf) ? ' HDR' : ''}`;
}

/** Mini-master : entete + toutes les pistes audio + la seule variante video choisie. */
function miniMaster(master, variant) {
  return [...master.header, ...master.audio, variant.inf, variant.uri, ''].join('\n');
}

// --- Addon -----------------------------------------------------------------
function buildRequest({ type, tmdbId, season, episode, imdb, year, title }) {
  const base = { tmdb: String(tmdbId), imdb: imdb || '', year: year || '', title: title || '' };
  if (type === 'series') {
    // L'ordre des cles compte : le JSON est chiffre tel quel. On respecte l'ordre observe
    // cote client (tmdb, season, episode, imdb, year, title).
    return {
      path: '/Lisbon/series',
      payload: { tmdb: base.tmdb, season: String(season), episode: String(episode), imdb: base.imdb, year: base.year, title: base.title },
    };
  }
  return { path: '/Lisbon/movie', payload: base };
}

function playlistsOf(resp) {
  const list = (resp?.data?.stream || []).filter((s) => s && s.playlist);
  if (list.length) return list.map((s) => s.playlist);
  if (resp?.playlist) return [resp.playlist];
  return [];
}

const proxyReady = () => config.STREAM_PROXY_ENABLED && !!config.PUBLIC_URL;

async function fetchMaster(url) {
  const res = await fetch(url, {
    headers: { accept: '*/*', referer: `${config.CINEJOY_ORIGIN}/`, origin: config.CINEJOY_ORIGIN },
    signal: AbortSignal.timeout(config.CINEJOY_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`master HTTP ${res.status}`);
  return res.text();
}

async function getStreams({ tmdbId, type, season, episode }) {
  if (!wasmModule) return [];
  if (type !== 'movie' && type !== 'series') return [];
  if (type === 'series' && (season == null || episode == null)) {
    log.ok('Cinejoy', tmdbId, 'serie sans saison/episode : rien a demander');
    return [];
  }

  const label = type === 'series' ? `${tmdbId} S${season}E${episode}` : String(tmdbId);
  const [meta, imdb] = await Promise.all([
    kit.titleOf(type, tmdbId).catch(() => ({ title: '', year: '' })),
    tmdb.getImdbId(type, tmdbId).catch(() => null),
  ]);

  let resp;
  try {
    resp = await resolveSealed(buildRequest({ type, tmdbId, season, episode, imdb, year: meta.year, title: meta.title }));
  } catch (err) {
    log.fail('Cinejoy', label, err);
    return [];
  }

  const masters = playlistsOf(resp);
  if (masters.length === 0) {
    log.ok('Cinejoy', label, `aucune playlist (status applicatif ${resp?.status ?? '?'})`);
    return [];
  }

  // Les segments sortent en clair, mais on rejoue quand meme l'Origin/Referer du site : ca
  // ne coute rien et couvre un eventuel filtrage anti-hotlinking du CDN.
  const headers = {
    accept: '*/*',
    'accept-language': kit.ACCEPT_LANGUAGE,
    origin: config.CINEJOY_ORIGIN,
    referer: `${config.CINEJOY_ORIGIN}/`,
    'user-agent': kit.BROWSER_UA,
  };

  // Sans proxy, on ne peut pas servir de mini-master : on rend le master brut (une entree,
  // le lecteur gere l'adaptatif et le son). Un log l'explique car le selecteur de qualite
  // par palier suppose le proxy actif.
  if (!proxyReady()) {
    log.ok('Cinejoy', label, 'proxy inactif -- master brut (pas de selecteur par palier)');
    return masters.map((url) => ({ url, direct: true, sourceName: 'Cinejoy', lang: config.CINEJOY_LANG || undefined }));
  }

  const results = [];
  for (const master of masters) {
    let parsed;
    try {
      parsed = parseMaster(await fetchMaster(master), master);
    } catch (err) {
      // Master illisible : on retombe sur l'URL brute plutot que de perdre la source.
      log.ok('Cinejoy', label, `master illisible (${err.message}) -- rendu brut`);
      results.push({ url: master, direct: true, sourceName: 'Cinejoy', lang: config.CINEJOY_LANG || undefined });
      continue;
    }
    for (const variant of parsed.variants) {
      const quality = qualityLabel(variant);
      results.push({
        // Playlist synthetique : la variante choisie + l'audio, servie par le proxy.
        url: streamProxy.proxyInlinePlaylist(miniMaster(parsed, variant), master, { headers }),
        direct: true,
        sourceName: 'Cinejoy',
        // Chaque palier est une entree distincte a conserver : `variant` empeche l'elagage
        // des redondants de n'en garder qu'une (il ne compare que des variantes egales).
        variant: quality,
        quality,
        lang: config.CINEJOY_LANG || undefined,
      });
    }
  }

  log.ok('Cinejoy', label, `${results.length} palier(s) pour "${meta.title || '?'}"`);
  return results;
}

module.exports = {
  id: 'cinejoy',
  name: 'Cinejoy',
  supports: { movie: true, series: true },
  available: () => !!wasmModule,
  getStreams,
  settings: () => ({
    endpoint: config.CINEJOY_ENDPOINT,
    origin: config.CINEJOY_ORIGIN,
    langue: config.CINEJOY_LANG,
    wasm: wasmModule ? 'charge' : 'absent',
  }),
};
