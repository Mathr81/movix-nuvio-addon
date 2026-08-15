const axios = require('axios');
const https = require('https');
const config = require('./config');
const cache = require('./cache');
const streamProxy = require('./streamProxy');

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

/**
 * En-tetes attendus par certains CDN, repris tels quels de la table du proxy du site
 * (API/miscs/bypass403.py:120). Ces domaines n'acceptent pas leur propre origine comme
 * referer: ils veulent celle du lecteur qui les integre.
 *
 * A noter: le proxy du site n'existe que pour contourner le CORS du navigateur. Depuis
 * Node il n'y a pas de CORS -- seuls comptent ces en-tetes, d'ou leur integration ici
 * plutot qu'un service a heberger.
 */
const HOSTER_HEADERS = [
  [/coflix/i, { Origin: 'https://movix.embedseek.com', Referer: 'https://movix.embedseek.com/' }],
  [/cinetacos/i, { Origin: 'https://cinepulse.to', Referer: 'https://cinepulse.to/' }],
  [/fsvid/i, { Referer: 'https://fs-miroir6.lol/' }],
  [/top-stream/i, { Origin: 'https://top-stream.plus', Referer: 'https://top-stream.plus/' }],
];

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** En-tetes pour joindre `url`, avec `refererUrl` (page d'embed) en valeur par defaut. */
function headersFor(url, refererUrl) {
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  })();

  const specific = HOSTER_HEADERS.find(([pattern]) => pattern.test(host));
  if (specific) return { 'User-Agent': DEFAULT_UA, ...specific[1] };

  const origin = originOf(refererUrl || url);
  return { 'User-Agent': DEFAULT_UA, ...(origin ? { Referer: `${origin}/`, Origin: origin } : {}) };
}

// Les CDN de hosters ont regulierement des certificats invalides; le proxy du site les
// ignore lui aussi (verify=False). Sans ca, la mesure echoue avant meme la requete.
const insecureAgent = new https.Agent({ rejectUnauthorized: false });

/** Meme forme que buildProxyUrl cote site, et que la route /proxy/<path:target> de bypass403. */
function throughProxy(url) {
  const base = config.PROBE_PROXY_BASE_URL.replace(/\/+$/, '');
  return `${base}/proxy/${url}`;
}

/**
 * Routes de proxy dediees, une par hebergeur, exposees par proxiesembed
 * (server.py:1491-1499). Chacune applique l'Origin/Referer/User-Agent et le Host que
 * SON CDN attend -- c'est par la que le site lit ces flux, jamais en direct.
 *
 * C'est la difference decisive avec un proxy generique: les en-tetes ne sont pas devines
 * depuis l'URL, ils sont ceux de la page de lecture officielle du service.
 */
const HOSTER_PROXY_ROUTE = {
  voe: 'voe-proxy',
  fsvid: 'fsvid-proxy',
  vidzy: 'vidzy-proxy',
  vidmoly: 'vidmoly-proxy',
  sibnet: 'sibnet-proxy',
  uqload: 'uqload-proxy',
  doodstream: 'doodstream-proxy',
  seekstreaming: 'seekstreaming-proxy',
};

function hosterProxyResolver(hoster) {
  const route = HOSTER_PROXY_ROUTE[String(hoster || '').toLowerCase()];
  if (!route || !config.PROXIES_EMBED_BASE_URL) return null;
  const base = config.PROXIES_EMBED_BASE_URL.replace(/\/+$/, '');
  return (url) => `${base}/${route}?url=${encodeURIComponent(url)}`;
}

/**
 * Un "acces": comment joindre une URL. En direct on ajoute le referer attendu; via le
 * proxy c'est lui qui s'en charge, et y ajouter les notres n'aurait aucun effet.
 */
function makeClient(headers) {
  return axios.create({
    timeout: config.PROBE_TIMEOUT_MS,
    headers,
    httpsAgent: insecureAgent,
    validateStatus: () => true,
    maxRedirects: 5,
  });
}

function directAccess(url, refererUrl) {
  // Les liens des addons pointent deja sur notre proxy, qui pose lui-meme les en-tetes
  // attendus: la sonde n'a qu'a le suivre, en restant sur la boucle locale.
  return { http: makeClient(headersFor(url, refererUrl)), resolve: (u) => streamProxy.localize(u), label: 'direct' };
}

