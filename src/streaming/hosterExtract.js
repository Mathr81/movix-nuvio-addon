const axios = require('axios');
const config = require('../core/config');
const breaker = require('../core/breaker');
const voe = require('./hosterVoe');
const streamProxy = require('./streamProxy');
const { mainApi, proxiesEmbed } = require('../integrations/movixClient');

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

/**
 * Miroir de src/utils/hosterRegistry.ts (BUILTIN_HOSTER_PATTERNS).
 *
 * Deux strategies, selon le nom de l'hebergeur:
 *  - nom distinctif (uqload, vidmoly, fsvid...): un simple mot suffit et couvre tous ses
 *    TLD presents et futurs;
 *  - nom trop court ou domaines DELIBEREMENT anonymes: il faut une liste explicite. Voe
 *    en est le cas d'ecole -- il renouvelle ses domaines de sortie environ tous les mois,
 *    avec des noms qui ne contiennent pas "voe" (ralphysuccessfull.com, prepareddare...).
 *
 * Cette liste vieillit donc par construction: un domaine tout juste mis en service n'y
 * figure pas encore, et l'embed passe alors pour "sans extracteur" alors qu'il est
 * parfaitement extractible. HOSTER_PATTERNS_EXTRA permet d'en ajouter sans toucher au
 * code, comme le site le fait avec ses "hosters custom & regex".
 */
const BUILTIN_HOSTER_PATTERNS = {
  voe: [
    'voe\\.',
    // Alias sans "voe" dans le nom, releves dans les redirections 302 de l'hebergeur.
    'ralphysuccessfull', 'claudiosepulchral', 'anthonysaline', 'auraleanline',
    'letsupload', 'robertordercharacter', 'prepareddare', 'preferciseaccurate',
    'conscientiousedu', 'effortlessexperim', 'timmaybealready',
  ],
  vidmoly: ['vidmoly'],
  uqload: ['uqload'],
  sibnet: ['sibnet'],
  doodstream: [
    'doodstream', 'd0000d', 'd000d', 'dood\\.', 'doodster',
    'myvidplay', 'dsvplay', 'doply', 'ds2play', 'ds2video', 'dood2',
  ],
  seekstreaming: [
    'embedseek', 'embed4me', 'seekstreaming',
    'servicecatalog', 'technicalcatalog', 'seekplayer', 'seeks\\.cloud', 'seekplays',
  ],
  vidzy: ['vidzy'],
  supervideo: ['supervideo'],
  dropload: ['dropload'],
  fsvid: ['fsvid'],
  darkibox: ['darkibox'],
  oneupload: ['oneupload'],
};

// smoothpre et minochinos figurent dans hosterRegistry.ts cote site mais n'ont AUCUN
// extracteur (ni serveur, ni extension): ce sont uniquement des motifs de detection
// utilises pour l'ordre de priorite des sources. Rien a porter ici.

/** Motifs compiles, alias supplementaires de la configuration inclus. */
const HOSTER_PATTERNS = (() => {
  const merged = Object.fromEntries(
    Object.entries(BUILTIN_HOSTER_PATTERNS).map(([hoster, patterns]) => [hoster, [...patterns]]),
  );

  for (const entry of config.HOSTER_PATTERNS_EXTRA) {
    const separator = entry.indexOf(':');
    const hoster = entry.slice(0, separator).trim().toLowerCase();
    const pattern = entry.slice(separator + 1).trim();
    if (separator < 1 || !pattern) {
      console.warn(`[extract] HOSTER_PATTERNS_EXTRA: "${entry}" ignore (attendu "hebergeur:motif")`);
      continue;
    }
    if (!merged[hoster]) {
      console.warn(`[extract] HOSTER_PATTERNS_EXTRA: hebergeur inconnu "${hoster}" (connus: ${Object.keys(merged).join(', ')})`);
      continue;
    }
    merged[hoster].push(pattern);
    console.log(`[extract] motif supplementaire pour ${hoster}: ${pattern}`);
  }

  return Object.fromEntries(
    Object.entries(merged).map(([hoster, patterns]) => [
      hoster,
      patterns.map((pattern) => {
        try {
          return new RegExp(pattern, 'i');
        } catch {
          console.warn(`[extract] motif invalide ignore pour ${hoster}: ${pattern}`);
          return null;
        }
      }).filter(Boolean),
    ]),
  );
})();

