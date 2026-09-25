const axios = require('axios');

/**
 * Extraction Veev (veev.to, poophq, doods.to) menee ici.
 *
 * Movix sait la faire, mais seulement dans sa resolution serveur, qui echoue souvent sur
 * ces liens: les lecteurs Veev restaient donc sans flux. Ce module porte l'algorithme de
 * proxiesembed (hoster_decoders.py + veev_extract_handler), aligne sur le plugin
 * ResolveURL `veev.py`:
 *
 *   1. la page d'embed ne porte pas l'URL du flux mais un DEFI `ch`, compresse en LZW;
 *   2. `/dl?op=player_api&cmd=gi&file_code=<code>&ch=<defi>` rend l'URL encodee (`dv[0].s`);
 *   3. celle-ci se decode en LZW puis par passes hex (avec inversion eventuelle), dans un
 *      ordre derive du defi lui-meme.
 *
 * Aucune cle: des transformations reversibles, rien de plus.
 */

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';
const CHALLENGE_RE = /[.\s'](?:fc|_vvto\[[^\]]*)(?:['\]]*)?\s*[:=]\s*['"]([^'"]+)['"]/g;
const UTF8_PADDING = 'dXRmOA==';
// Une charge saine tient largement dedans; au-dela, page piegee ou corrompue.
const MAX_PAYLOAD = 200000;

/** Decompression LZW telle que l'implemente le lecteur Veev. */
function lzwDecode(encoded) {
  const text = String(encoded || '');
  if (!text) return '';
  const chars = [...text];
  const result = [chars[0]];
  const lut = new Map();
  let nextCode = 256;
  let current = chars[0];
  for (const char of chars.slice(1)) {
    const code = char.codePointAt(0);
    const next = code < 256 ? char : lut.get(code) ?? current + current[0];
    result.push(next);
    lut.set(nextCode, current + next[0]);
    nextCode += 1;
    current = next;
  }
  return result.join('');
}

/** `parseInt` facon JS sur un caractere: un non-chiffre vaut 0, pas une erreur. */
const jsInt = (char) => (/^\d$/.test(char) ? Number(char) : 0);

/** Defi -> suite de groupes d'operations a rejouer sur l'URL. */
function buildArray(challenge) {
  const groups = [];
  const chars = [...String(challenge || '')];
  if (chars.length === 0) return groups;
  let count = jsInt(chars.shift());
  while (count) {
    const current = [];
    for (let i = 0; i < count; i += 1) {
      if (chars.length === 0) return groups;
      current.unshift(jsInt(chars.shift()));
    }
    groups.push(current);
    if (chars.length === 0) break;
    count = jsInt(chars.shift());
  }
  return groups;
}

/** Rejoue les passes hex (et l'inversion quand l'operation vaut 1) sur l'URL encodee. */
function decodeUrl(encoded, operations) {
  let decoded = String(encoded || '');
  if (!decoded || decoded.length > MAX_PAYLOAD) return null;
  for (const operation of operations) {
    if (operation === 1) decoded = [...decoded].reverse().join('');
    if (!/^(?:[0-9a-f]{2})*$/i.test(decoded)) return null;
    decoded = Buffer.from(decoded, 'hex').toString('utf8').split(UTF8_PADDING).join('');
  }
  return decoded.startsWith('http') ? decoded : null;
}

/** Defis candidats d'une page, du plus recent au plus ancien. */
function extractChallenges(html) {
  const out = [];
  const matches = [...String(html || '').matchAll(CHALLENGE_RE)].map((m) => m[1]).reverse();
  for (const raw of matches) {
    if (raw.length > MAX_PAYLOAD) continue;
    const decoded = lzwDecode(raw);
    // Une chaine non compressee se decode en elle-meme: ce n'est pas un defi.
    if (decoded && decoded !== raw) out.push(decoded);
  }
  return out;
}

const mediaIdOf = (url) => {
  const id = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
  return /^[0-9a-zA-Z]+$/.test(id) ? id : null;
};

/**
 * @returns {Promise<{ok: true, url: string, origin: string} | {ok: false, reason: string}>}
 * Les erreurs de TRANSPORT remontent (l'appelant en tient le compte des pannes).
 */
async function extract(embedUrl, { timeout = 10000 } = {}) {
  const parsed = new URL(embedUrl);
  let mediaId = mediaIdOf(embedUrl);
  if (!mediaId) return { ok: false, reason: 'bad-url' };

  const pageUrl = `https://${parsed.hostname}/e/${mediaId}`;
  const headers = { Accept: 'text/html,*/*', Referer: pageUrl, 'User-Agent': BROWSER_UA };
  const page = await axios.get(pageUrl, { timeout, headers, responseType: 'text', maxRedirects: 5 });
  // Une redirection change le code fichier: on repart de celui servi.
  const finalUrl = page.request?.res?.responseUrl || pageUrl;
  mediaId = mediaIdOf(finalUrl) || mediaId;
  const host = new URL(finalUrl).hostname;

  const challenges = extractChallenges(page.data);
  if (challenges.length === 0) return { ok: false, reason: 'no-challenge' };

  for (const challenge of challenges) {
    let payload;
    try {
      ({ data: payload } = await axios.get(`https://${host}/dl`, {
        timeout,
        headers,
        params: { op: 'player_api', cmd: 'gi', file_code: mediaId, ch: challenge, ie: 1 },
      }));
    } catch {
      continue;
    }
    const file = payload?.file;
    if (!file || file.file_status !== 'OK' || !Array.isArray(file.dv) || !file.dv[0]?.s) continue;
    const operations = buildArray(challenge);
    if (operations.length === 0) continue;
    const url = decodeUrl(lzwDecode(file.dv[0].s), operations[0]);
    if (url) return { ok: true, url, origin: `https://${host}` };
  }
  return { ok: false, reason: 'unavailable' };
}

module.exports = { extract, lzwDecode, buildArray, decodeUrl, extractChallenges, BROWSER_UA };
