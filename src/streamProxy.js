const crypto = require('crypto');
const https = require('https');
const { Transform } = require('stream');
const axios = require('axios');
const config = require('./config');

/**
 * Proxy de flux interne -- l'equivalent local de proxiesembed, mais pilote par les addons.
 *
 * Le probleme qu'il resout: les CDN de ces sources ne servent leurs segments que si la
 * requete porte l'Origin/le Referer de la page de lecture officielle (et parfois un
 * User-Agent de navigateur). Nuvio et Stremio ne savent pas poser d'en-tetes arbitraires
 * sur un flux HLS -- ils demandent une URL, point. On leur donne donc une URL a NOUS, et
 * c'est ce module qui rejoue la signature attendue vers l'amont.
 *
 * Ce que fait la route, dans l'ordre:
 *  1. verifie la signature (sans elle, /proxy/stream serait un relais HTTP ouvert);
 *  2. rejoue les en-tetes declares par l'addon, en relayant le Range du lecteur;
 *  3. si la reponse est une playlist m3u8, reecrit CHAQUE URI (segments, sous-playlists,
 *     cles AES, EXT-X-MAP) pour qu'elle repasse par ici -- sinon le lecteur irait
 *     chercher les segments en direct et se ferait refuser;
 *  4. applique les regles par URL de l'addon (octets d'amorce a jeter, Content-Type a
 *     forcer) pour les CDN qui deguisent leurs segments.
 *
 * Tout le reste est un passe-plat en streaming: aucun octet de video n'est bufferise.
 */

const ROUTE = '/proxy/stream';

// Les CDN de hosters ont regulierement des certificats invalides (meme constat que dans
// probe.js, ou le proxy du site lui-meme utilise verify=False).
const insecureAgent = new https.Agent({ rejectUnauthorized: false });

const SECRET =
  config.STREAM_PROXY_SECRET || crypto.randomBytes(32).toString('hex');

if (config.STREAM_PROXY_ENABLED && !config.STREAM_PROXY_SECRET) {
  console.warn(
    '[streamProxy] STREAM_PROXY_SECRET absent -- un secret aleatoire est genere a chaque ' +
      'demarrage, donc les liens deja ouverts dans Nuvio cesseront de fonctionner apres un restart.',
  );
}

// Duree de vie d'un ticket. Elle borne une session de lecture: au-dela, le lecteur
// redemande la playlist a l'addon, qui reforge des tickets neufs.
const TICKET_TTL_MS = 6 * 60 * 60 * 1000;
const tickets = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of tickets) {
    if (now > entry.expiresAt) tickets.delete(id);
  }
}, 30 * 60 * 1000).unref();

