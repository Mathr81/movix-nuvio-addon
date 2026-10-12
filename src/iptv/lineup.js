const fs = require('fs');
const config = require('../core/config');
const paths = require('../core/paths');
const { SOURCES } = require('./sources');
const names = require('./names');
const epg = require('./epg');
const health = require('./health');
const overrides = require('./overrides');

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
let building = null;

/** Identifiant numerique stable, exige par l'API Xtream (`stream_id`). */
function numericId(key, taken) {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i += 1) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
  let id = ((hash >>> 0) % 900000) + 100000;
  while (taken.has(id)) id += 1;
  taken.add(id);
  return id;
}

/** Vrai si une insertion, une suppression ou une substitution suffit a passer de `a` a `b`. */
function oneEditApart(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  let i = 0;
  while (i < short.length && short[i] === long[i]) i += 1;
  if (short.length === long.length) return short.slice(i + 1) === long.slice(i + 1);
  return short.slice(i) === long.slice(i + 1);
}

// En dessous, une lettre d'ecart separe de vraies chaines distinctes (`ocsmax`/`ocsmix`).
const TYPO_MIN_LENGTH = 9;

/**
 * Rapproche les chaines que la cle seule a laissees separees.
 *
 * La cle regle la casse, les accents et la ponctuation, pas les ECRITURES: Vavoo publie
 * `CANAL DECALE` a cote de `CANAL+ DECALE`, `CINE+ FRISSION`, `CANAL+ CINEMAS`... Plutot
 * qu'une liste d'alias a tenir a la main, trois regles qui s'appuient sur les donnees:
 *
 *   marque   `canalX` rejoint `canalplusX` (et `cineX` -> `cineplusX`) s'il existe: le
 *            `+` oublie est la faute la plus frequente du catalogue.
 *   faute    deux cles longues a une lettre d'ecart, memes chiffres (`...live1` et
 *            `...live2` restent deux chaines), sont la meme chaine.
 *   guide    deux cles rattachees au MEME programme sont la meme chaine, quel que soit
 *            le nom (`Cine+ Club` renomme `Cine+ Festival`).
 *
 * Garde-fou commun: on ne fusionne jamais deux cles qui ont chacune leur propre guide.
 * La cle la plus fournie en flux absorbe l'autre, pour garder un identifiant stable.
 */
function unify(groups, epgIndex) {
  const aliases = new Map();
  const guideId = (key) => epg.lookup(epgIndex, key)?.id || '';
  const distinctGuides = (a, b) => guideId(a) && guideId(b) && guideId(a) !== guideId(b);

  const absorb = (from, into) => {
    if (from === into || !groups.has(from) || !groups.has(into)) return;
    groups.get(into).push(...groups.get(from));
    groups.delete(from);
    aliases.set(into, [...(aliases.get(into) || []), from, ...(aliases.get(from) || [])]);
    aliases.delete(from);
  };
  /** Fusionne dans la cle qui a un guide, sinon dans la plus fournie. */
  const { splits, merges } = overrides.get();
  const join = (a, b) => {
    // Une ecriture detachee a la main ne se laisse plus absorber.
    if (splits.includes(a) || splits.includes(b)) return;
    if (distinctGuides(a, b)) return;
    const score = (key) => (guideId(key) ? 1000 : 0) + groups.get(key).length;
    if (score(a) >= score(b)) absorb(b, a);
    else absorb(a, b);
  };

  // marque
  for (const key of [...groups.keys()]) {
    const branded = key.replace(/^(canal|cine)(?!plus)/, '$1plus');
    if (branded !== key && groups.has(key) && groups.has(branded)) join(key, branded);
  }

  // faute
  const digits = (key) => key.replace(/\D+/g, '.');
  const long = [...groups.keys()].filter((key) => key.length >= TYPO_MIN_LENGTH).sort();
  for (let i = 0; i < long.length; i += 1) {
    for (let j = i + 1; j < long.length; j += 1) {
      const [a, b] = [long[i], long[j]];
      if (!groups.has(a) || !groups.has(b)) continue;
      if (digits(a) === digits(b) && oneEditApart(a, b)) join(a, b);
    }
  }

  // guide
  const byGuide = new Map();
  for (const key of [...groups.keys()]) {
    const id = guideId(key);
    if (!id) continue;
    if (byGuide.has(id) && groups.has(byGuide.get(id))) {
      const kept = groups.get(byGuide.get(id)).length >= groups.get(key).length ? byGuide.get(id) : key;
      absorb(kept === key ? byGuide.get(id) : key, kept);
      byGuide.set(id, kept);
    } else {
      byGuide.set(id, key);
    }
  }

  // Fusions manuelles, en dernier: elles l'emportent sur tout le reste.
  for (const [from, into] of Object.entries(merges)) absorb(from, into);

  return aliases;
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

  const aliases = unify(groups, epgIndex);

  const channels = [];
  for (const [key, streams] of groups) {
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
      // Ecritures absorbees par la passe de rapprochement, pour relire une fusion douteuse.
      aliases: aliases.get(key) || [],
      streams: streams.map((s) => ({
        sid: s.sid,
        source: s.source,
        ref: s.ref,
        raw: s.label,
        quality: s.quality,
        server: s.server,
        backup: s.backup,
        eventOnly: s.eventOnly,
        origin: s.origin || '',
      })),
    });
  }

  const taken = new Set();
  // Attribues dans l'ordre des cles, pas de la grille: une chaine qui change de rang ne
  // doit pas en decaler une autre en cas de collision.
  const ids = new Map([...groups.keys()].sort().map((key) => [key, numericId(key, taken)]));
  for (const channel of channels) channel.id = ids.get(channel.key);
  return channels;
}

