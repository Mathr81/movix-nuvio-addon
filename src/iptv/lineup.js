const fs = require('fs');
const config = require('../core/config');
const paths = require('../core/paths');
const { SOURCES } = require('./sources');
const names = require('./names');
const epg = require('./epg');

/**
 * Grille des chaines: les flux de toutes les sources, regroupes par chaine.
 *
 * Vavoo seul annonce ~1000 lignes pour la France, dont quatre ou cinq par chaine (trois
 * fournisseurs, plusieurs definitions, des secours); l'IPTV en ajoute pres de 400. Telle
 * quelle, la liste est inutilisable sur une telecommande. La grille en fait UNE entree par
 * chaine, qui porte tous ses flux, classes du meilleur au moins bon.
 *
 * Elle est reconstruite periodiquement et gardee sur disque: un redemarrage, ou une panne
 * de Movix au mauvais moment, ne doit pas vider la playlist d'un lecteur qui la relit.
 */

const STATE_FILE = () => paths.inData('iptv-lineup.json');

// Un flux sans definition annoncee est rarement de la SD, rarement de la FHD: on le range
// entre les deux, pour qu'un "HD" explicite passe devant lui mais pas un "SD".
const UNKNOWN_QUALITY_RANK = 600;

let state = { builtAt: 0, entries: {}, channels: [] };
let index = { byKey: new Map(), byId: new Map() };
let building = null;

function sourceRank(source) {
  const order = config.IPTV_SOURCE_ORDER.indexOf(source);
  return order < 0 ? config.IPTV_SOURCE_ORDER.length : order;
}

/** Classement statique des flux d'une chaine. La sante mesuree s'y ajoute a la lecture. */
function compareStreams(a, b) {
  // Au-dessus du plafond (IPTV_MAX_QUALITY), un flux n'est pas retire mais passe derriere:
  // il reste le recours si tout le reste est mort.
  const tooHeavy = (s) => config.IPTV_MAX_QUALITY > 0 && s.quality > config.IPTV_MAX_QUALITY;
  const demoted = (s) => (s.backup || s.eventOnly ? 2 : tooHeavy(s) ? 1 : 0);
  return (
    demoted(a) - demoted(b) ||
    (b.quality || UNKNOWN_QUALITY_RANK) - (a.quality || UNKNOWN_QUALITY_RANK) ||
    sourceRank(a.source) - sourceRank(b.source) ||
    a.server.localeCompare(b.server)
  );
}

/** Identifiant numerique stable, exige par l'API Xtream (`stream_id`). */
function numericId(key, taken) {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i += 1) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
  let id = ((hash >>> 0) % 900000) + 100000;
  while (taken.has(id)) id += 1;
  taken.add(id);
  return id;
}

function streamLabel(stream) {
  const source = SOURCES[stream.source]?.label || stream.source;
  const origin = stream.source === 'm3u' && stream.origin ? stream.origin : source;
  return [names.qualityLabel(stream.quality), origin + (stream.server ? ` ${stream.server}` : ''), stream.backup ? 'secours' : '', stream.eventOnly ? 'événement' : '']
    .filter(Boolean)
    .join(' · ');
}

