const axios = require('axios');
const https = require('https');
const streamProxy = require('../streamProxy');

/**
 * Par ou ecouter un flux, au moindre cout.
 *
 * Caler des sous-titres ne demande que l'AUDIO, mais un flux HLS ne se telecharge pas par
 * morceaux choisis: demander l'audio d'un master, c'est tirer la video avec. D'ou ce
 * module, dont le seul travail est de trouver le chemin le moins cher jusqu'a la bande son:
 *
 *  1. une rendition audio separee (`EXT-X-MEDIA:TYPE=AUDIO`) quand le master en declare
 *     une: ~1 Mo par minute, la video n'est jamais touchee;
 *  2. sinon la variante la MOINS bien encodee du master. La bande son y est la meme --
 *     c'est la meme diffusion -- mais elle coute cinq fois moins cher a atteindre que le
 *     1080p. C'est le point le plus rentable de tout ce mecanisme: quelques dizaines de Mo
 *     au lieu de plusieurs centaines, pour un resultat identique.
 *
 * Un flux deja proxifie est lu A TRAVERS notre proxy (en boucle locale): il sait poser les
 * Origin/Referer que le CDN exige, rejouer ses regles et reecrire les playlists. Rien a
 * redupliquer ici -- et les URI enfants qu'il rend pointent deja sur lui.
 */

