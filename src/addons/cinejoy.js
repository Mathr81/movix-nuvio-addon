const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../core/config');
const log = require('../core/log');
const kit = require('./kit');
const tmdb = require('../integrations/tmdb');

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
 * serveur, l'empreinte TLS passe le filtrage de l'endpoint sans curl-impersonate. Aucune
 * dependance ni binaire externe.
 *
 * La reponse porte l'URL d'un master HLS (pistes video + audio en renditions separees) :
 * on la rend telle quelle au lecteur, qui gere l'adaptatif ET le son. `probe` lit les
 * variantes/BANDWIDTH du master pour l'affichage.
 *
 * Films ET series : seul le payload change (`/Lisbon/movie` vs `/Lisbon/series`, ce dernier
 * portant saison + episode).
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
  if (list.length) return list.map((s) => ({ url: s.playlist, id: s.id || s.type }));
  if (resp?.playlist) return [{ url: resp.playlist, id: 'primary' }];
  return [];
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

  const request = buildRequest({ type, tmdbId, season, episode, imdb, year: meta.year, title: meta.title });

  let resp;
  try {
    resp = await resolveSealed(request);
  } catch (err) {
    log.fail('Cinejoy', label, err);
    return [];
  }

  const playlists = playlistsOf(resp);
  if (playlists.length === 0) {
    log.ok('Cinejoy', label, `aucune playlist (status applicatif ${resp?.status ?? '?'})`);
    return [];
  }

  // Les segments du CDN sortent en clair, mais on rejoue quand meme l'Origin/Referer du
  // site via le proxy : certains CDN filtrent le hotlinking, et ca ne coute rien sinon.
  const headers = {
    accept: '*/*',
    'accept-language': kit.ACCEPT_LANGUAGE,
    origin: config.CINEJOY_ORIGIN,
    referer: `${config.CINEJOY_ORIGIN}/`,
    'user-agent': kit.BROWSER_UA,
  };

  const results = playlists.map((p) => ({
    url: kit.proxied(p.url, { headers }),
    direct: true,
    sourceName: 'Cinejoy',
    variant: playlists.length > 1 ? p.id : undefined,
    lang: config.CINEJOY_LANG || undefined,
  }));

  log.ok('Cinejoy', label, `${results.length} master(s) HLS pour "${meta.title || '?'}"`);
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
