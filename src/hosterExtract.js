const { mainApi, proxiesEmbed } = require('./movixClient');

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
};

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
  if (!hoster) return null;

  try {
    switch (hoster) {
      case 'voe': {
        const base64Url = Buffer.from(embedUrl, 'utf8').toString('base64');
        const { data } = await proxiesEmbed.get('/api/voe/m3u8', { params: { url: base64Url } });
        return data.source ? { url: data.source, hoster } : null;
      }
      case 'uqload': {
        const normalized = embedUrl.replace(/uqload\.[a-z0-9-]+/gi, 'uqload.is');
        const { data } = await proxiesEmbed.get('/api/extract-uqload', { params: { url: normalized } });
        const url = data.data?.url || data.url;
        return url ? { url, hoster } : null;
      }
      case 'vidzy': {
        const { data } = await proxiesEmbed.get('/api/extract-vidzy', { params: { url: embedUrl } });
        return data.m3u8Url ? { url: data.m3u8Url, hoster } : null;
      }
      case 'fsvid': {
        const { data } = await proxiesEmbed.get('/api/extract-fsvid', { params: { url: embedUrl } });
        const url = data.m3u8Url || data.url || data.link || data.file || data.source;
        return url ? { url, hoster } : null;
      }
      case 'vidmoly': {
        const { data } = await proxiesEmbed.get('/api/extract-vidmoly', { params: { url: embedUrl } });
        return data.sourceUrl ? { url: data.sourceUrl, hoster } : null;
      }
      case 'sibnet': {
        const { data } = await proxiesEmbed.get('/api/extract-sibnet', { params: { url: embedUrl } });
        return data.sourceUrl ? { url: data.sourceUrl, hoster } : null;
      }
      case 'doodstream': {
        const { data } = await proxiesEmbed.get('/api/extract-doodstream', { params: { url: embedUrl } });
        return data.url ? { url: data.url, hoster } : null;
      }
      case 'seekstreaming': {
        const cleaned = embedUrl.replace(/#/g, '%23');
        const { data } = await proxiesEmbed.get('/api/extract-seekstreaming', { params: { url: cleaned } });
        const url = data.url || data.ip_url;
        return url ? { url, hoster } : null;
      }
      // supervideo/dropload passent par Mainapi, pas par proxiesembed (cf. extractM3u8.ts:237-239)
      case 'supervideo': {
        const { data } = await mainApi.get('/api/extract-supervideo', { params: { url: embedUrl } });
        return data.hlsUrl ? { url: data.hlsUrl, hoster } : null;
      }
      case 'dropload': {
        const { data } = await mainApi.get('/api/extract-dropload', { params: { url: embedUrl } });
        return data.m3u8Url ? { url: data.m3u8Url, hoster } : null;
      }
      default:
        return null;
    }
  } catch (err) {
    console.warn(`[extract:${hoster}] echec pour ${embedUrl}: ${err.message}`);
    return null;
  }
}

module.exports = { detectHoster, extractDirectUrl };