// Meme constat que dans probe.js: les CDN de hosters ont regulierement des certificats
// invalides, et le proxy du site lui-meme ne les verifie pas.
const insecureAgent = new https.Agent({ rejectUnauthorized: false });

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** En-tetes pour joindre une URL en DIRECT (un flux proxifie n'en a pas besoin). */
function directHeaders(url, refererUrl) {
  // Un chemin local ou une URL non http n'a pas d'en-tetes a poser, et les passer a ffmpeg
  // ferait echouer l'ouverture: `-headers` est une option du protocole http, pas du reste.
  if (!/^https?:\/\//i.test(String(url))) return {};
  try {
    const origin = new URL(refererUrl || url).origin;
    return { 'User-Agent': DEFAULT_UA, Referer: `${origin}/`, Origin: origin };
  } catch {
    return { 'User-Agent': DEFAULT_UA };
  }
}

async function fetchText(url, headers, timeoutMs) {
  const { status, data } = await axios.get(url, {
    headers,
    timeout: timeoutMs,
    responseType: 'text',
    httpsAgent: insecureAgent,
    validateStatus: () => true,
    maxRedirects: 5,
  });
  return status >= 400 || typeof data !== 'string' ? null : data;
}

/** Variantes d'un master, avec leur debit annonce. */
function parseVariants(text, baseUrl) {
  const lines = text.split('\n').map((l) => l.trim());
  const variants = [];

  for (let i = 0; i < lines.length; i += 1) {
    if (!/^#EXT-X-STREAM-INF/i.test(lines[i])) continue;
    const uri = lines.slice(i + 1).find((l) => l && !l.startsWith('#'));
    if (!uri) continue;
    const bandwidth =
      Number(/AVERAGE-BANDWIDTH=(\d+)/i.exec(lines[i])?.[1]) || Number(/[^-]BANDWIDTH=(\d+)/i.exec(lines[i])?.[1]) || 0;
    variants.push({ bandwidth, uri: new URL(uri, baseUrl).toString() });
  }
  return variants;
}

/** Rendition audio separee, si le master en declare une. */
function parseAudioRendition(text, baseUrl) {
  const candidates = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^#EXT-X-MEDIA:/i.test(l) && /TYPE=AUDIO/i.test(l) && /URI="/i.test(l));
  if (candidates.length === 0) return null;

  // La piste par defaut est celle que le lecteur jouerait; a defaut, la premiere declaree.
  // Le choix de la LANGUE importe peu: un doublage est synchronise sur l'image, donc ses
  // instants de parole sont ceux de la version originale a une fraction de seconde pres.
  const chosen = candidates.find((l) => /DEFAULT=YES/i.test(l)) || candidates[0];
  const uri = /URI="([^"]+)"/i.exec(chosen)?.[1];
  return uri ? new URL(uri, baseUrl).toString() : null;
}

/**
 * Instants de debut de chaque segment, cumules depuis les EXTINF.
 *
 * Ce n'est pas de la coquetterie: ffmpeg ne se place PAS a la seconde demandee sur un flux
 * HLS. Il choisit le segment qui la contient et commence a son debut, en renumerotant la
 * sortie a partir de zero -- une fenetre demandee a 90 s peut donc contenir l'audio de 84 s,
 * et se croire a 90. Un decalage different a chaque fenetre, ce qui est exactement ce qui
 * empeche de conclure quoi que ce soit.
 *
 * En calant les fenetres SUR ces frontieres, les deux comportements possibles de ffmpeg
 * (demarrer au segment, ou se placer exactement) donnent le meme resultat. Le probleme
 * disparait au lieu d'etre compense.
 */
function segmentStarts(text) {
  const starts = [];
  let total = 0;
  for (const line of text.split('\n')) {
    const match = /^#EXTINF:([\d.]+)/.exec(line.trim());
    if (!match) continue;
    starts.push(total);
    total += Number(match[1]) || 0;
  }
  return { starts, duration: total };
}

/** Duree annoncee par une playlist de segments (somme des EXTINF). */
function playlistDuration(text) {
  return segmentStarts(text).duration;
}

/**
 * Trouve la voie la moins chere vers l'audio d'un flux.
 *
 * @param {string} streamUrl URL telle qu'elle est servie au lecteur (proxifiee ou non)
 * @param {{refererUrl?:string, timeoutMs?:number}} options
 * @returns {Promise<{url:string, headers:object, duration:number, kind:string, bitrate:number}|null>}
 */
async function locate(streamUrl, { refererUrl, timeoutMs = 12000 } = {}) {
  const target = streamProxy.targetOf(streamUrl);
  const proxied = !!target;
  // A travers notre proxy: il pose les en-tetes attendus, ffmpeg n'a rien a savoir du CDN.
  const headers = proxied ? {} : directHeaders(streamUrl, refererUrl);
  const entry = proxied ? streamProxy.localize(streamUrl) : streamUrl;

  // L'extension d'une URL de proxy ne dit rien du flux: c'est celle de la cible qui compte.
  if (!/\.m3u8/i.test(target || streamUrl)) {
    // Fichier direct (mp4...): ffmpeg lit son index puis ne demande que les octets des
    // fenetres. Sa duree est dans le conteneur, on la laisse a ffmpeg.
    return { url: entry, headers, duration: 0, kind: 'fichier', bitrate: 0 };
  }

  const text = await fetchText(entry, headers, timeoutMs);
  if (!text) return null;

  if (text.includes('#EXTINF')) {
    const { starts, duration } = segmentStarts(text);
    return { url: entry, headers, duration, starts, kind: 'playlist', bitrate: 0 };
  }
  if (!text.includes('#EXT-X-STREAM-INF')) return null;

  // Les URI d'un master rendu par notre proxy sont deja des URL de proxy absolues: elles
  // se ramenent a la boucle locale, elles ne se resolvent pas contre l'amont.
  const localize = (url) => (proxied ? streamProxy.localize(url) : url);

  const audio = parseAudioRendition(text, entry);
  const variants = parseVariants(text, entry).sort((a, b) => (a.bandwidth || 1e12) - (b.bandwidth || 1e12));
  const chosen = audio || variants[0]?.uri;
  if (!chosen) return null;

  const child = await fetchText(localize(chosen), headers, timeoutMs);
  // Le master peut renvoyer vers un autre master (CDN a deux etages): on ne descend pas
  // plus bas, ffmpeg saura le faire lui-meme, au prix d'un peu plus de trafic.
  if (!child || !child.includes('#EXTINF')) {
    return {
      url: localize(chosen),
      headers,
      duration: 0,
      fallbackUrl: entry,
      kind: audio ? 'audio' : 'variante',
      bitrate: audio ? 0 : variants[0]?.bandwidth || 0,
    };
  }

  const { starts, duration } = segmentStarts(child);
  return {
    url: localize(chosen),
    headers,
    duration,
    starts,
    // Repli quand la variante choisie s'avere ne porter QUE de la video: certains masters
    // annoncent un codec audio par variante alors que l'audio est dans une rendition a
    // part -- que ce master-la ne declare pas non plus. Le master, lui, sait assembler les
    // deux. Il coute plus cher a lire, d'ou l'ordre.
    fallbackUrl: entry,
    kind: audio ? 'audio' : 'variante',
    bitrate: audio ? 0 : variants[0]?.bandwidth || 0,
  };
}

module.exports = { locate, parseVariants, parseAudioRendition, playlistDuration, segmentStarts };