/**
 * Acces AMONT: on court-circuite notre propre proxy et on joint le CDN directement, avec
 * les en-tetes que le proxy aurait rejoues.
 *
 * Mesurer a travers le proxy revenait a lui faire telecharger la playlist entiere puis a la
 * REECRIRE ligne par ligne (des centaines d'URI signees) pour n'en lire que les durees --
 * un travail dont la sonde n'a aucun usage, paye a chaque lien d'addon et a chaque ouverture
 * de fiche. C'est ce qui saturait le budget de 3,5 s et rendait ces liens systematiquement
 * "sans debit mesure".
 *
 * L'acces par le proxy reste en repli: si un CDN exige une transformation que seul le proxy
 * applique, la mesure repasse par lui.
 */
function upstreamAccess(url) {
  const target = streamProxy.targetOf(url);
  if (!target) return null;
  const headers = streamProxy.headersOf(url) || {};
  return {
    http: makeClient({ 'User-Agent': DEFAULT_UA, ...headers }),
    // On est deja sur l'amont: les URI enfants s'y resolvent telles quelles.
    resolve: (u) => u,
    entry: target,
    label: 'amont',
  };
}

function proxyAccess() {
  // Le proxy pose lui-meme les en-tetes: y ajouter les notres n'aurait aucun effet.
  return { http: makeClient({ 'User-Agent': DEFAULT_UA }), resolve: throughProxy, label: 'proxy' };
}

function hosterProxyAccess(hoster) {
  const resolve = hosterProxyResolver(hoster);
  if (!resolve) return null;
  return { http: makeClient({ 'User-Agent': DEFAULT_UA }), resolve, label: `${hoster}-proxy` };
}

// Garde-fou du dernier recours: on accepte de telecharger un segment pour le peser, jamais
// un film entier.
const FULL_GET_CAP_BYTES = 24 * 1024 * 1024;

/**
 * Taille d'une ressource: HEAD, puis GET d'un seul octet, puis -- pour un segment
 * seulement -- telechargement complet.
 *
 * Le piege est au deuxieme temps: un serveur qui HONORE `Range: bytes=0-0` repond 206 avec
 * `Content-Length: 1`. Prendre cette valeur pour la taille du segment donnait un debit
 * absurde (1 octet / 6 s), et c'est une des raisons pour lesquelles les valeurs affichees
 * paraissaient tirees au sort. Seul `Content-Range` porte la taille totale; sans lui, une
 * longueur de 1 ne veut rien dire.
 */
async function byteLength(access, url, { allowFullGet = false } = {}) {
  const target = access.resolve(url);

  const head = await access.http.head(target);
  if (head.status < 400) {
    const length = Number(head.headers['content-length']);
    if (length > 1) return length;
  }

  // Le proxy du site retire Content-Length de ses reponses (bypass403.py:149), mais
  // laisse passer Content-Range: c'est cette voie qui fonctionne a travers lui.
  //
  // En flux, et coupe des les en-tetes lus: un serveur qui IGNORE le Range commence a
  // envoyer le segment entier, et rien n'oblige a le telecharger pour apprendre sa taille.
  const ranged = await access.http.get(target, { headers: { Range: 'bytes=0-0' }, responseType: 'stream' });
  ranged.data?.destroy?.();

  const contentRange = ranged.headers['content-range'];
  if (contentRange) return Number(/\/(\d+)$/.exec(contentRange)?.[1]) || 0;
  if (ranged.status < 400) {
    // Range ignore (reponse 200): le Content-Length annonce alors la taille complete.
    const length = Number(ranged.headers['content-length']);
    if (length > 1) return length;
  }

  // Certains CDN refusent HEAD et ignorent Range sans annoncer de taille. Peser le segment
  // en le telechargeant reste alors la seule mesure possible -- quelques Mo, une fois, puis
  // le resultat est en cache.
  if (!allowFullGet) return 0;
  try {
    const full = await access.http.get(target, { responseType: 'arraybuffer', maxContentLength: FULL_GET_CAP_BYTES });
    return full.status < 400 ? Number(full.data?.byteLength) || 0 : 0;
  } catch (err) {
    console.warn(`[probe] pesee complete impossible sur ${String(url).slice(0, 80)}: ${err.message}`);
    return 0;
  }
}

