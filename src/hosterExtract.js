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
  // Pas d'extracteur connu: le lien reste un embed HTML, injouable tel quel par
  // Stremio/Nuvio qui attendent une URL video directe.
  if (!hoster) return { ok: false, reason: 'no-extractor' };

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
