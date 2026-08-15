const axios = require('axios');
const zlib = require('zlib');
const { promisify } = require('util');
const config = require('./config');
const tmdbClient = require('./tmdb');
const cache = require('./cache');

const gunzip = promisify(zlib.gunzip);

// API REST publique d'OpenSubtitles, la meme que celle utilisee par le player du site
// (HLSPlayer.tsx:3591-3601). Elle exige un User-Agent explicite.
const OS_BASE = 'https://rest.opensubtitles.org';
const OS_HEADERS = { 'User-Agent': 'Movix/1.0' };

/**
 * Cherche les sous-titres d'un titre pour UNE langue.
 *
 * Une seule langue par requete, comme le fait le lecteur du site
 * (HLSPlayer.tsx:4537-4547): l'API ne documente pas de liste separee par virgules, et
 * `sublanguageid-fre,eng` se solde par un 400 -- donc par une absence totale de
 * sous-titres, sans que rien n'indique pourquoi.
 */
async function searchLang({ bareImdb, lang, type, season, episode }) {
  const path =
    type === 'series' && season !== undefined && episode !== undefined
      ? `/search/episode-${episode}/imdbid-${bareImdb}/season-${season}/sublanguageid-${lang}`
      : `/search/imdbid-${bareImdb}/sublanguageid-${lang}`;

  const { data } = await axios.get(`${OS_BASE}${path}`, { headers: OS_HEADERS, timeout: 12000 });
  return Array.isArray(data) ? data : [];
}

/**
 * Cherche les sous-titres disponibles pour un titre, langue par langue.
 * Retourne les entrees brutes OpenSubtitles (SubDownloadLink, SubLanguageID, ...).
 */
async function search({ type, tmdbId, season, episode }) {
  const imdbId = await tmdbClient.getImdbId(type, tmdbId);
  if (!imdbId) return [];

  // OpenSubtitles attend l'id IMDB sans le prefixe "tt".
  const bareImdb = imdbId.replace(/^tt/, '');

  // Une langue en echec ne doit pas emporter les autres.
  const settled = await Promise.allSettled(
    config.SUBTITLE_LANGS.map((lang) => searchLang({ bareImdb, lang, type, season, episode })),
  );

  settled.forEach((result, index) => {
    if (result.status === 'rejected') {
      const status = result.reason?.response?.status;
      console.warn(
        `[subtitles] "${config.SUBTITLE_LANGS[index]}" a echoue (imdb=${bareImdb}): ` +
          `status=${status ?? 'n/a'} ${result.reason?.message || ''}`,
      );
    }
  });

  return settled.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
}

// Conversion alignee sur celle du lecteur du site (HLSPlayer.tsx:4610-4614).
function srtToVtt(srt) {
  const body = srt
    .replace(/\r\n/g, '\n')
    // Numeros de replique: WebVTT les tolere comme identifiants, mais certains lecteurs
    // les affichent a l'ecran. Le site les retire, on fait pareil.
    .replace(/^\s*\d+\s*$/gm, '')
    // Timestamps SRT (virgule) -> WebVTT (point).
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return `WEBVTT\n\n${body}`;
}

/**
 * Decode un Buffer de sous-titres. OpenSubtitles sert beaucoup de fichiers en latin-1/cp1252;
 * les lire en UTF-8 produit des caracteres de remplacement sur les accents francais.
 */
function decodeSubtitle(buffer) {
  const asUtf8 = buffer.toString('utf8');
  if (!asUtf8.includes('�')) return asUtf8;
  return buffer.toString('latin1');
}

/**
 * Telecharge un sous-titre OpenSubtitles (.gz contenant du .srt) et renvoie du WebVTT.
 * Stremio/Nuvio ne savent pas lire un .gz, d'ou ce passage par notre propre serveur.
 */
async function fetchAsVtt(downloadUrl) {
  const cacheKey = `sub:${downloadUrl}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const { data } = await axios.get(downloadUrl, {
    headers: OS_HEADERS,
    responseType: 'arraybuffer',
    timeout: 15000,
  });

  let buffer = Buffer.from(data);
  // Magic number gzip (1f 8b) -- certains miroirs servent le .srt deja decompresse.
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
    buffer = await gunzip(buffer);
  }

  const text = decodeSubtitle(buffer);
  const vtt = /^WEBVTT/.test(text.trim()) ? text : srtToVtt(text);
  cache.set(cacheKey, vtt, config.CACHE_TTL_MS);
  return vtt;
}

/**
 * URL de notre route de conversion pour un fichier OpenSubtitles.
 *
 * La source voyage dans le CHEMIN, encodee en base64url, et l'URL se termine par ".vtt".
 * Elle transitait auparavant par un parametre de requete (`?src=...`), ce qui la rendait
 * tributaire de tout ce qui touche a la query en route -- lecteur qui la tronque, proxy
 * inverse qui la reecrit -- et se soldait par un 400 sans explication. Un chemin opaque
 * ne peut pas etre mal interprete, et l'extension rassure les lecteurs qui la verifient.
 */
function subtitleUrl(publicBaseUrl, downloadUrl) {
  return `${publicBaseUrl}/subtitle/${Buffer.from(downloadUrl, 'utf8').toString('base64url')}.vtt`;
}

/**
 * Construit la liste de sous-titres au format Stremio.
 * Chaque URL pointe vers notre propre route qui fait la conversion a la volee.
 */
async function buildSubtitles({ type, tmdbId, season, episode, publicBaseUrl }) {
  if (!config.SUBTITLES_ENABLED) return [];

  const cacheKey = `subs:${type}:${tmdbId}:${season ?? '-'}:${episode ?? '-'}`;
  const found = await cache.wrap(cacheKey, config.CACHE_TTL_MS, config.CACHE_EMPTY_TTL_MS, () =>
    search({ type, tmdbId, season, episode }).catch((err) => {
      console.warn(`[subtitles] recherche echouee tmdbId=${tmdbId}: ${err.message}`);
      return [];
    }),
  );

  // Garder les meilleurs par langue plutot que de noyer l'utilisateur sous 40 entrees.
  const byLang = new Map();
  for (const sub of found) {
    const lang = sub.SubLanguageID;
    // Memes champs de repli que le lecteur du site (HLSPlayer.tsx:4592): tous les miroirs
    // ne renseignent pas SubDownloadLink.
    const link = sub.SubDownloadLink || sub.SubDownloadLinkForBrowser || sub.DownloadLink || sub.Link;
    if (!lang || !link) continue;

    const score = Number(sub.SubDownloadsCnt || 0);
    const existing = byLang.get(lang) || [];
    existing.push({ lang, link, score, name: sub.SubFileName || lang });
    byLang.set(lang, existing);
  }

  const subtitles = [];
  for (const [lang, entries] of byLang) {
    entries.sort((a, b) => b.score - a.score);
    entries.slice(0, 3).forEach((entry, index) => {
      subtitles.push({
        id: `movix-os-${lang}-${index}`,
        lang: index === 0 ? lang : `${lang} (${index + 1})`,
        url: subtitleUrl(publicBaseUrl, entry.link),
      });
    });
  }

  console.log(`[subtitles] tmdbId=${tmdbId} ${found.length} resultat(s) OpenSubtitles -> ${subtitles.length} piste(s)`);
  return subtitles;
}

module.exports = { buildSubtitles, fetchAsVtt, subtitleUrl };