/**
 * Variantes d'un master. `BANDWIDTH` est le debit de POINTE que le lecteur doit pouvoir
 * soutenir, pas le debit moyen du fichier: il depasse la moyenne reelle de 10 a 50%.
 * `AVERAGE-BANDWIDTH`, quand il est declare, est la vraie moyenne.
 *
 * Melanger les deux d'un lien a l'autre est precisement ce qui rendait la comparaison
 * incoherente: deux encodages identiques s'affichaient a 6 et 9 Mb/s selon que leur master
 * declarait l'un ou l'autre.
 */
function parseMaster(text) {
  const lines = text.split('\n');
  const variants = [];

  for (let i = 0; i < lines.length; i += 1) {
    const attrs = /^#EXT-X-STREAM-INF:(.*)$/.exec(lines[i].trim())?.[1];
    if (attrs === undefined) continue;

    // L'URI de la variante est la premiere ligne suivante qui ne soit ni vide ni une balise.
    let uri = null;
    for (let j = i + 1; j < lines.length; j += 1) {
      const candidate = lines[j].trim();
      if (!candidate) continue;
      if (!candidate.startsWith('#')) uri = candidate;
      break;
    }

    const resolution = /RESOLUTION=(\d+)x(\d+)/.exec(attrs);
    variants.push({
      peak: Number(/(?:^|,)BANDWIDTH=(\d+)/.exec(attrs)?.[1]) || 0,
      average: Number(/(?:^|,)AVERAGE-BANDWIDTH=(\d+)/.exec(attrs)?.[1]) || 0,
      height: resolution ? Number(resolution[2]) : 0,
      uri,
    });
  }

  if (variants.length === 0) return null;
  // Le lecteur ira sur la meilleure variante disponible: c'est elle qu'on decrit. La
  // resolution prime sur le debit -- un 720p tres compresse n'est pas "mieux" qu'un 1080p.
  return variants.reduce((best, v) => {
    if (v.height !== best.height) return v.height > best.height ? v : best;
    return (v.average || v.peak) > (best.average || best.peak) ? v : best;
  });
}

/** Segments d'une playlist, avec leur duree et, si la playlist l'annonce, leur taille. */
function collectSegments(text, baseUrl) {
  const segments = [];
  let duration = 0;
  let bytes = 0;

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF:')) {
      duration = Number(/^#EXTINF:([\d.]+)/.exec(line)?.[1]) || 0;
      continue;
    }
    // Playlist en byte-range: la taille du segment est ecrite noir sur blanc, aucune
    // requete n'est necessaire pour la connaitre.
    if (line.startsWith('#EXT-X-BYTERANGE:')) {
      bytes = Number(/:(\d+)/.exec(line)?.[1]) || 0;
      continue;
    }
    if (line.startsWith('#')) continue;

    // Les URI de segments sont relatives a la playlist d'origine, pas a l'URL proxifiee.
    if (duration > 0) segments.push({ duration, bytes, uri: new URL(line, baseUrl).toString() });
    duration = 0;
    bytes = 0;
  }
  return segments;
}

/**
 * Prelevements repartis sur toute la playlist.
 *
 * Un seul segment ne dit presque rien d'un encodage a debit variable: une scene fixe et une
 * poursuite peuvent varier du simple au triple. On ecarte le debut (amorce, logos, plan
 * noir -- systematiquement plus legers) et on echantillonne regulierement ensuite.
 */
function pickSamples(segments, count) {
  const pool = segments.length > count * 2 ? segments.slice(2) : segments;
  if (pool.length <= count) return pool;
  const step = pool.length / count;
  return Array.from({ length: count }, (_, i) => pool[Math.floor(i * step + step / 2)]);
}

async function probeMediaPlaylist(access, url, text) {
  const segments = collectSegments(text, url);
  if (segments.length === 0) return {};

  const picked = pickSamples(segments, Math.max(config.PROBE_SEGMENT_SAMPLES, 1));

  // D'abord les methodes gratuites (taille annoncee, HEAD, Range), en parallele: la mesure
  // coute alors un aller-retour, pas cinq.
  const sizes = await Promise.all(
    picked.map((segment) =>
      segment.bytes ? Promise.resolve(segment.bytes) : byteLength(access, segment.uri).catch(() => 0),
    ),
  );

  let measured = picked.map((segment, i) => ({ ...segment, bytes: sizes[i] })).filter((s) => s.bytes > 0);

  // Aucune n'a abouti: ce CDN n'annonce pas ses tailles. Peser un segment en le
  // telechargeant reste possible, mais on s'en tient a UN seul -- la precision d'un
  // echantillonnage large ne vaut pas plusieurs dizaines de Mo tires a chaque ouverture
  // de fiche.
  if (measured.length === 0) {
    const middle = picked[Math.floor(picked.length / 2)];
    const bytes = await byteLength(access, middle.uri, { allowFullGet: true }).catch(() => 0);
    if (bytes > 0) measured = [{ ...middle, bytes }];
  }

  if (measured.length === 0) return {};

  const bytes = measured.reduce((total, s) => total + s.bytes, 0);
  const seconds = measured.reduce((total, s) => total + s.duration, 0);
  if (seconds <= 0) return {};

  return { bitrate: Math.round((bytes * 8) / seconds), estimated: true, samples: measured.length };
}

