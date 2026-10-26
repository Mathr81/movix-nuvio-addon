const axios = require('axios');
const config = require('../core/config');
const log = require('../core/log');
const kit = require('./kit');
const tmdb = require('../integrations/tmdb');

/**
 * Movy (movy.sx) -- site Next.js dont l'API de flux (api.wecollege.net) sert du 4K, vite.
 * Retro-ingenierie du module "allServerProviders" de son bundle :
 *
 *   GET <api>/seed?mediaId=<tmdb>              -> {"seed":"<n>.<texte>","ttlMs":30000}
 *   GET <api>/<serveur>/sources?...&enc=2&seed -> base64url chiffre
 *
 * Le chiffrement est un flux maison (pas de cle embarquee) : un keystream derive de
 * (seed, tmdbId), XOR, et un magic "mvm1" en tete du clair. Le clair est le JSON
 * `{sources:[{quality,url}], subtitles, playlist}`.
 *
 * L'API est derriere Cloudflare, qui refuse l'IP du VPS : seed et sources passent par
 * MOVY_PROXY_URL (le tunnel NAS). Le CDN video, lui, se joint en direct mais exige le
 * Referer du site sur les playlists : le proxy de flux le rejoue.
 *
 * Serveurs : "miami" et "boise" (VO, "May have 4K" d'apres le site) sont les deux qui
 * montent au 2160p ; "paris" (VF) repondait "encoded source missing" en octobre 2026.
 */

const GOLD = 0x9e3779b9;

function mix(e) {
  e >>>= 0;
  e ^= e >>> 16;
  e = Math.imul(e, 0x85ebca6b) >>> 0;
  e ^= e >>> 13;
  e = Math.imul(e, 0xc2b2ae35) >>> 0;
  return (e ^ (e >>> 16)) >>> 0;
}

function rotl(e, a) {
  e >>>= 0;
  a &= 31;
  return a === 0 ? e : ((e << a) | (e >>> (32 - a))) >>> 0;
}

function fnv(text) {
  let a = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) a = Math.imul(a ^ text.charCodeAt(i), 0x1000193) >>> 0;
  return mix(a);
}

/** Portage fidele du dechiffreur du site (branches mortes RC4 retirees : jamais prises). */
function decrypt(b64, seed, mediaId) {
  const ct = Buffer.from(b64.trim().replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const slots = new Array(61).fill(undefined);
  let n = mix(fnv(seed) ^ mix((Number(mediaId) >>> 0) ^ GOLD));
  for (let e = 0; e < 8; e++) {
    const a = n % 61;
    n = rotl((n + GOLD) >>> 0, 7 + (7 & e));
    slots[a] = (n ^ mix(n)) >>> 0;
    n = mix((n + a) >>> 0);
  }
  let acc = mix(0xa5a5a5a5 ^ n);
  const out = Buffer.alloc(ct.length);
  for (let p = 0, ctr = 0; p < ct.length; ctr++) {
    const l = acc % 61;
    // Le site teste `l in slots` : un emplacement jamais ecrit ne participe pas au ET.
    const set = slots[l] !== undefined ? -1 : 0;
    const x = ((slots[l] || 0) ^ Math.imul(GOLD, ctr + 1)) >>> 0;
    let b = (((acc ^ x) >>> 0) | ((acc & x & set) >>> 0)) >>> 0;
    b = (rotl((b + acc) >>> 0, 31 & l) ^ rotl(acc, 31 & Math.imul(l, 7))) >>> 0;
    acc = mix((b + GOLD) >>> 0);
    slots[l] = acc;
    for (let k = 0; k < 4 && p < ct.length; k++, p++) out[p] = ct[p] ^ ((acc >>> (8 * k)) & 255);
  }
  if (out.subarray(0, 4).toString('latin1') !== 'mvm1') throw new Error('dechiffrement rate (seed ou format change)');
  return JSON.parse(out.subarray(4).toString('utf8'));
}

function proxyAgent() {
  if (!config.MOVY_PROXY_URL) return {};
  const { SocksProxyAgent } = require('socks-proxy-agent');
  const agent = new SocksProxyAgent(config.MOVY_PROXY_URL);
  return { httpAgent: agent, httpsAgent: agent, proxy: false };
}

const http = axios.create({
  baseURL: config.MOVY_API.replace(/\/+$/, ''),
  timeout: config.MOVY_TIMEOUT_MS,
  headers: { 'User-Agent': kit.BROWSER_UA, Referer: `${config.MOVY_ORIGIN}/`, Origin: config.MOVY_ORIGIN },
  responseType: 'text',
  // L'API renvoie ses erreurs en JSON sur un statut d'erreur : on veut lire le message.
  validateStatus: () => true,
  ...proxyAgent(),
});

async function fetchSources(server, params, tmdbId) {
  // Seed frais a chaque titre (~100 ms) : il expire en 30 s et un 401 obligerait a reessayer.
  const seedRes = await http.get('/seed', { params: { mediaId: tmdbId } });
  const seed = JSON.parse(seedRes.data || '{}').seed;
  if (!seed) throw new Error(`seed HTTP ${seedRes.status}`);
  const res = await http.get(`/${server}/sources`, { params: { ...params, enc: '2', seed } });
  const body = String(res.data || '');
  if (res.status !== 200 || body.startsWith('{')) {
    let message = body.slice(0, 120);
    try {
      message = JSON.parse(body).message || message;
    } catch {}
    throw new Error(`HTTP ${res.status}: ${message}`);
  }
  return decrypt(body, seed, tmdbId);
}

// A langue egale, la piste complete d'abord, SDH (bruitages en plus) ensuite.
const KIND_RANK = { '': 0, sdh: 1 };

/**
 * Pistes livrees avec le fichier ("eng", "kor (forced)", "chi (2)"...), donc calees par
 * construction. Une par langue: Nuvio n'affiche que le nom de la langue, deux "English"
 * seraient indiscernables. Les langues de SUBTITLE_LANGS passent devant.
 */
function toSubtitles(raw, headers) {
  const best = new Map();
  for (const sub of Array.isArray(raw) ? raw : []) {
    const [, lang, kind = ''] = /^([a-z]{3})(?:\s*\(([^)]*)\))?/i.exec(String(sub?.lang || '')) || [];
    // "forced" ne sous-titre que les passages en langue etrangere: affiche "Francais", il
    // passerait pour une piste complete.
    if (!lang || !sub.url || /forced/i.test(kind)) continue;
    const rank = KIND_RANK[kind.toLowerCase()] ?? 2;
    const code = lang.toLowerCase();
    if (!best.has(code) || rank < best.get(code).rank) best.set(code, { rank, url: sub.url });
  }
  const order = (code) => (config.SUBTITLE_LANGS.includes(code) ? config.SUBTITLE_LANGS.indexOf(code) : Infinity);
  return [...best]
    .sort(([a], [b]) => order(a) - order(b))
    // Le CDN exige le Referer du site, comme pour la video: le proxy de flux le rejoue.
    .map(([lang, { url }]) => ({ id: `movy-${lang}`, lang, url: kit.proxied(url, { headers }) }));
}

