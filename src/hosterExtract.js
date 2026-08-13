const axios = require('axios');
const { mainApi, proxiesEmbed } = require('./movixClient');

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * Darkibox et OneUpload sont extraits par regex sur le HTML de la page embed.
 * Le frontend passe par un proxy CORS (contrainte navigateur uniquement) -- depuis Node
 * on interroge le hoster directement, ce qui evite un intermediaire.
 */
async function fetchEmbedHtml(url, referer) {
  const { data } = await axios.get(url, {
    timeout: 8000,
    responseType: 'text',
    headers: { 'User-Agent': BROWSER_UA, ...(referer ? { Referer: referer } : {}) },
  });
  return typeof data === 'string' ? data : String(data);
}

function firstMatch(html, patterns) {
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && match[1]) return match[1];
  }
  return null;
}

// Miroir de src/utils/hosterRegistry.ts (BUILTIN_HOSTER_PATTERNS) -- garder synchronise si
// Movix ajoute/renomme des hosters cote frontend.
const HOSTER_PATTERNS = {
  voe: [/voe\./i],
  vidmoly: [/vidmoly/i],
  uqload: [/uqload/i],
  sibnet: [/sibnet/i],
  doodstream: [/doodstream/i, /d0000d/i, /d000d/i, /dood\./i, /doodster/i, /myvidplay/i, /dsvplay/i, /doply/i, /ds2play/i, /ds2video/i, /dood2/i],
  seekstreaming: [/embedseek/i, /embed4me/i, /seekstreaming/i],
  vidzy: [/vidzy/i],
  supervideo: [/supervideo/i],
  dropload: [/dropload/i],
  fsvid: [/fsvid/i],
  darkibox: [/darkibox/i],
  oneupload: [/oneupload/i],
};

// smoothpre et minochinos figurent dans hosterRegistry.ts cote site mais n'ont AUCUN
// extracteur (ni serveur, ni extension): ce sont uniquement des motifs de detection
// utilises pour l'ordre de priorite des sources. Rien a porter ici.

function detectHoster(url, playerNameHint) {
  const haystack = `${url} ${playerNameHint || ''}`;
  for (const [hoster, patterns] of Object.entries(HOSTER_PATTERNS)) {
    if (patterns.some((pattern) => pattern.test(haystack))) return hoster;
  }
  return null;
}

// Chaque extracteur reproduit exactement l'appel + le champ de reponse utilise par
// src/utils/extractM3u8.ts cote frontend (verifie ligne par ligne).
async function extractDirectUrl(embedUrl, playerNameHint) {
  const hoster = detectHoster(embedUrl, playerNameHint);
  // Pas d'extracteur connu: le lien reste un embed HTML, injouable tel quel par
  // Stremio/Nuvio qui attendent une URL video directe.
  if (!hoster) return { ok: false, reason: 'no-extractor' };

  // --- Extracteurs par scraping HTML direct (pas de service dedie cote Movix) ---
  if (hoster === 'darkibox' || hoster === 'oneupload') {
    try {
      const html = await fetchEmbedHtml(embedUrl, hoster === 'oneupload' ? 'https://oneupload.net/' : undefined);

      if (hoster === 'darkibox') {
        // Darkibox: bloc `sources: [{src: "...m3u8"}]` (cf. extractM3u8.ts:536-548).
        const block = html.match(/sources:\s*\[([\s\S]*?)\]/);
        const url = block ? firstMatch(block[1], [/src:\s*"([^"]+)"/]) : null;
        if (url && url.includes('.m3u8')) return { ok: true, url, hoster };
      } else {
        // OneUpload: file/source/src, m3u8 d'abord puis mp4 (cf. extractM3u8.ts:908-947).
        const url = firstMatch(html, [
          /file:\s*["']([^"']+\.m3u8[^"']*)/i,
          /source:\s*["']([^"']+\.m3u8[^"']*)/i,
          /src:\s*["']([^"']+\.m3u8[^"']*)/i,
          /"file":\s*"([^"]+\.m3u8[^"]*)"/i,
          /"source":\s*"([^"]+\.m3u8[^"]*)"/i,
          /file:\s*["']([^"']+\.mp4[^"']*)/i,
          /source:\s*["']([^"']+\.mp4[^"']*)/i,
          /src:\s*["']([^"']+\.mp4[^"']*)/i,
          /"file":\s*"([^"]+\.mp4[^"]*)"/i,
          /"source":\s*"([^"]+\.mp4[^"]*)"/i,
        ]);
        if (url) return { ok: true, url, hoster };
      }

      console.warn(`[extract:${hoster}] aucune source trouvee dans le HTML de ${embedUrl}`);
      return { ok: false, reason: 'no-url-field', hoster };
    } catch (err) {
      console.warn(`[extract:${hoster}] echec HTTP pour ${embedUrl}: ${err.message}`);
      return { ok: false, reason: 'http-error', hoster };
    }
  }

  let data;
  try {
    switch (hoster) {
      case 'voe': {
        const base64Url = Buffer.from(embedUrl, 'utf8').toString('base64');
        ({ data } = await proxiesEmbed.get('/api/voe/m3u8', { params: { url: base64Url } }));
        break;
      }
      case 'uqload': {
        const normalized = embedUrl.replace(/uqload\.[a-z0-9-]+/gi, 'uqload.is');
        ({ data } = await proxiesEmbed.get('/api/extract-uqload', { params: { url: normalized } }));
        break;
      }
      case 'vidzy':
        ({ data } = await proxiesEmbed.get('/api/extract-vidzy', { params: { url: embedUrl } }));
        break;
      case 'fsvid':
        ({ data } = await proxiesEmbed.get('/api/extract-fsvid', { params: { url: embedUrl } }));
        break;
      case 'vidmoly':
        ({ data } = await proxiesEmbed.get('/api/extract-vidmoly', { params: { url: embedUrl } }));
        break;
      case 'sibnet':
        ({ data } = await proxiesEmbed.get('/api/extract-sibnet', { params: { url: embedUrl } }));
        break;
      case 'doodstream':
        ({ data } = await proxiesEmbed.get('/api/extract-doodstream', { params: { url: embedUrl } }));
        break;
      case 'seekstreaming': {
        const cleaned = embedUrl.replace(/#/g, '%23');
        ({ data } = await proxiesEmbed.get('/api/extract-seekstreaming', { params: { url: cleaned } }));
        break;
      }
      // supervideo/dropload passent par Mainapi, pas par proxiesembed (cf. extractM3u8.ts:237-239)
      case 'supervideo':
        ({ data } = await mainApi.get('/api/extract-supervideo', { params: { url: embedUrl } }));
        break;
      case 'dropload':
        ({ data } = await mainApi.get('/api/extract-dropload', { params: { url: embedUrl } }));
        break;
      default:
        return { ok: false, reason: 'no-extractor', hoster };
    }
  } catch (err) {
    const status = err.response?.status;
    console.warn(`[extract:${hoster}] echec HTTP pour ${embedUrl}: status=${status ?? 'n/a'} msg=${err.message}`);
    return { ok: false, reason: 'http-error', hoster, status };
  }

  const url =
    data.source || data.url || data.sourceUrl || data.m3u8Url || data.hlsUrl || data.ip_url || data.data?.url || data.link || data.file;

  if (!url) {
    console.warn(`[extract:${hoster}] reponse OK mais aucun champ URL reconnu pour ${embedUrl} -- reponse: ${JSON.stringify(data).slice(0, 300)}`);
    return { ok: false, reason: 'no-url-field', hoster };
  }

  return { ok: true, url, hoster };
}

module.exports = { detectHoster, extractDirectUrl };
