const axios = require('axios');

/**
 * Extraction VOE menee ici, en repli du service.
 *
 * Le service dedie (proxiesembed) reste la voie normale: il a un cache et un parc de
 * proxies. Mais il repond "404 Content not found" des que la page ne lui rend pas le bloc
 * JSON attendu -- ce qui arrive sur les domaines tout juste mis en service, ceux que Voe
 * renouvelle tous les mois. Le lien est alors parfaitement extractible, mais perdu.
 *
 * Ce module refait le meme travail: suivre les redirections jusqu'a la page de lecture,
 * y lire le bloc JSON obfusque, le dechiffrer. L'algorithme est celui de
 * server.py:3081-3116, porte tel quel -- c'est du desobfuscation, pas de la cryptographie:
 * il n'y a pas de cle, seulement une suite de transformations reversibles.
 */

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/139.0.0.0 Safari/537.36';

/** Bruit insere dans la chaine pour casser un decodage base64 naif. */
const JUNK = ['@$', '^^', '~@', '%?', '*~', '!!', '#&'];

function rot13(text) {
  return text.replace(/[a-z]/gi, (char) => {
    const base = char <= 'Z' ? 65 : 97;
    return String.fromCharCode(((char.charCodeAt(0) - base + 13) % 26) + base);
  });
}

/**
 * rot13 -> retrait du bruit -> base64 -> decalage de 3 -> inversion -> base64 -> JSON.
 *
 * Chaque etape est inoffensive prise seule; c'est leur empilement qui rend la chaine
 * illisible. Une seule erreur d'ordre donne du binaire, jamais une erreur explicite: d'ou
 * le test qui verifie la chaine complete sur un cas fabrique.
 */
function decrypt(encrypted) {
  let cleaned = rot13(String(encrypted));
  for (const symbol of JUNK) cleaned = cleaned.split(symbol).join('');

  const decoded = Buffer.from(cleaned, 'base64').toString('utf8');
  const shifted = [...decoded]
    .map((char) => String.fromCharCode(char.charCodeAt(0) - 3))
    .reverse()
    .join('');

  return JSON.parse(Buffer.from(shifted, 'base64').toString('utf8'));
}

/**
 * Bloc obfusque de la page. D'abord le `<script type="application/json">` officiel, puis --
 * si la page a change de forme -- n'importe quel tableau contenant une longue chaine.
 */
function extractJson(html) {
  const script = /<script[^>]*type=["']?\s*application\/json\s*["']?[^>]*>\s*([\s\S]*?)\s*<\/script>/i.exec(html);
  if (script) {
    try {
      const parsed = JSON.parse(script[1].trim());
      if (Array.isArray(parsed) && typeof parsed[0] === 'string') return parsed;
    } catch {
      // Bloc present mais illisible: le repli generique ci-dessous a encore sa chance.
    }
  }

  const loose = /\[\s*"(?:[^"\\]|\\.){100,}"\s*\]/.exec(html);
  if (loose) {
    try {
      return JSON.parse(loose[0]);
    } catch {
      return null;
    }
  }
  return null;
}

const REDIRECT_PATTERNS = [
  /window\.location\.href\s*=\s*['"]([^'"]+)['"]/i,
  /http-equiv=["']refresh["'][^>]*content=["'][^;]+;\s*url=([^"']+)/i,
  /https?:\/\/[a-z0-9.-]+\/e\/[a-z0-9]+/i,
];

/**
 * Voe fait rebondir la page une a trois fois avant de servir le lecteur, et pas toujours
 * par un vrai 3xx: souvent par un `window.location` ou un meta refresh, qu'aucun client
 * HTTP ne suit tout seul.
 */
async function fetchPlayerPage(embedUrl, { timeout = 8000, maxRedirects = 3 } = {}) {
  const http = axios.create({
    timeout,
    responseType: 'text',
    maxRedirects: 5,
    validateStatus: () => true,
    headers: { 'User-Agent': BROWSER_UA, Referer: 'https://voe.sx/' },
  });

  let current = embedUrl;
  let html = String((await http.get(current)).data || '');

  for (let hop = 0; hop < maxRedirects; hop += 1) {
    if (/type=["']?\s*application\/json/i.test(html) && html.includes('<script')) break;

    let target = null;
    for (const pattern of REDIRECT_PATTERNS) {
      const match = pattern.exec(html);
      if (match) {
        target = match[1] || match[0];
        break;
      }
    }
    if (!target) break;

    const next = new URL(target, current).toString();
    const response = await http.get(next, { headers: { Referer: current } });
    html = String(response.data || '');
    current = next;
  }

  return { html, url: current };
}

/**
 * @returns {Promise<{ok: true, url: string} | {ok: false, reason: string}>}
 */
async function extract(embedUrl) {
  const { html, url: playerUrl } = await fetchPlayerPage(embedUrl);

  const blob = extractJson(html);
  if (!blob) return { ok: false, reason: 'no-json', playerUrl };

  let data;
  try {
    data = decrypt(blob[0]);
  } catch (err) {
    return { ok: false, reason: `decrypt-failed (${err.message})`, playerUrl };
  }

  const source = [data?.source, data?.file, data?.direct_access_url].find(
    (value) => typeof value === 'string' && /^https?:\/\//i.test(value),
  );
  if (!source) return { ok: false, reason: 'no-source', playerUrl };

  return { ok: true, url: source, playerUrl };
}

module.exports = { extract, decrypt, extractJson, BROWSER_UA };
