const axios = require('axios');
const { mainApi } = require('../integrations/movixClient');
const config = require('../core/config');
const cache = require('../core/cache');

/**
 * Sources de flux de la playlist IPTV.
 *
 * Chaque source sait faire deux choses: LISTER ses flux (un libelle brut et de quoi le
 * retrouver) et en RESOUDRE un en URL jouable, a la demande. La resolution est separee du
 * listing parce qu'une URL de direct ne se garde pas: celle de Vavoo porte un jeton qui
 * tourne, celle de l'IPTV une signature datee. La playlist ne contient donc jamais ces
 * URLs, seulement un lien vers notre route `play`, qui resout au moment de zapper.
 *
 *   vavoo   HLS gratuit, trois fournisseurs (.s/.b/.c) derriere un catalogue par pays.
 *   xtream  bouquet "IPTV web" de Movix, reserve aux VIP, servi signe par proxiesembed.
 *   m3u     playlists tierces (IPTV_EXTRA_M3U), deja porteuses d'URLs directes.
 *
 * NorthLive n'est pas une source: ce sont les memes flux Vavoo (ses "Serveur B/S/C"),
 * derriere un lecteur web et un jeton de lecture. Rien a y gagner.
 */

const LIST_TIMEOUT_MS = 20000;
const RESOLVE_TIMEOUT_MS = 10000;

// Movix garde lui-meme une minute la resolution Vavoo: inutile de la tenir plus longtemps,
// son jeton vieillit. La signature IPTV vaut 24 h, on en reprend une toutes les heures.
const VAVOO_RESOLVE_TTL_MS = 45 * 1000;
const XTREAM_RESOLVE_TTL_MS = 60 * 60 * 1000;

// --- Vavoo -------------------------------------------------------------------

async function listVavoo() {
  const out = [];
  for (const slug of config.IPTV_VAVOO_GROUPS) {
    const { data } = await mainApi.get(`/api/livetv/catalog/tv/vavoo_${encodeURIComponent(slug)}`, {
      timeout: LIST_TIMEOUT_MS,
    });
    for (const meta of data?.metas || []) {
      const ref = String(meta?.id || '').replace(/^vavoo_/, '');
      if (!ref || !meta.name) continue;
      out.push({
        source: 'vavoo',
        sid: `v${ref}`,
        ref,
        label: meta.name,
        logo: meta.logo || meta.poster || '',
        hints: [slug, meta.description],
      });
    }
  }
  return out;
}

async function resolveVavoo(entry) {
  return cache.wrap(`iptv:resolve:${entry.sid}`, VAVOO_RESOLVE_TTL_MS, 5000, async () => {
    const { data } = await mainApi.get(`/api/livetv/stream/tv/vavoo_${encodeURIComponent(entry.ref)}`, {
      timeout: RESOLVE_TIMEOUT_MS,
    });
    return data?.streams?.[0]?.url || null;
  });
}

// --- IPTV Xtream (VIP) ---------------------------------------------------------

function wantedXtreamCategory(name) {
  const prefixes = config.IPTV_XTREAM_PREFIXES;
  if (prefixes.includes('*')) return true;
  // `FR | KIDS TV`, `FR: ...`: le prefixe est un mot entier en tete de libelle.
  const head = String(name || '').trim().toUpperCase();
  return prefixes.some((prefix) => new RegExp(`^${prefix.toUpperCase().replace(/[^A-Z0-9]/g, '')}\\b`).test(head));
}

async function listXtream() {
  if (!config.VIP_ACCESS_KEY || config.IPTV_XTREAM_PREFIXES.length === 0) return [];

  const { data } = await mainApi.get('/api/livetv/iptv/categories', { timeout: LIST_TIMEOUT_MS });
  const categories = (data?.categories || []).filter((row) => wantedXtreamCategory(row.category_name));

  const out = [];
  for (const category of categories) {
    const res = await mainApi.get(`/api/livetv/iptv/streams/${encodeURIComponent(category.category_id)}`, {
      timeout: LIST_TIMEOUT_MS,
    });
    for (const row of res.data?.streams || []) {
      if (!row?.stream_id || !row.name) continue;
      out.push({
        source: 'xtream',
        sid: `x${row.stream_id}`,
        ref: String(row.stream_id),
        label: row.name,
        logo: '',
        hints: [category.category_name],
      });
    }
  }
  return out;
}

async function resolveXtream(entry) {
  return cache.wrap(`iptv:resolve:${entry.sid}`, XTREAM_RESOLVE_TTL_MS, 5000, async () => {
    const { data } = await mainApi.get(`/api/livetv/iptv/stream-url/${encodeURIComponent(entry.ref)}`, {
      timeout: RESOLVE_TIMEOUT_MS,
    });
    return data?.streams?.[0]?.url || null;
  });
}

// --- Playlists M3U tierces -----------------------------------------------------

/** `Nom|https://.../liste.m3u|FR` -> { label, url, prefix }. Le nom et le filtre sont optionnels. */
function extraPlaylists() {
  return config.IPTV_EXTRA_M3U.map((spec, index) => {
    const parts = spec.split('|').map((part) => part.trim());
    const urlIndex = parts.findIndex((part) => /^https?:\/\//i.test(part));
    if (urlIndex < 0) return null;
    return {
      label: (urlIndex > 0 && parts[0]) || `M3U ${index + 1}`,
      url: parts[urlIndex],
      prefix: parts[urlIndex + 1] || '',
    };
  }).filter(Boolean);
}

function parseM3u(text) {
  const rows = [];
  let pending = null;
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('#EXTINF')) {
      const attr = (name) => (line.match(new RegExp(`${name}="([^"]*)"`, 'i')) || [])[1] || '';
      pending = {
        label: line.slice(line.lastIndexOf(',') + 1).trim() || attr('tvg-name'),
        group: attr('group-title'),
        logo: attr('tvg-logo'),
      };
    } else if (pending && /^https?:\/\//i.test(line)) {
      rows.push({ ...pending, url: line });
      pending = null;
    }
  }
  return rows;
}

function shortHash(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(36);
}

async function listExtra() {
  const out = [];
  for (const playlist of extraPlaylists()) {
    try {
      const { data } = await axios.get(playlist.url, { timeout: LIST_TIMEOUT_MS, responseType: 'text' });
      const filter = playlist.prefix.toUpperCase();
      for (const row of parseM3u(data)) {
        if (filter && !row.group.toUpperCase().startsWith(filter) && !row.label.toUpperCase().startsWith(filter)) continue;
        out.push({
          source: 'm3u',
          sid: `m${shortHash(row.url)}`,
          ref: row.url,
          label: row.label,
          logo: row.logo,
          hints: [row.group],
          origin: playlist.label,
        });
      }
    } catch (err) {
      console.warn(`[iptv] playlist "${playlist.label}" illisible: ${err.message}`);
    }
  }
  return out;
}

// --- Registre --------------------------------------------------------------------

const SOURCES = {
  vavoo: { label: 'Vavoo', list: listVavoo, resolve: resolveVavoo },
  xtream: { label: 'IPTV', list: listXtream, resolve: resolveXtream },
  m3u: { label: 'M3U', list: listExtra, resolve: async (entry) => entry.ref },
};

async function resolve(entry) {
  const source = SOURCES[entry.source];
  if (!source) return null;
  const url = await source.resolve(entry);
  // Rendue relative quand proxiesembed partage l'origine de Mainapi.
  return url ? new URL(url, config.MAIN_API_BASE_URL).href : null;
}

module.exports = { SOURCES, resolve, parseM3u };
