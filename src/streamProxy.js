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
function ticketUrl(targetUrl, normalized) {
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

/** Reecrit une playlist pour que tout ce qu'elle reference repasse par le proxy. */
function rewritePlaylist(text, baseUrl, spec) {
  return text
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      // Balises: seules les URI explicites nous concernent (cle AES-128, EXT-X-MAP).
      if (trimmed.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (_match, uri) => `URI="${ticketUrl(resolveChild(baseUrl, uri), spec)}"`);
      }

      return ticketUrl(resolveChild(baseUrl, trimmed), spec);
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

  // La detection de playlist est un pari sur l'URL: on ne peut pas bufferiser un segment
  // video pour verifier. Une requete Range n'est jamais une playlist -- les lecteurs
  // telechargent celles-ci d'un bloc.
  const clientRange = req.headers.range;
  const playlistCandidate = !isHead && !clientRange && looksLikePlaylist(target, spec);

  const headers = { ...spec.h };
  const shifted = skip && clientRange ? shiftRange(clientRange, skip) : null;
  if (clientRange) headers.Range = shifted ? shifted.header : clientRange;
  if (req.headers['if-range']) headers['If-Range'] = req.headers['if-range'];
  // Sur un candidat playlist on refuse la compression: le contenu est minuscule, et le
  // recevoir tel quel permet d'en lire l'entete sans avoir a le decompresser d'abord.
  if (playlistCandidate) headers['Accept-Encoding'] = 'identity';

  try {
    const upstream = await axios({
      method: isHead ? 'head' : 'get',
      url: target,
      headers,
      // Toujours en flux, jamais en texte: un segment video decode en UTF-8 est un
      // segment video corrompu. La nature du contenu se decide plus bas, sur ses octets.
      responseType: 'stream',
      // En passe-plat on ne touche a rien, compression comprise: le lecteur sait la gerer,
      // et decompresser fausserait le Content-Length qu'on relaie.
      decompress: false,
      timeout: config.STREAM_PROXY_TIMEOUT_MS,
      maxRedirects: 5,
      httpsAgent: insecureAgent,
      validateStatus: () => true,
    });

    const contentType = String(upstream.headers['content-type'] || '').toLowerCase();

    if (upstream.status >= 400) {
      console.warn(`[streamProxy] amont ${upstream.status} sur ${target.slice(0, 100)}`);
    }

    // --- Playlist: on la reecrit pour capturer tout ce qu'elle reference ---------------
    // L'URL n'a fait que designer un CANDIDAT; ce sont ses premiers octets qui tranchent.
    // Un segment qui passe par le meme chemin qu'une playlist repart donc en passe-plat,
    // intact, au lieu d'etre relu comme du texte.
    if (playlistCandidate && upstream.status < 400) {
      const head = await peek(upstream.data, 64);
      if (startsPlaylist(head) || contentType.includes('mpegurl')) {
        const body = (await collect(upstream.data, MAX_PLAYLIST_BYTES)).toString('utf8');
        return res
          .status(upstream.status)
          .set('Content-Type', 'application/vnd.apple.mpegurl')
          .set('Cache-Control', 'no-store')
          .send(rewritePlaylist(body, target, spec));
      }
    }

    // --- Passe-plat ------------------------------------------------------------------
    res.status(upstream.status);
    for (const name of PASSTHROUGH_HEADERS) {
      const value = upstream.headers[name];
      if (value !== undefined) res.set(name, value);
    }

    if (rule.contentType) res.set('Content-Type', rule.contentType);

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