function detectHoster(url, playerNameHint) {
  const haystack = `${url} ${playerNameHint || ''}`;
  for (const [hoster, patterns] of Object.entries(HOSTER_PATTERNS)) {
    if (patterns.some((pattern) => pattern.test(haystack))) return hoster;
  }
  return null;
}

/**
 * Domaine canonique attendu par proxiesembed pour chaque hebergeur.
 *
 * Le service VALIDE le domaine de l'URL d'embed avant d'extraire quoi que ce soit, et
 * repond "400 Invalid URL" pour tout autre miroir (server.py:3401-3419 pour fsvid/vidzy,
 * uqload_utils.py:9 pour uqload). Or les sources donnent regulierement un miroir: c'est
 * pour cela que seul fsvid fonctionnait -- FStream sert justement ses liens fsvid sur le
 * domaine canonique, et les autres non.
 *
 * On ramene donc l'hote sur ce domaine, exactement comme le site le fait pour uqload
 * (extractM3u8.ts:456). L'identifiant de la video, lui, est le meme d'un miroir a l'autre.
 */
const CANONICAL_DOMAIN = {
  uqload: 'uqload.is',
  vidzy: 'vidzy.org',
  fsvid: 'fsvid.lol',
};

function normalizeEmbedUrl(hoster, embedUrl) {
  const canonical = CANONICAL_DOMAIN[hoster];
  if (!canonical) return embedUrl;
  // `vidzy.to` -> `vidzy.org`, en preservant un eventuel sous-domaine (`v4.vidzy.org`).
  const [name] = canonical.split('.');
  return embedUrl.replace(new RegExp(`${name}\\.[a-z0-9.-]+`, 'gi'), canonical);
}

/**
 * URL de flux dans une reponse d'extracteur.
 *
 * On retient le premier champ qui contient une VRAIE URL, et non le premier champ present:
 * plusieurs services repondent {"source":"fsvid","url":"https://..."}, ou "source" nomme
 * l'hebergeur. Prendre ce champ par priorite produisait des streams dont l'URL etait
 * litteralement "fsvid" -- injouables, et remis tels quels a Nuvio.
 */