function b64urlEncode(value) {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function b64urlDecode(value) {
  return Buffer.from(String(value), 'base64url').toString('utf8');
}

function sign(value) {
  return crypto.createHmac('sha256', SECRET).update(value).digest('base64url').slice(0, 32);
}

function signatureMatches(expected, received) {
  const a = Buffer.from(String(expected));
  const b = Buffer.from(String(received || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function publicBase() {
  return (config.PUBLIC_URL || `http://127.0.0.1:${config.PORT}`).replace(/\/+$/, '');
}

/**
 * Une "recette d'acces": ce que l'addon sait de la facon de joindre SES CDN.
 *  - headers: rejoues tels quels sur chaque requete sortante;
 *  - rules: [{match, skipBytes, contentType}] appliquees quand l'URL cible matche;
 *  - playlistHints: fragments d'URL qui trahissent une playlist sans extension .m3u8
 *    (jbam.aether.bar sert ses playlists sur /m3u8-proxy et /content).
 */
function normalizeSpec(spec = {}) {
  return {
    h: spec.headers || {},
    r: Array.isArray(spec.rules) ? spec.rules : [],
    p: Array.isArray(spec.playlistHints) ? spec.playlistHints : [],
  };
}

/**
 * URL "scellee": la recette entiere voyage dans le lien signe. C'est celle qu'on remet a
 * Nuvio, et elle survit donc a un redemarrage (a condition que STREAM_PROXY_SECRET soit fixe).
 */
function proxyUrl(targetUrl, spec) {
  const payload = b64urlEncode(JSON.stringify({ ...normalizeSpec(spec), u: targetUrl }));
  return `${publicBase()}${ROUTE}?p=${payload}&s=${sign(payload)}`;
}

/**
 * URL "a ticket": la recette reste en memoire, seule sa reference circule. Utilisee pour
 * les milliers d'URIs d'une playlist reecrite -- y recopier la recette complete ferait
 * grossir chaque ligne de plus d'un kilo-octet.
 */
function ticketUrl(targetUrl, spec, isPlaylist = false) {
  // `f` marque une URI dont la playlist parente GARANTIT qu'elle en designe une autre.
  const normalized = isPlaylist ? { ...spec, f: 1 } : spec;
  const serialized = JSON.stringify(normalized);
  const id = sign(serialized).slice(0, 24);
  tickets.set(id, { spec: normalized, expiresAt: Date.now() + TICKET_TTL_MS });

  const u = b64urlEncode(targetUrl);
  return `${publicBase()}${ROUTE}?t=${id}&u=${u}&s=${sign(`${id}.${u}`)}`;
}

function isProxied(url) {
  return typeof url === 'string' && url.includes(ROUTE);
}

/**
 * URL d'origine cachee derriere un lien proxifie. Sert a raisonner sur la NATURE du flux
 * (une playlist se reconnait a son extension .m3u8, que l'URL de proxy n'a plus) sans
 * cesser de passer par le proxy pour y acceder.
 */
function targetOf(url) {
  if (!isProxied(url)) return null;
  try {
    const { searchParams } = new URL(url);
    const ticket = searchParams.get('u');
    if (ticket) return b64urlDecode(ticket);
    const payload = searchParams.get('p');
    return payload ? JSON.parse(b64urlDecode(payload)).u : null;
  } catch {
    return null;
  }
}

/**
 * Ramene une URL proxifiee sur la boucle locale. PUBLIC_URL vise l'appareil de lecture
 * (une IP Tailscale, typiquement); pour la sonde de debit, qui tourne dans ce process,
 * passer par cette adresse serait un detour reseau inutile -- et un echec si l'hote ne
 * s'atteint pas lui-meme par cette IP.
 */
function localize(url) {
  if (!isProxied(url)) return url;
  const base = publicBase();
  return url.startsWith(base) ? `http://127.0.0.1:${config.PORT}${url.slice(base.length)}` : url;
}

/** Resout une URI de playlist, en heritant au besoin des query params du parent. */
function resolveChild(parentUrl, childUri) {
  const resolved = new URL(childUri, parentUrl);
  // Les CDN a jeton signent la playlist ET ses segments avec la meme query. Quand le
  // segment est reference sans query (cas frequent), la reprendre du parent est la seule
  // facon de ne pas se faire refuser.
  //
  // Uniquement pour les URI RELATIVES: une URL absolue vise un autre service (souvent un
  // autre domaine), et lui recopier la query du parent n'a aucun sens -- c'est ainsi qu'un
  // segment se retrouverait affuble du "?url=...&headers=..." d'un proxy HLS parent.
  const isAbsolute = /^[a-z][a-z0-9+.-]*:/i.test(childUri.trim());
  if (!isAbsolute && !resolved.search) resolved.search = new URL(parentUrl).search;
  return resolved.toString();
}

function ruleFor(targetUrl, spec) {
  for (const rule of spec.r || []) {
    try {
      if (new RegExp(rule.match, 'i').test(targetUrl)) return rule;
    } catch {
      // Un motif invalide ne doit pas casser la lecture: on l'ignore.
    }
  }
  return null;
}

function looksLikePlaylist(targetUrl, spec) {
  // Certitude: la playlist parente a designe cette URI par un tag qui ne peut en referencer
  // qu'une autre. Aucune extension a deviner -- et beaucoup de CDN n'en mettent pas.
  if (spec.f) return true;
  if (/\.m3u8(\?|$)/i.test(targetUrl)) return true;
  return (spec.p || []).some((hint) => targetUrl.toLowerCase().includes(String(hint).toLowerCase()));
}

/**
 * Lit les premiers octets d'un flux puis les remet en tete, pour pouvoir decider de sa
 * nature sans rien consommer.
 *
 * L'URL ne suffit pas a distinguer une playlist d'un segment: un proxy HLS sert les DEUX
 * sur le meme chemin (jbam.aether.bar/m3u8-proxy?url=...). Trancher sur l'URL seule
 * revenait a decoder des segments video en texte UTF-8, donc a les corrompre.
 */
function peek(stream, size) {
  return new Promise((resolve, reject) => {
    const finish = (value) => {
      stream.removeListener('readable', onReadable);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
      resolve(value);
    };
    const onReadable = () => {
      const chunk = stream.read(size) || stream.read();
      if (chunk === null) return; // pas encore assez d'octets: on attend le prochain evenement
      stream.unshift(chunk);
      finish(chunk);
    };
    const onEnd = () => finish(Buffer.alloc(0));
    const onError = (err) => {
      stream.removeListener('readable', onReadable);
      stream.removeListener('end', onEnd);
      reject(err);
    };
    stream.on('readable', onReadable);
    stream.once('end', onEnd);
    stream.once('error', onError);
  });
}

/**
 * Type MIME deduit des premiers octets d'un flux.
 *
 * Un CDN peut parfaitement servir de la video en l'etiquetant "text/html" -- jbam le fait
 * sur ses segments. Le lecteur refuse alors un segment valide, redemande, et boucle sans
 * jamais demarrer. Ici comme ailleurs, ce sont les octets qui font foi.
 */
function sniffMediaType(head) {
  // MPEG-TS: octet de synchro 0x47 tous les 188 octets.
  if (head.length > 0 && head[0] === 0x47 && (head.length <= 188 || head[188] === 0x47)) return 'video/mp2t';
  const box = head.subarray(4, 8).toString('latin1');
  if (['ftyp', 'moof', 'styp', 'sidx'].includes(box)) return 'video/mp4';
  return null;
}

/** Une playlist commence par #EXTM3U -- eventuellement precede d'un BOM ou d'un saut de ligne. */
function startsPlaylist(head) {
  return head.toString('utf8').replace(/^﻿/, '').trimStart().startsWith('#EXTM3U');
}

/** Lit un flux en entier, plafonne: une playlist pese quelques kilo-octets, jamais plus. */
function collect(stream, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    stream.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        stream.destroy();
        return reject(new Error(`playlist anormalement volumineuse (> ${maxBytes} octets)`));
      }
      chunks.push(chunk);
    });
    stream.once('end', () => resolve(Buffer.concat(chunks)));
    stream.once('error', reject);
  });
}