// --- Vue: la grille telle qu'elle est servie ------------------------------------
// La fusion ne depend que des sources; ce qu'on SERT depend en plus de la sante mesuree
// des flux et des retouches manuelles, qui changent sans que la grille soit reconstruite.
// La vue est donc derivee a la demande, et recalculee seulement quand l'un des trois bouge.

/** Hauteur mesuree -> palier de definition (une image 1920x800 reste de la FHD). */
function tier(height) {
  if (!height) return 0;
  if (height >= 2000) return 2160;
  if (height >= 1000) return 1080;
  if (height >= 700) return 720;
  return 480;
}

function sourceRank(source) {
  const order = config.IPTV_SOURCE_ORDER.indexOf(source);
  return order < 0 ? config.IPTV_SOURCE_ORDER.length : order;
}

/**
 * Classement des flux d'une chaine. Dans l'ordre:
 *   flux force a la main > vivants avant morts > permanents avant secours/evenement et
 *   avant ceux qui depassent IPTV_MAX_QUALITY > puis, selon IPTV_RANK_BY, la source
 *   preferee d'abord (`source`) ou la meilleure definition d'abord (`quality`).
 */
function compareStreams(a, b) {
  const tooHeavy = (s) => config.IPTV_MAX_QUALITY > 0 && s.quality > config.IPTV_MAX_QUALITY;
  const demoted = (s) => (s.backup || s.eventOnly ? 2 : tooHeavy(s) ? 1 : 0);
  const bySource = sourceRank(a.source) - sourceRank(b.source);
  const byQuality = (b.quality || UNKNOWN_QUALITY_RANK) - (a.quality || UNKNOWN_QUALITY_RANK);
  return (
    Number(b.preferred) - Number(a.preferred) ||
    Number(a.ok === false) - Number(b.ok === false) ||
    demoted(a) - demoted(b) ||
    (config.IPTV_RANK_BY === 'quality' ? byQuality || bySource : bySource || byQuality) ||
    a.server.localeCompare(b.server)
  );
}

function streamLabel(stream) {
  const source = SOURCES[stream.source]?.label || stream.source;
  const origin = stream.source === 'm3u' && stream.origin ? stream.origin : source;
  return [names.qualityLabel(stream.quality), origin + (stream.server ? ` ${stream.server}` : ''), stream.backup ? 'secours' : '', stream.eventOnly ? 'événement' : '']
    .filter(Boolean)
    .join(' · ');
}

// Une chaine n'est retiree qu'apres deux rondes sans le moindre flux vivant: une panne
// passagere d'un fournisseur ne doit pas vider la playlist.
const DEAD_AFTER_FAILS = 2;

function hiddenReason(channel, edits) {
  if (edits.hiddenChannels.includes(channel.key)) return 'user';
  if (edits.hiddenGroups.includes(channel.group)) return 'group';
  // Les canaux evenementiels sont eteints hors antenne: les retirer les ferait manquer
  // au moment ou ils servent. Le sport en est plein, on ne le purge donc jamais.
  const eventful = channel.group === 'Sport' || channel.streams.some((stream) => stream.eventOnly);
  if (config.IPTV_HIDE_DEAD && !eventful && channel.streams.every((stream) => stream.fails >= DEAD_AFTER_FAILS)) return 'dead';
  return null;
}

