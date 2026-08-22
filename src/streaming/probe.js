const { execFile } = require('child_process');
const axios = require('axios');
const https = require('https');
const config = require('../core/config');
const cache = require('../core/cache');
const streamProxy = require('./streamProxy');
const breaker = require('../core/breaker');

/**
 * Mesure du debit d'un lien, pour l'afficher a cote de la resolution.
 *
 * Trois cas, par ordre de fiabilite:
 *  - master HLS: il annonce lui-meme BANDWIDTH et RESOLUTION par variante. Exact.
 *  - playlist de segments (ce que renvoient la plupart des hosters extraits): pas de
 *    BANDWIDTH, mais on peut peser un segment et le diviser par sa duree EXTINF.
 *  - fichier direct: taille / duree. Faute de duree connue, on affiche au moins la taille.
 *
 * La DEFINITION suit le meme escalier: declaree (RESOLUTION), sinon deduite du libelle de la
 * variante ou de son chemin, sinon lue dans le flux par ffprobe. Sans ce dernier etage, une
 * playlist de segments sans master au-dessus d'elle -- la forme que servent les flux KissKH --
 * s'affiche avec son debit et aucune definition, faute que quiconque l'ait ecrite.
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

// Le proxy d'un hebergeur peut ne plus repondre (vidzy-proxy est regulierement au-dela des
// 3,5 s): chaque lien de cet hebergeur repayait alors le timeout, puis celui du repli.
const probeBreaker = breaker.create({
  streak: () => config.HOSTER_FAILURE_STREAK,
  cooldownMs: () => config.HOSTER_COOLDOWN_MS,
  label: 'probe',
});

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
    // Marque les requetes de la sonde. Quand un repli la fait passer par NOTRE proxy, celui-ci
    // ne doit pas les confondre avec le debut d'une lecture: il declencherait le calage des
    // sous-titres de chaque lien de la liste, pour des flux que personne ne regarde
    // (cf. streaming/playback.js).
    headers: { ...headers, 'X-Movix-Probe': '1' },
    httpsAgent: insecureAgent,
    validateStatus: () => true,
    maxRedirects: 5,
  });
}

function directAccess(url, refererUrl) {
  // Les liens des addons pointent deja sur notre proxy, qui pose lui-meme les en-tetes
  // attendus: la sonde n'a qu'a le suivre, en restant sur la boucle locale.
  const headers = headersFor(url, refererUrl);
  return { http: makeClient(headers), resolve: (u) => streamProxy.localize(u), headers, label: 'direct' };
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
  // Playlist synthetique (mini-master d'un addon): elle n'a pas de cible amont, son corps
  // EST le lien. On peut malgre tout court-circuiter le proxy: ses URI enfants pointent
  // deja sur le CDN, et les en-tetes a rejouer voyagent avec elle.
  const inline = streamProxy.inlineOf(url);
  const target = inline ? null : streamProxy.targetOf(url);
  if (!inline && !target) return null;

  const headers = streamProxy.headersOf(url) || {};
  return {
    http: makeClient({ 'User-Agent': DEFAULT_UA, ...headers }),
    // On est deja sur l'amont: les URI enfants s'y resolvent telles quelles.
    resolve: (u) => u,
    ...(inline ? { inline } : { entry: target }),
    headers,
    label: inline ? 'amont (playlist fournie)' : 'amont',
  };
}

function proxyAccess() {
  // Le proxy pose lui-meme les en-tetes: y ajouter les notres n'aurait aucun effet.
  return { http: makeClient({ 'User-Agent': DEFAULT_UA }), resolve: throughProxy, label: 'proxy', service: 'proxy' };
}

function hosterProxyAccess(hoster) {
  const resolve = hosterProxyResolver(hoster);
  if (!resolve) return null;
  // `service`: cette voie est un service PARTAGE par tous les liens de l'hebergeur. Quand
  // il ne repond plus, il ne repond plus pour aucun -- d'ou le disjoncteur. Les acces
  // "amont" et "direct", eux, visent chacun un CDN different: generaliser n'aurait aucun
  // sens.
  return { http: makeClient({ 'User-Agent': DEFAULT_UA }), resolve, label: `${hoster}-proxy`, service: `${hoster}-proxy` };
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
 * Definitions usuelles. Sert de garde-fou aux DEDUCTIONS de resolution: sans elle, un jeton
 * signe ou un horodatage dans un chemin (".../1057/", ".../seg240.ts") passerait pour une
 * definition. Un nombre n'est lu comme une hauteur que s'il en est une.
 */