const MAX_PLAYLIST_BYTES = 8 * 1024 * 1024;

/**
 * Tags dont l'URI designe une autre PLAYLIST. Les distinguer de EXT-X-KEY (cle AES) et
 * EXT-X-MAP (segment d'initialisation) evite d'avoir a deviner la nature d'une URI depuis
 * son extension -- que beaucoup de CDN n'ont pas.
 */
const PLAYLIST_URI_TAGS = /^#EXT-X-(MEDIA|I-FRAME-STREAM-INF|RENDITION-REPORT)\b/i;

/** Reecrit une playlist pour que tout ce qu'elle reference repasse par le proxy. */
function rewritePlaylist(text, baseUrl, spec) {
  // La certitude du parent ne se transmet pas aux enfants: c'est chaque ligne qui la porte.
  const childSpec = { h: spec.h, r: spec.r, p: spec.p };
  let nextIsVariant = false;

  return text
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      if (trimmed.startsWith('#')) {
        // Une URI de variante suit toujours son EXT-X-STREAM-INF, sur la ligne d'apres.
        if (/^#EXT-X-STREAM-INF\b/i.test(trimmed)) nextIsVariant = true;

        const isPlaylistUri = PLAYLIST_URI_TAGS.test(trimmed);
        return line.replace(
          /URI="([^"]+)"/g,
          (_match, uri) => `URI="${ticketUrl(resolveChild(baseUrl, uri), childSpec, isPlaylistUri)}"`,
        );
      }

      const url = ticketUrl(resolveChild(baseUrl, trimmed), childSpec, nextIsVariant);
      nextIsVariant = false;
      return url;
    })
    .join('\n');
}