async function getStreams({ tmdbId, type, season, episode }) {
  if (type === 'series' && (season == null || episode == null)) return [];
  const label = type === 'series' ? `${tmdbId} S${season}E${episode}` : String(tmdbId);
  const [meta, imdb] = await Promise.all([
    kit.titleOf(type, tmdbId).catch(() => ({ originalTitle: '', year: '' })),
    tmdb.getImdbId(type, tmdbId).catch(() => null),
  ]);
  // Memes parametres que le site, titre doublement encode compris (encodeURIComponent
  // avant la serialisation de la query).
  const params = {
    title: encodeURIComponent(meta.originalTitle || meta.title || ''),
    mediaType: type === 'series' ? 'tv' : 'movie',
    year: meta.year || '',
    episodeId: type === 'series' ? episode : 1,
    seasonId: type === 'series' ? season : 1,
    tmdbId,
    imdbId: imdb || '',
  };

  const headers = { accept: '*/*', referer: `${config.MOVY_ORIGIN}/`, 'user-agent': kit.BROWSER_UA };
  // Interroges en parallele, mais lus dans l'ordre de MOVY_SERVERS : miami et boise servent
  // le meme fichier (meme id, /vd vs /vdb), on ne garde donc qu'un lien par qualite, celui
  // du premier serveur qui l'a -- le suivant ne sert que de repli.
  const answers = await Promise.all(
    config.MOVY_SERVERS.map((server) =>
      fetchSources(server, params, tmdbId).then(
        (data) => ({ server, sources: data.sources || [], subtitles: toSubtitles(data.subtitles, headers) }),
        (err) => {
          log.fail('Movy', `${label} (${server})`, err);
          return { server, sources: [], subtitles: [] };
        },
      ),
    ),
  );
  const byQuality = new Map();
  for (const { server, sources, subtitles } of answers) {
    for (const source of sources) {
      if (!source?.url || byQuality.has(source.quality)) continue;
      byQuality.set(source.quality, {
        url: kit.proxied(source.url, { headers }),
        direct: true,
        sourceName: 'Movy',
        player: server,
        // Chaque palier est garde (le plus haut passe devant au tri) : utile quand le debit
        // de la connexion ne suit pas la 4K.
        variant: source.quality,
        quality: source.quality,
        lang: config.MOVY_LANG || undefined,
        subtitles: subtitles.length > 0 ? subtitles : undefined,
      });
    }
  }
  const results = [...byQuality.values()];
  const langs = results[0]?.subtitles?.length || 0;
  log.ok('Movy', label, `${results.length} lien(s) sur ${config.MOVY_SERVERS.join(', ')}, ${langs} langue(s) de sous-titres`);
  return results;
}

module.exports = {
  id: 'movy',
  name: 'Movy',
  supports: { movie: true, series: true },
  getStreams,
  decrypt,
  toSubtitles,
  settings: () => ({
    api: config.MOVY_API,
    serveurs: config.MOVY_SERVERS,
    viaProxy: config.MOVY_PROXY_URL ? config.MOVY_PROXY_URL.replace(/\/\/[^@/]*@/, '//') : null,
    langue: config.MOVY_LANG,
  }),
};