const COMMON_HEIGHTS = [2160, 1440, 1080, 720, 576, 480, 360, 240, 144];

/**
 * Resolution d'une variante qui ne la DECLARE pas.
 *
 * `RESOLUTION` est facultatif dans la specification HLS et beaucoup de CDN l'omettent --
 * c'est le cas des flux KissKH, qui s'affichaient donc sans definition alors que leur debit,
 * lui, etait bien mesure. L'information existe pourtant: elle est ecrite dans le libelle de
 * la variante (NAME="1080p") ou dans le chemin de son URI (.../1080p/index.m3u8).
 *
 * C'est une deduction, pas une mesure: on ne l'utilise qu'a defaut de RESOLUTION, et faute
 * de deduction c'est ffprobe qui tranche (cf. `resolutionOf`).
 */
function guessResolution(attrs, uri) {
  const text = `${/NAME="([^"]*)"/.exec(String(attrs || ''))?.[1] || ''} ${uri || ''}`;

  // "1920x1080" ecrit tel quel: les deux dimensions d'un coup, aucune ambiguite.
  const pair = /(\d{3,4})\s*[xX]\s*(\d{3,4})/.exec(text);
  if (pair && COMMON_HEIGHTS.includes(Number(pair[2]))) {
    return { width: Number(pair[1]), height: Number(pair[2]) };
  }
  if (/(^|[^a-z0-9])(4k|uhd)([^a-z0-9]|$)/i.test(text)) return { width: 0, height: 2160 };

  // Forme suffixee ("720p"): explicite, on accepte toutes les definitions usuelles.
  const suffixed = [...text.matchAll(/(?:^|[^\d])(\d{3,4})[pP](?:[^\d]|$)/g)]
    .map((m) => Number(m[1]))
    .filter((n) => COMMON_HEIGHTS.includes(n));
  if (suffixed.length > 0) return { width: 0, height: Math.max(...suffixed) };

  // Nombre nu (".../1080/"): plus fragile, donc limite aux hautes definitions -- un "240"
  // ou un "360" isole est bien plus souvent un compteur qu'une hauteur d'image.
  const bare = [...text.matchAll(/(?:^|[^\d])(\d{3,4})(?:[^\d]|$)/g)]
    .map((m) => Number(m[1]))
    .filter((n) => [2160, 1440, 1080, 720].includes(n));
  return bare.length > 0 ? { width: 0, height: Math.max(...bare) } : { width: 0, height: 0 };
}

/**
 * Piste audio SEPAREE que cette variante utilise, s'il y en a une.
 *
 * Certaines sources (Cinejoy) servent des variantes video MUETTES: le son est une rendition
 * a part. Peser les segments de la variante ne mesure alors que l'image, et un 720p Cinejoy
 * s'affichait 15% sous un 720p muxe de meme encodage -- un ecart qui fausse le classement
 * entre sources. On mesure donc aussi la piste audio pour l'ajouter.
 */