/** Jette les `count` premiers octets d'un flux, sans le bufferiser. */
function skipFirstBytes(count) {
  let remaining = count;
  return new Transform({
    transform(chunk, _encoding, callback) {
      if (remaining > 0) {
        if (chunk.length <= remaining) {
          remaining -= chunk.length;
          return callback();
        }
        chunk = chunk.subarray(remaining);
        remaining = 0;
      }
      callback(null, chunk);
    },
  });
}

/**
 * Decale le Range demande par le lecteur de `skip` octets. Le lecteur raisonne sur le
 * fichier debarrasse de son amorce; l'amont, lui, la compte encore.
 */
function shiftRange(rangeHeader, skip) {
  const match = /^bytes=(\d+)-(\d*)$/i.exec(String(rangeHeader).trim());
  if (!match) return null;
  const start = Number(match[1]) + skip;
  const end = match[2] === '' ? '' : Number(match[2]) + skip;
  return { header: `bytes=${start}-${end}`, offset: skip };
}

/** `bytes 0-99/1000` -> meme intervalle, ramene dans le referentiel du lecteur. */
function unshiftContentRange(contentRange, skip) {
  const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/i.exec(String(contentRange).trim());
  if (!match) return contentRange;
  const start = Math.max(Number(match[1]) - skip, 0);
  const end = Math.max(Number(match[2]) - skip, 0);
  const total = match[3] === '*' ? '*' : Math.max(Number(match[3]) - skip, 0);
  return `bytes ${start}-${end}/${total}`;
}

/**
 * Journal des requetes du lecteur (STREAM_PROXY_LOG=true).
 *
 * Les lecteurs ne demandent pas tous la meme chose: AVFoundation sonde en HEAD et en
 * Range, ExoPlayer fait un GET simple. Quand un flux marche sur un appareil et pas sur un
 * autre, c'est cette difference qu'il faut pouvoir lire.
 */
function trace(req, target, outcome) {
  if (!config.STREAM_PROXY_LOG) return;
  const range = req.headers.range ? ` range=${req.headers.range}` : '';
  console.log(`[streamProxy] ${req.method}${range} -- ${outcome} -- ${String(target).slice(0, 90)}`);
}

/**
 * Recupere une playlist et la reecrit, ou rend null si l'URL n'en designait pas une.
 *
 * Toujours un GET complet, sans relayer le Range du client: une playlist pese quelques
 * kilo-octets, et il faut la connaitre ENTIEREMENT pour repondre juste -- sa version
 * reecrite n'a ni la meme taille ni les memes octets que l'originale.
 */
async function fetchPlaylist(target, spec) {
  const upstream = await axios({
    method: 'get',
    url: target,
    // Pas de compression: le contenu est minuscule, et le recevoir tel quel permet d'en
    // lire l'entete sans avoir a le decompresser d'abord.
    headers: { ...spec.h, 'Accept-Encoding': 'identity' },
    responseType: 'stream',
    decompress: false,
    timeout: config.STREAM_PROXY_TIMEOUT_MS,
    maxRedirects: 5,
    httpsAgent: insecureAgent,
    validateStatus: () => true,
  });

  if (upstream.status >= 400) {
    console.warn(`[streamProxy] amont ${upstream.status} sur ${target.slice(0, 100)}`);
    upstream.data?.destroy?.();
    return null;
  }

  // L'URL n'a designe qu'un CANDIDAT; ce sont ses premiers octets qui tranchent. Un
  // segment servi sur le meme chemin qu'une playlist repart ainsi intact, en passe-plat.
  const head = await peek(upstream.data, 64);
  const contentType = String(upstream.headers['content-type'] || '').toLowerCase();
  if (!startsPlaylist(head) && !contentType.includes('mpegurl')) {
    upstream.data.destroy();
    return null;
  }

  const body = (await collect(upstream.data, MAX_PLAYLIST_BYTES)).toString('utf8');
  return rewritePlaylist(body, target, spec);
}