let view = null;
let viewStamp = '';

function buildView() {
  const edits = overrides.get();

  const all = state.channels.map((channel) => {
    const preferred = edits.preferred[channel.key];
    const streams = channel.streams.map((stream) => {
      const measured = health.get(stream.sid) || {};
      const enriched = {
        ...stream,
        announced: stream.quality,
        // La definition mesuree remplace celle du libelle des qu'elle est connue.
        quality: tier(measured.height) || stream.quality,
        width: measured.width || 0,
        height: measured.height || 0,
        codec: measured.codec || '',
        ok: measured.ok ?? null,
        fails: measured.fails || 0,
        checkedAt: measured.at || null,
        preferred: stream.sid === preferred,
      };
      enriched.label = streamLabel(enriched);
      return enriched;
    });
    streams.sort(compareStreams);

    const edited = {
      ...channel,
      name: edits.names[channel.key] || channel.name,
      group: edits.groups[channel.key] || channel.group,
      streams,
    };
    edited.hidden = hiddenReason(edited, edits);
    return edited;
  });

  const tnt = (channel) => {
    const position = names.TNT_ORDER.indexOf(channel.key);
    return position < 0 ? Infinity : position;
  };
  const groupRank = (channel) => {
    const position = names.GROUPS.indexOf(channel.group);
    return position < 0 ? names.GROUPS.length : position;
  };
  all.sort(
    (a, b) =>
      tnt(a) - tnt(b) ||
      groupRank(a) - groupRank(b) ||
      a.name.localeCompare(b.name, 'fr', { numeric: true, sensitivity: 'base' }),
  );

  const channels = all.filter((channel) => !channel.hidden);
  channels.forEach((channel, position) => {
    channel.num = position + 1;
  });

  return {
    builtAt: state.builtAt,
    // `channels` est ce que la playlist annonce; `all` garde les chaines masquees, qui
    // restent jouables par leur URL (un lecteur n'a pas forcement recharge sa liste).
    channels,
    all,
    byKey: new Map(all.map((channel) => [channel.key, channel])),
    byId: new Map(all.map((channel) => [String(channel.id), channel])),
  };
}

function currentView() {
  const stamp = `${state.builtAt}|${health.version()}|${overrides.version()}`;
  if (!view || stamp !== viewStamp) {
    view = buildView();
    viewStamp = stamp;
  }
  return view;
}

function loadFromDisk() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8'));
    if (Array.isArray(parsed?.channels)) {
      state = { builtAt: parsed.builtAt || 0, entries: parsed.entries || {}, channels: parsed.channels };
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
  saveToDisk();
  const withGuide = channels.filter((channel) => channel.tvgId).length;
  const absorbed = channels.reduce((sum, channel) => sum + (channel.aliases?.length || 0), 0);
  console.log(`[iptv] grille: ${channels.length} chaines (${report.join(', ')}), ${withGuide} avec guide, ${absorbed} ecriture(s) rapprochee(s)`);
  return state;
}

function refresh() {
  if (!building) building = build().finally(() => { building = null; });
  return building;
}

/** Grille servie. Attend la premiere construction si rien n'est encore disponible. */
async function get() {
  if (state.channels.length === 0) await refresh().catch((err) => console.warn(`[iptv] grille: ${err.message}`));
  return currentView();
}

/** Refond la grille a partir des flux deja lus: apres une fusion ou un detachement manuel. */
async function remerge() {
  const channels = merge(state.entries, await epg.channels());
  state = { ...state, builtAt: Date.now(), channels };
  saveToDisk();
  return currentView();
}

/** Tous les flux de la grille, pour la ronde de sante. */
async function allStreams() {
  const { all } = await get();
  return all.flatMap((channel) => channel.streams);
}

function start() {
  loadFromDisk();
  const stale = Date.now() - state.builtAt > config.IPTV_REFRESH_MS;
  if (stale) refresh().catch((err) => console.warn(`[iptv] grille: ${err.message}`));
  setInterval(() => {
    refresh().catch((err) => console.warn(`[iptv] grille: ${err.message}`));
  }, config.IPTV_REFRESH_MS).unref();
}

module.exports = { start, get, refresh, remerge, allStreams };