function merge(entriesBySource, epgIndex) {
  const groups = new Map();
  for (const entries of Object.values(entriesBySource)) {
    for (const entry of entries) {
      const parsed = names.parse(entry.label);
      if (!parsed.key) continue;
      const stream = { ...entry, ...parsed };
      if (!groups.has(parsed.key)) groups.set(parsed.key, []);
      groups.get(parsed.key).push(stream);
    }
  }

  const channels = [];
  for (const [key, streams] of groups) {
    streams.sort(compareStreams);
    const guide = epg.lookup(epgIndex, key);
    // Le nom du guide est le plus propre; a defaut celui de l'IPTV (casse mixte), puis Vavoo.
    const named = streams.find((s) => s.source !== 'vavoo') || streams[0];
    const group = names.groupOf(key, streams.flatMap((s) => s.hints || []));
    channels.push({
      key,
      name: guide?.name || named.name,
      group,
      logo: streams.find((s) => s.logo)?.logo || guide?.icon || '',
      tvgId: guide?.id || '',
      streams: streams.map((s) => ({
        sid: s.sid,
        source: s.source,
        ref: s.ref,
        raw: s.label,
        quality: s.quality,
        server: s.server,
        backup: s.backup,
        eventOnly: s.eventOnly,
        label: streamLabel(s),
      })),
    });
  }

  const tnt = (channel) => {
    const position = names.TNT_ORDER.indexOf(channel.key);
    return position < 0 ? Infinity : position;
  };
  const groupRank = (channel) => names.GROUPS.indexOf(channel.group);
  channels.sort(
    (a, b) =>
      tnt(a) - tnt(b) ||
      groupRank(a) - groupRank(b) ||
      a.name.localeCompare(b.name, 'fr', { numeric: true, sensitivity: 'base' }),
  );

  const taken = new Set();
  // Attribues dans l'ordre des cles, pas de la grille: une chaine qui change de rang ne
  // doit pas en decaler une autre en cas de collision.
  const ids = new Map([...groups.keys()].sort().map((key) => [key, numericId(key, taken)]));
  channels.forEach((channel, position) => {
    channel.id = ids.get(channel.key);
    channel.num = position + 1;
  });
  return channels;
}

function reindex() {
  index = {
    byKey: new Map(state.channels.map((channel) => [channel.key, channel])),
    byId: new Map(state.channels.map((channel) => [String(channel.id), channel])),
  };
}

function loadFromDisk() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8'));
    if (Array.isArray(parsed?.channels)) {
      state = { builtAt: parsed.builtAt || 0, entries: parsed.entries || {}, channels: parsed.channels };
      reindex();
    }
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[iptv] grille sur disque ignoree: ${err.message}`);
  }
}

function saveToDisk() {
  try {
    fs.mkdirSync(paths.DATA_DIR, { recursive: true });
    fs.writeFileSync(`${STATE_FILE()}.tmp`, JSON.stringify(state));
    fs.renameSync(`${STATE_FILE()}.tmp`, STATE_FILE());
  } catch (err) {
    console.warn(`[iptv] grille non sauvegardee: ${err.message}`);
  }
}

async function build() {
  const entries = {};
  const report = [];
  await Promise.all(
    Object.entries(SOURCES).map(async ([id, source]) => {
      try {
        entries[id] = await source.list();
        report.push(`${source.label} ${entries[id].length}`);
      } catch (err) {
        // Une source en panne garde ses flux de la derniere lecture reussie.
        entries[id] = state.entries[id] || [];
        const status = err.response?.status ? `HTTP ${err.response.status}` : err.message;
        console.warn(`[iptv] source ${source.label} indisponible (${status}), ${entries[id].length} flux gardes`);
        report.push(`${source.label} ${entries[id].length} (ancien)`);
      }
    }),
  );

  await epg.refresh();
  const channels = merge(entries, await epg.channels());
  if (channels.length === 0 && state.channels.length > 0) {
    console.warn('[iptv] reconstruction vide, grille precedente conservee');
    return state;
  }

  state = { builtAt: Date.now(), entries, channels };
  reindex();
  saveToDisk();
  const withGuide = channels.filter((channel) => channel.tvgId).length;
  console.log(`[iptv] grille: ${channels.length} chaines (${report.join(', ')}), ${withGuide} avec guide`);
  return state;
}

function refresh() {
  if (!building) building = build().finally(() => { building = null; });
  return building;
}

/** Grille courante. Attend la premiere construction si rien n'est encore disponible. */
async function get() {
  if (state.channels.length === 0) await refresh().catch((err) => console.warn(`[iptv] grille: ${err.message}`));
  return { ...state, ...index };
}

function start() {
  loadFromDisk();
  const stale = Date.now() - state.builtAt > config.IPTV_REFRESH_MS;
  if (stale) refresh().catch((err) => console.warn(`[iptv] grille: ${err.message}`));
  setInterval(() => {
    refresh().catch((err) => console.warn(`[iptv] grille: ${err.message}`));
  }, config.IPTV_REFRESH_MS).unref();
}

module.exports = { start, get, refresh };
