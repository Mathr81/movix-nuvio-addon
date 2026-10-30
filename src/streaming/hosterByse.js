const crypto = require('crypto');
const axios = require('axios');

/**
 * Extraction Byse: le lecteur qui sert desormais Filemoon (filemoon.sx) et ses miroirs
 * anonymes (bysebuho, bysewihe, kaydendown...).
 *
 * La page d'embed est une appli React vide; tout passe par `GET /api/videos/<code>` sur
 * le domaine de l'embed, dont le champ `playback` est chiffre en AES-256-GCM:
 *   - `payload` = texte chiffre suivi de l'etiquette GCM (16 octets), en base64url;
 *   - la cle = deux des `key_parts` (base64url), choisies d'apres `version`: les indices
 *     (1-based) `version` et `31 - version`, les autres sont des leurres. Repris du
 *     lecteur (videoPagesBundle, fonctions `Qa`/`ws`/`ks`, 2026-10).
 */

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function decryptPlayback(playback) {
  const parts = Array.isArray(playback?.key_parts) ? playback.key_parts : [];
  const version = Number(playback?.version);
  const picked = Number.isInteger(version) && version >= 1 && version <= 20 && 31 - version <= parts.length
    ? [parts[version - 1], parts[30 - version]]
    : parts;
  const key = Buffer.concat(picked.map((part) => Buffer.from(part, 'base64url')));
  const data = Buffer.from(playback.payload, 'base64url');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(playback.iv, 'base64url'));
  decipher.setAuthTag(data.subarray(-16));
  return JSON.parse(Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]).toString('utf8'));
}

/**
 * @returns {Promise<{ok: true, url: string, origin: string} | {ok: false, reason: string}>}
 * Les erreurs de transport remontent; une video supprimee rend `unavailable`.
 */
async function extract(embedUrl) {
  const { origin, pathname } = new URL(embedUrl);
  const code = pathname.split('/').filter(Boolean).pop();
  const res = await axios.get(`${origin}/api/videos/${code}`, {
    timeout: 8000,
    validateStatus: (status) => status < 500,
    headers: { 'User-Agent': BROWSER_UA, Referer: embedUrl },
  });
  if (res.status === 404 || res.status === 410) return { ok: false, reason: 'unavailable' };
  if (!res.data?.playback) return { ok: false, reason: 'no-playback' };

  let data;
  try {
    data = decryptPlayback(res.data.playback);
  } catch (err) {
    return { ok: false, reason: `decrypt-failed (${err.message})` };
  }
  // Plusieurs qualites possibles: la plus haute d'abord.
  const sources = (data.sources || []).filter((s) => typeof s.url === 'string').sort((a, b) => (b.height || 0) - (a.height || 0));
  if (!sources[0]) return { ok: false, reason: 'no-source' };
  return { ok: true, url: sources[0].url, origin };
}

module.exports = { extract, decryptPlayback, BROWSER_UA };