function audioRenditionOf(text, attrs) {
  const codecs = /CODECS="([^"]*)"/.exec(String(attrs || ''))?.[1] || '';
  // La variante porte deja son son: rien a ajouter.
  if (/mp4a|ac-3|ec-3|opus|vorbis|dts|flac/i.test(codecs)) return null;

  const group = /AUDIO="([^"]*)"/.exec(String(attrs || ''))?.[1];
  if (!group) return null;

  const medias = text.split('\n').filter((l) => /^#EXT-X-MEDIA:/.test(l.trim()) && /TYPE=AUDIO/.test(l));
  const mine = medias.filter((l) => l.includes(`GROUP-ID="${group}"`));
  // A defaut de piste marquee par defaut, la premiere du groupe: elles ne different que par
  // la langue, pas par le debit.
  const chosen = mine.find((l) => /DEFAULT=YES/i.test(l)) || mine[0];
  return chosen ? /URI="([^"]+)"/.exec(chosen)?.[1] || null : null;
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
    const guessed = resolution ? null : guessResolution(attrs, uri);
    variants.push({
      peak: Number(/(?:^|,)BANDWIDTH=(\d+)/.exec(attrs)?.[1]) || 0,
      average: Number(/(?:^|,)AVERAGE-BANDWIDTH=(\d+)/.exec(attrs)?.[1]) || 0,
      // La LARGEUR est remontee telle quelle: c'est elle qui situe un format large. Un film
      // en 2.40:1 est encode 1920x800 -- les 280 lignes "manquantes" sont des bandes noires
      // qui n'existent pas dans le fichier, pas une image de moindre definition.
      // Faute de RESOLUTION, la deduction du libelle ou du chemin. Nulle si elle n'a rien
      // trouve: c'est alors ffprobe qui tranchera.
      width: resolution ? Number(resolution[1]) : guessed.width,
      height: resolution ? Number(resolution[2]) : guessed.height,
      audioUri: audioRenditionOf(text, attrs),
      uri,
    });
  }

  if (variants.length === 0) return null;
  // Le lecteur ira sur la meilleure variante disponible: c'est elle qu'on decrit. La
  // resolution prime sur le debit -- un 720p tres compresse n'est pas "mieux" qu'un 1080p.
  // Comparee sur la largeur, pour la meme raison que ci-dessus.
  return variants.reduce((best, v) => {
    const [a, b] = [v.width || v.height, best.width || best.height];
    if (a !== b) return a > b ? v : best;
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

  return {
    bitrate: Math.round((bytes * 8) / seconds),
    estimated: true,
    samples: measured.length,
    // Playlist effectivement pesee: c'est elle que ffprobe ouvrira si personne n'a su dire
    // la definition (cf. `resolutionOf`). La remonter evite de la retrouver deux fois.
    read: url,
  };
}

/**
 * Debit d'une piste audio separee, en deux prelevements.
 *
 * Mise en cache a part: les quatre paliers d'un meme titre Cinejoy partagent exactement la
 * meme rendition audio, et la mesurer quatre fois n'apprendrait rien.
 */
async function probeAudioRendition(access, url) {
  return cache.wrap(`probe:audio:${url}`, config.CACHE_TTL_MS, config.CACHE_EMPTY_TTL_MS, async () => {
    const { status, data } = await access.http.get(access.resolve(url), { responseType: 'text' });
    if (status >= 400 || typeof data !== 'string' || !data.includes('#EXTINF')) return 0;

    const segments = collectSegments(data, url);
    if (segments.length === 0) return 0;

    const picked = pickSamples(segments, 2);
    const sizes = await Promise.all(
      picked.map((segment) => (segment.bytes ? segment.bytes : byteLength(access, segment.uri).catch(() => 0))),
    );
    const bytes = sizes.reduce((total, n) => total + n, 0);
    const seconds = picked.reduce((total, s, i) => total + (sizes[i] > 0 ? s.duration : 0), 0);
    return seconds > 0 ? Math.round((bytes * 8) / seconds) : 0;
  });
}

/**
 * @param {number} depth garde-fou contre une chaine de masters qui se referenceraient
 *        mutuellement (vu sur certains CDN mal configures).
 */
async function probeHls(access, url, depth = 0, body = null) {
  // `body`: playlist deja connue -- c'est le cas d'un mini-master fabrique par un addon, dont
  // le corps voyage DANS le lien. Aucune requete a faire pour le lire.
  let data = body;
  if (data === null) {
    const response = await access.http.get(access.resolve(url), { responseType: 'text' });
    if (response.status >= 400 || typeof response.data !== 'string') return {};
    data = response.data;
  }

  if (data.includes('#EXT-X-STREAM-INF')) {
    const best = parseMaster(data);
    if (!best) return {};
    const shape = { height: best.height, width: best.width };

    // Valeur declaree ET moyenne: rien de mieux a esperer, on la prend telle quelle. La
    // specification veut qu'elle inclue deja la piste audio associee.
    if (best.average) return { bitrate: best.average, ...shape };

    // Sinon on descend mesurer la variante: une moyenne calculee sur ses segments est
    // comparable aux autres liens, la ou un debit de pointe ne l'est pas.
    if (best.uri && depth < 2) {
      const variantUrl = new URL(best.uri, url).toString();
      const measured = await probeHls(access, variantUrl, depth + 1);
      if (measured.bitrate) {
        // Variante muette: ce qu'on vient de peser n'est que l'image. Sans le son, ce lien
        // se compare a la baisse face a un flux muxe de meme encodage.
        const audio = best.audioUri
          ? await probeAudioRendition(access, new URL(best.audioUri, url).toString()).catch(() => 0)
          : 0;
        return {
          ...measured,
          bitrate: measured.bitrate + (audio || 0),
          height: best.height || measured.height,
          width: best.width || measured.width,
        };
      }
    }

    // Rien n'a pu etre mesure: le pic reste une indication, signalee comme approximative.
    if (best.peak) return { bitrate: best.peak, ...shape, estimated: true };
    // Ni debit ni definition: ce n'est pas un resultat, c'est un echec. Le rendre comme un
    // objet non vide ferait passer cet acces pour concluant et priverait le lien de ses
    // voies de repli.
    return shape.height || shape.width ? shape : {};
  }

  if (data.includes('#EXTINF')) return probeMediaPlaylist(access, url, data);
  return {};
}

/**
 * Le format que designe une image mesuree.
 *
 * ffprobe rend la taille REELLE de l'image, qui n'est pas celle du format annonce. Un film
 * en 2.35:1 se rencontre sous deux encodages, et il faut les lire a l'envers l'un de l'autre:
 *
 *  - 1920x800: le scope est RECADRE, les 280 lignes absentes sont des bandes noires qui
 *    n'existent pas dans le fichier. C'est la largeur qui nomme le format (1080p).
 *  - 2542x1080: l'image garde ses 1080 lignes et deborde en largeur. C'est la hauteur qui
 *    nomme le format -- lu sur la largeur, ce 1080p passerait pour du 1440p.
 *
 * On distingue les deux a la hauteur: standard, elle fait foi; inhabituelle, c'est un
 * recadrage et la largeur reprend la main.
 */
function nominalShape(width, height) {
  if (COMMON_HEIGHTS.some((h) => Math.abs(height - h) <= 8)) return { width: 0, height };
  return { width, height };
}

let ffprobeAvailable = null;

/**
 * ffprobe est-il installe? Verifie une fois, puis memorise: sans cette garde, une image
 * construite sans ffmpeg tenterait un spawn par lien sans definition, a chaque fiche.
 */
function ffprobeReady() {
  if (ffprobeAvailable) return ffprobeAvailable;
  ffprobeAvailable = new Promise((resolve) => {
    execFile(config.FFPROBE_PATH || 'ffprobe', ['-version'], { timeout: 5000 }, (err) => resolve(!err));
  });
  return ffprobeAvailable;
}

/**
 * Definition lue DANS le flux, par ffprobe -- dernier recours.
 *
 * Beaucoup de playlists de segments n'ont aucun master au-dessus d'elles: il n'y a alors
 * ni RESOLUTION, ni NAME, ni rien a deduire d'un chemin. Le debit se mesure, la definition
 * non -- c'est ce qui laissait les flux KissKH s'afficher avec leur seul debit.
 *
 * ffprobe ouvre la playlist (il sait lire du HLS, segments fMP4 et leur init compris), lit
 * l'entete du premier segment et s'arrete: quelques centaines de kilo-octets, une fois, puis
 * le resultat suit la mesure en cache. La sonde de definition ne rallonge donc que les liens
 * dont la definition etait de toute facon inconnue.
 */
function resolutionOf(url, headers, timeoutMs) {
  return new Promise((resolve) => {
    // Options PRIVEES du protocole http: sur une entree qui n'en est pas une, elles font
    // echouer l'ouverture (cf. subtitles/speech.js, meme piege).
    const network = /^https?:\/\//i.test(String(url))
      ? [
          '-user_agent', DEFAULT_UA,
          '-rw_timeout', String(Math.max(timeoutMs, 1000) * 1000),
          ...(headers && Object.keys(headers).length > 0
            ? ['-headers', `${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n`]
            : []),
        ]
      : [];

    const args = [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'csv=p=0',
      // Une playlist HLS renvoie vers d'autres protocoles: sans liste blanche explicite,
      // ffprobe refuse de suivre ses propres segments.
      '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
      ...network,
      // Assez pour trouver la premiere image, pas de quoi telecharger le segment entier.
      '-probesize', '2000000',
      '-analyzeduration', '2000000',
      '-i', url,
    ];

    execFile(config.FFPROBE_PATH || 'ffprobe', args, { timeout: timeoutMs }, (err, stdout) => {
      if (err && !stdout) return resolve(null);
      const [width, height] = String(stdout).trim().split('\n')[0].split(',').map(Number);
      resolve(height > 0 ? nominalShape(width, height) : null);
    });
  });
}

/**
 * Complete une mesure de ce qu'elle n'a pas su dire, et ecarte ce qu'elle a mal dit.
 *
 * Un debit inferieur au kilobit n'est pas un flux: c'est le signe qu'on a pese autre chose
 * que le media (une playlist prise pour un fichier, une reponse d'erreur). Mieux vaut ne
 * rien afficher qu'un "0 kb/s" qui a l'air d'une mesure.
 */
async function finish(access, result, url, { deadline, knownHeight } = {}) {
  const { read, ...clean } = result;
  if (clean.bitrate && clean.bitrate < 1000) {
    delete clean.bitrate;
    delete clean.estimated;
  }
  if (clean.height || knownHeight > 0 || !config.PROBE_RESOLUTION) return clean;

  const budget = deadline ? deadline - Date.now() : config.PROBE_RESOLUTION_TIMEOUT_MS;
  if (budget < 1000) return clean;
  if (!(await ffprobeReady())) return clean;

  const target = access.resolve(read || url);
  const found = await resolutionOf(
    target,
    access.headers,
    Math.min(budget, config.PROBE_RESOLUTION_TIMEOUT_MS),
  ).catch(() => null);
  return found ? { ...clean, ...found, resolutionProbed: true } : clean;
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
  // Playlist synthetique: elle est fournie avec le lien, il n'y a rien a aller chercher et
  // rien a deduire de l'URL.
  if (access.inline) return probeHls(access, access.inline.base || url, 0, access.inline.text);

  // Un lien d'addon est une URL de proxy: son extension ne dit plus rien du flux, c'est
  // celle de la cible qu'elle transporte qui compte. `sourceOf` et non `targetOf`, sans quoi
  // un mini-master (qui n'a pas de cible, seulement une base) serait pris pour un fichier et
  // pese... a la taille de son propre corps, soit 1 ko pour un film de 2 h 35.
  //
  // Le motif n'est pas ancre en fin d'URL, car certaines cibles sont elles-memes des proxys
  // HLS qui portent la vraie playlist en parametre (.../m3u8-proxy?url=...master.m3u8&...).
  const isHls = /\.m3u8/i.test(streamProxy.sourceOf(url) || url);
  return isHls ? probeHls(access, url) : probeFile(access, url, durationSeconds);
}

/**
 * @param {string} url URL du media a mesurer
 * @param {{durationSeconds?: number, refererUrl?: string, knownHeight?: number}} options
 *        refererUrl = page d'embed d'origine (voe.sx/...), pas le CDN: c'est elle que le
 *        hoster attend en Referer, et l'origine du CDN ne suffit pas.
 *        knownHeight = definition deja connue par ailleurs (libelle du lien). Non nulle,
 *        elle dispense d'ouvrir le flux pour la mesurer.
 * @returns {Promise<{bitrate?, height?, width?, bytes?, estimated?, resolutionProbed?}>}
 */
async function probe(url, { durationSeconds, refererUrl, hoster, deadline, refresh, knownHeight = 0 } = {}) {
  if (!config.PROBE_BITRATE || !url) return {};

  // Hors budget: on rend la main SANS passer par le cache. Mettre en cache un "aucune
  // mesure" du a un manque de temps le figerait pour CACHE_EMPTY_TTL_MS, et le lien
  // resterait sans debit pendant des minutes alors qu'il etait parfaitement mesurable.
  if (deadline && Date.now() > deadline) return {};

  // Rafraichissement demande: on retente ce qui avait ECHOUE, mais on garde les mesures
  // reussies -- elles ne changent pas d'un scan a l'autre et coutent cher a refaire.
  if (refresh) {
    const previous = cache.get(`probe:${url}`);
    if (previous && !previous.bitrate && !previous.bytes) cache.del(`probe:${url}`);
  }

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
      // Service partage deja connu pour ne pas repondre: on ne repaye pas son timeout.
      if (access.service && probeBreaker.isOpen(access.service)) continue;

      try {
        const entry = access.entry || url;
        const result = await attempt(access, entry, durationSeconds);
        if (result && Object.keys(result).length > 0) {
          if (access.service) probeBreaker.noteRecovery(access.service);
          return finish(access, result, entry, { deadline, knownHeight });
        }
      } catch (err) {
        // Une exception ici est un timeout ou une erreur reseau (les statuts HTTP, eux, ne
        // levent pas): c'est bien le service qui ne repond pas, pas ce lien-la.
        if (access.service) probeBreaker.noteOutage(access.service);
        console.warn(`[probe] ${access.label} a echoue sur ${url.slice(0, 80)}: ${err.message}`);
      }
    }

    console.warn(`[probe] aucune mesure pour ${url.slice(0, 80)}`);
    return {};
  });
}

function formatBitrate(bitsPerSecond) {
  // Sous le kilobit, ce n'est pas un debit faible mais une mesure fausse -- et elle
  // s'affichait "0 kb/s", ce qui a tout l'air d'un resultat.
  if (!bitsPerSecond || bitsPerSecond < 1000) return null;
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

module.exports = { probe, formatBitrate, formatSize, breakerState: probeBreaker.state };