const PASSTHROUGH_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'content-encoding',
  'accept-ranges',
  'cache-control',
  'etag',
  'last-modified',
];

function readRequest(req) {
  const { p, s, t, u } = req.query;

  if (t) {
    if (!signatureMatches(sign(`${t}.${u}`), s)) return { error: 403, message: 'signature invalide' };
    const entry = tickets.get(String(t));
    if (!entry || Date.now() > entry.expiresAt) {
      return { error: 410, message: 'lien expire -- rouvre la fiche pour en obtenir un nouveau' };
    }
    // Glissant: tant qu'une lecture est en cours, ses tickets restent vivants.
    entry.expiresAt = Date.now() + TICKET_TTL_MS;
    return { target: b64urlDecode(u), spec: entry.spec };
  }

  if (!p) return { error: 400, message: 'parametre manquant' };
  if (!signatureMatches(sign(String(p)), s)) return { error: 403, message: 'signature invalide' };

  try {
    const payload = JSON.parse(b64urlDecode(p));
    const { u: target, ...spec } = payload;
    return { target, spec };
  } catch {
    return { error: 400, message: 'payload illisible' };
  }
}

async function handle(req, res) {
  if (!config.STREAM_PROXY_ENABLED) {
    return res.status(503).type('text/plain').send('proxy de flux desactive (STREAM_PROXY_ENABLED=false)');
  }

  const { target, spec, error, message } = readRequest(req);
  if (error) return res.status(error).type('text/plain').send(message);
  if (!/^https?:\/\//i.test(String(target))) {
    return res.status(400).type('text/plain').send('URL cible invalide');
  }

  const rule = ruleFor(target, spec) || {};
  const skip = Number(rule.skipBytes) > 0 ? Number(rule.skipBytes) : 0;
  const isHead = req.method === 'HEAD';
  const clientRange = req.headers.range;

  try {
    // --- Playlist: on la reecrit pour capturer tout ce qu'elle reference ---------------
    // Cette voie ne depend NI de la methode NI du Range demande. Une playlist renvoyee
    // telle quelle est une playlist perdue: le lecteur ira chercher ses segments en
    // direct, sans nos en-tetes ni nos transformations. Or AVFoundation (iOS) sonde en
    // HEAD et en Range la ou ExoPlayer (Android) fait un simple GET -- exclure ces deux
    // cas rendait donc les flux injouables sur iPad alors qu'ils marchaient sur Android.
    if (looksLikePlaylist(target, spec)) {
      const rewritten = await fetchPlaylist(target, spec);
      if (rewritten) {
        const body = Buffer.from(rewritten, 'utf8');
        trace(req, target, `playlist reecrite (${body.length} o)`);
        res
          .status(200)
          .set('Content-Type', 'application/vnd.apple.mpegurl')
          // La taille de NOTRE playlist n'a rien a voir avec celle de l'originale (chaque
          // URI y est reecrite). Relayer le Content-Length de l'amont la ferait tronquer.
          .set('Content-Length', String(body.length))
          // On sert la playlist d'un bloc: un Range n'a pas de sens dessus, et repondre 200
          // a un client qui en demandait un est licite.
          .set('Accept-Ranges', 'none')
          .set('Cache-Control', 'no-store');
        return isHead ? res.end() : res.end(body);
      }
      // Ce n'etait pas une playlist malgre son URL: on repart en passe-plat ci-dessous.
    }

    // --- Passe-plat ------------------------------------------------------------------
    const headers = { ...spec.h };
    const shifted = skip && clientRange ? shiftRange(clientRange, skip) : null;
    if (clientRange) headers.Range = shifted ? shifted.header : clientRange;
    if (req.headers['if-range']) headers['If-Range'] = req.headers['if-range'];

    const upstream = await axios({
      method: isHead ? 'head' : 'get',
      url: target,
      headers,
      // Toujours en flux, jamais en texte: un segment video decode en UTF-8 est un
      // segment video corrompu.
      responseType: 'stream',
      // On ne touche a rien, compression comprise: le lecteur sait la gerer, et
      // decompresser fausserait le Content-Length qu'on relaie.
      decompress: false,
      timeout: config.STREAM_PROXY_TIMEOUT_MS,
      maxRedirects: 5,
      httpsAgent: insecureAgent,
      validateStatus: () => true,
    });

    if (upstream.status >= 400) {
      console.warn(`[streamProxy] amont ${upstream.status} sur ${target.slice(0, 100)}`);
    }

    res.status(upstream.status);
    for (const name of PASSTHROUGH_HEADERS) {
      const value = upstream.headers[name];
      if (value !== undefined) res.set(name, value);
    }

    // Un type MIME de page web sur ce qui devrait etre un segment: soit l'amont a
    // repondu une page d'erreur en 200 (les CDN le font au lieu d'un 403), soit il a
    // simplement mal etiquete de la video. Les deux cas se distinguent en lisant les
    // octets -- et se confondaient jusqu'ici en un lecteur qui boucle sans rien dire.
    const upstreamType = String(upstream.headers['content-type'] || '');
    let corrected = null;
    if (!isHead && !rule.contentType && (!upstreamType || /text\/(html|plain)/i.test(upstreamType))) {
      const head = await peek(upstream.data, 512);
      corrected = sniffMediaType(head);
      if (corrected) {
        res.set('Content-Type', corrected);
        console.warn(
          `[streamProxy] type MIME corrige "${upstreamType || '(absent)'}" -> ${corrected} sur ${target.slice(0, 80)}`,
        );
      } else if (upstreamType) {
        console.warn(
          `[streamProxy] l'amont a repondu du ${upstreamType} la ou une video est attendue ` +
            `(${upstream.status}) -- page d'erreur ou anti-bot ? ${target.slice(0, 90)}`,
        );
      }
    }

    if (rule.contentType) res.set('Content-Type', rule.contentType);

    trace(
      req,
      target,
      `passe-plat ${upstream.status}${skip ? ` (amorce de ${skip} o retiree)` : ''}${corrected ? ` (type corrige -> ${corrected})` : ''}`,
    );

    if (skip) {
      if (shifted && upstream.headers['content-range']) {
        res.set('Content-Range', unshiftContentRange(upstream.headers['content-range'], skip));
      } else if (!clientRange) {
        const length = Number(upstream.headers['content-length']);
        if (Number.isFinite(length) && length > skip) res.set('Content-Length', String(length - skip));
      }
    }

    if (isHead) return res.end();

    upstream.data.on('error', (err) => {
      console.warn(`[streamProxy] flux interrompu sur ${target.slice(0, 80)}: ${err.message}`);
      res.destroy();
    });
    // Le lecteur ferme souvent la connexion en cours de route (seek, changement de piste):
    // sans ca, la requete sortante continuerait a tirer des octets dans le vide.
    res.on('close', () => upstream.data.destroy());

    // Sans Range, l'amorce est encore en tete du corps: c'est ici qu'on la retire. Avec
    // Range, elle a deja ete sautee par le decalage applique a la requete.
    return skip && !clientRange
      ? upstream.data.pipe(skipFirstBytes(skip)).pipe(res)
      : upstream.data.pipe(res);
  } catch (err) {
    console.warn(`[streamProxy] echec sur ${String(target).slice(0, 100)}: ${err.message}`);
    if (!res.headersSent) res.status(502).type('text/plain').send(`proxy: ${err.message}`);
    return undefined;
  }
}

function mount(app) {
  app.get(ROUTE, handle);
  app.head(ROUTE, handle);
}

module.exports = { ROUTE, mount, proxyUrl, isProxied, targetOf, localize, publicBase };