function pickStreamUrl(data) {
  return [data.source, data.url, data.sourceUrl, data.m3u8Url, data.hlsUrl, data.ip_url, data.data?.url, data.link, data.file]
    .filter((value) => typeof value === 'string')
    // Une URL sans schema (//host/path) est valide: il lui manque juste le protocole.
    .map((value) => (value.startsWith('//') ? `https:${value}` : value))
    .find((value) => /^https?:\/\//i.test(value));
}

/**
 * Disjoncteur par hebergeur: seekstreaming rendait cinq 502 d'affilee par fiche, chacun
 * paye au prix d'un aller-retour et d'un delai d'attente.
 */
const extractBreaker = breaker.create({
  streak: () => config.HOSTER_FAILURE_STREAK,
  cooldownMs: () => config.HOSTER_COOLDOWN_MS,
  label: 'extract',
});

const breakerState = extractBreaker.state;

/**
 * Voe extrait ici, quand le service a renonce.
 *
 * Le flux obtenu vient du CDN de Voe, qui n'accepte que le Referer de son propre lecteur:
 * on le passe par le proxy de flux, exactement comme les addons. Sans ca l'URL serait
 * exacte et pourtant injouable.
 */
async function extractVoeLocally(embedUrl) {
  try {
    const result = await voe.extract(embedUrl);
    if (!result.ok) {
      console.warn(`[extract:voe] repli local sans resultat pour ${embedUrl}: ${result.reason}`);
      return null;
    }

    console.log(`[extract:voe] repli local reussi pour ${embedUrl}`);
    const url = config.STREAM_PROXY_ENABLED
      ? streamProxy.proxyUrl(result.url, {
          headers: {
            accept: '*/*',
            origin: 'https://voe.sx',
            referer: 'https://voe.sx/',
            'user-agent': voe.BROWSER_UA,
          },
        })
      : result.url;
    return { ok: true, url, hoster: 'voe' };
  } catch (err) {
    console.warn(`[extract:voe] repli local en echec pour ${embedUrl}: ${err.message}`);
    return null;
  }
}

// Chaque extracteur reproduit exactement l'appel + le champ de reponse utilise par
// src/utils/extractM3u8.ts cote frontend (verifie ligne par ligne).
async function extractDirectUrl(embedUrl, playerNameHint) {
  const hoster = detectHoster(embedUrl, playerNameHint);
  // Pas d'extracteur connu: le lien reste un embed HTML, injouable tel quel par
  // Stremio/Nuvio qui attendent une URL video directe.
  if (!hoster) return { ok: false, reason: 'no-extractor' };

  // Service connu pour etre en panne a l'instant: on ne paye pas l'aller-retour.
  if (extractBreaker.isOpen(hoster)) return { ok: false, reason: 'cooldown', hoster };

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

  // Ramene l'hote sur le domaine que le service exige avant meme d'extraire.
  const target = normalizeEmbedUrl(hoster, embedUrl);

  let data;
  try {
    switch (hoster) {
      case 'voe': {
        // Seul extracteur a attendre l'URL encodee en base64 (server.py:2989).
        const base64Url = Buffer.from(target, 'utf8').toString('base64');
        ({ data } = await proxiesEmbed.get('/api/voe/m3u8', { params: { url: base64Url } }));
        break;
      }
      case 'uqload':
        ({ data } = await proxiesEmbed.get('/api/extract-uqload', { params: { url: target } }));
        break;
      case 'vidzy':
        ({ data } = await proxiesEmbed.get('/api/extract-vidzy', { params: { url: target } }));
        break;
      case 'fsvid':
        ({ data } = await proxiesEmbed.get('/api/extract-fsvid', { params: { url: target } }));
        break;
      case 'vidmoly':
        ({ data } = await proxiesEmbed.get('/api/extract-vidmoly', { params: { url: target } }));
        break;
      case 'sibnet':
        ({ data } = await proxiesEmbed.get('/api/extract-sibnet', { params: { url: target } }));
        break;
      case 'doodstream':
        ({ data } = await proxiesEmbed.get('/api/extract-doodstream', { params: { url: target } }));
        break;
      case 'seekstreaming': {
        const cleaned = target.replace(/#/g, '%23');
        ({ data } = await proxiesEmbed.get('/api/extract-seekstreaming', { params: { url: cleaned } }));
        break;
      }
      // supervideo/dropload passent par Mainapi, pas par proxiesembed (cf. extractM3u8.ts:237-239)
      case 'supervideo':
        ({ data } = await mainApi.get('/api/extract-supervideo', { params: { url: target } }));
        break;
      case 'dropload':
        ({ data } = await mainApi.get('/api/extract-dropload', { params: { url: target } }));
        break;
      default:
        return { ok: false, reason: 'no-extractor', hoster };
    }
  } catch (err) {
    const status = err.response?.status;
    // Le CORPS de l'erreur porte la raison exacte ("Invalid URL" = domaine refuse,
    // "Fetch failed" = l'hebergeur n'a pas repondu, 403 = cle VIP rejetee). Sans lui, un
    // 400 ne dit rien de ce qu'il faut corriger.
    const body = err.response?.data ? ` body=${JSON.stringify(err.response.data).slice(0, 200)}` : '';
    console.warn(`[extract:${hoster}] echec HTTP pour ${target}: status=${status ?? 'n/a'} msg=${err.message}${body}`);

    // Panne de service (5xx, timeout, reseau) vs refus portant sur cette video (4xx).
    if (!status || status >= 500) extractBreaker.noteOutage(hoster);

    if (hoster === 'voe') {
      const local = await extractVoeLocally(target);
      if (local) return local;
    }
    return { ok: false, reason: 'http-error', hoster, status, error: err.response?.data?.error };
  }

  extractBreaker.noteRecovery(hoster);
  const url = pickStreamUrl(data);

  if (!url) {
    console.warn(`[extract:${hoster}] reponse OK mais aucune URL exploitable pour ${embedUrl} -- reponse: ${JSON.stringify(data).slice(0, 300)}`);
    if (hoster === 'voe') {
      const local = await extractVoeLocally(target);
      if (local) return local;
    }
    return { ok: false, reason: 'no-url-field', hoster };
  }

  return { ok: true, url, hoster };
}

module.exports = { detectHoster, extractDirectUrl, pickStreamUrl, normalizeEmbedUrl, breakerState };
