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
 * Cherche les sous-titres disponibles pour un titre.
 * Retourne les entrees brutes OpenSubtitles (SubDownloadLink, SubLanguageID, ...).
 */
async function search({ type, tmdbId, season, episode }) {
  const imdbId = await tmdbClient.getImdbId(type, tmdbId);
  if (!imdbId) return [];

  // OpenSubtitles attend l'id IMDB sans le prefixe "tt".
  const bareImdb = imdbId.replace(/^tt/, '');
  const langs = config.SUBTITLE_LANGS.join(',');

  const path =
    type === 'series' && season !== undefined && episode !== undefined
      ? `/search/episode-${episode}/imdbid-${bareImdb}/season-${season}/sublanguageid-${langs}`
      : `/search/imdbid-${bareImdb}/sublanguageid-${langs}`;

  const { data } = await axios.get(`${OS_BASE}${path}`, { headers: OS_HEADERS, timeout: 12000 });
  return Array.isArray(data) ? data : [];
}

function srtToVtt(srt) {
  const body = srt
    .replace(/\r\n/g, '\n')
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
 * Construit la liste de sous-titres au format Stremio.
 * Chaque URL pointe vers notre propre route /subtitle.vtt qui fait la conversion a la volee.
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
    const link = sub.SubDownloadLink;
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
        url: `${publicBaseUrl}/subtitle.vtt?src=${encodeURIComponent(entry.link)}`,
      });
    });
  }

  console.log(`[subtitles] tmdbId=${tmdbId} ${found.length} resultat(s) OpenSubtitles -> ${subtitles.length} piste(s)`);
  return subtitles;
}

module.exports = { buildSubtitles, fetchAsVtt };