/**
 * @param {number} depth garde-fou contre une chaine de masters qui se referenceraient
 *        mutuellement (vu sur certains CDN mal configures).
 */
async function probeHls(access, url, depth = 0) {
  const { status, data } = await access.http.get(access.resolve(url), { responseType: 'text' });
  if (status >= 400 || typeof data !== 'string') return {};

  if (data.includes('#EXT-X-STREAM-INF')) {
    const best = parseMaster(data);
    if (!best) return {};

    // Valeur declaree ET moyenne: rien de mieux a esperer, on la prend telle quelle.
    if (best.average) return { bitrate: best.average, height: best.height };

    // Sinon on descend mesurer la variante: une moyenne calculee sur ses segments est
    // comparable aux autres liens, la ou un debit de pointe ne l'est pas.
    if (best.uri && depth < 2) {
      const measured = await probeHls(access, new URL(best.uri, url).toString(), depth + 1);
      if (measured.bitrate) return { ...measured, height: best.height || measured.height };
    }

    // Rien n'a pu etre mesure: le pic reste une indication, signalee comme approximative.
    return best.peak ? { bitrate: best.peak, height: best.height, estimated: true } : { height: best.height };
  }

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
  // Un lien d'addon est une URL de proxy: son extension ne dit plus rien du flux, c'est
  // celle de la cible qu'elle transporte qui compte. Le motif n'est pas ancre en fin
  // d'URL, car certaines cibles sont elles-memes des proxys HLS qui portent la vraie
  // playlist en parametre (.../m3u8-proxy?url=...master.m3u8&...).
  const isHls = /\.m3u8/i.test(streamProxy.targetOf(url) || url);
  return isHls ? probeHls(access, url) : probeFile(access, url, durationSeconds);
}

/**
 * @param {string} url URL du media a mesurer
 * @param {{durationSeconds?: number, refererUrl?: string}} options
 *        refererUrl = page d'embed d'origine (voe.sx/...), pas le CDN: c'est elle que le
 *        hoster attend en Referer, et l'origine du CDN ne suffit pas.
 * @returns {Promise<{bitrate?, height?, bytes?, estimated?}>}
 */
async function probe(url, { durationSeconds, refererUrl, hoster, deadline } = {}) {
  if (!config.PROBE_BITRATE || !url) return {};

  // Hors budget: on rend la main SANS passer par le cache. Mettre en cache un "aucune
  // mesure" du a un manque de temps le figerait pour CACHE_EMPTY_TTL_MS, et le lien
  // resterait sans debit pendant des minutes alors qu'il etait parfaitement mesurable.
  if (deadline && Date.now() > deadline) return {};

  return cache.wrap(`probe:${url}`, config.CACHE_TTL_MS, config.CACHE_EMPTY_TTL_MS, async () => {
    // Ordre volontaire: l'amont d'abord quand on le connait (aucun detour reseau), puis la
    // route dediee de l'hebergeur, puis le proxy -- du moins cher au plus cher.
    const accesses = [
      upstreamAccess(url),
      hosterProxyAccess(hoster),
      directAccess(url, refererUrl),
    ].filter(Boolean);
    if (config.PROBE_PROXY_BASE_URL) accesses.push(proxyAccess());

    for (const access of accesses) {
      // Un repli ne demarre plus une fois le budget epuise: c'est du temps ajoute a
      // l'ouverture de la fiche pour un resultat qui a deja echoue une fois.
      if (deadline && Date.now() > deadline) break;
      try {
        const result = await attempt(access, access.entry || url, durationSeconds);
        if (result && Object.keys(result).length > 0) return result;
      } catch (err) {
        console.warn(`[probe] ${access.label} a echoue sur ${url.slice(0, 80)}: ${err.message}`);
      }
    }

    console.warn(`[probe] aucune mesure pour ${url.slice(0, 80)}`);
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
