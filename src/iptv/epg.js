const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');
const { once } = require('events');
const { pipeline } = require('stream/promises');
const axios = require('axios');
const config = require('../core/config');
const paths = require('../core/paths');
const { keyOf } = require('./names');

/**
 * Guide des programmes (XMLTV).
 *
 * Le guide de xmltvfr.fr pese 8 Mo compresses et 65 Mo a plat pour ~400 chaines, dont la
 * playlist n'utilise qu'une partie. On le telecharge une fois, on le garde tel quel sur
 * disque, et on en sert une COPIE FILTREE: seules les chaines presentes dans la playlist,
 * avec leurs programmes. Un lecteur IPTV sur un boitier relit ce fichier en entier a
 * chaque mise a jour du guide; lui epargner les deux tiers n'est pas du luxe.
 *
 * IPTV_EPG_URL accepte plusieurs guides separes par des virgules: ils sont fusionnes en un
 * seul fichier source au telechargement (voir `merge`), le reste du module n'en voit qu'un.
 *
 * Le fichier source sert aussi a NOMMER: ses `<channel>` donnent, pour chaque chaine,
 * l'identifiant attendu en `tvg-id` et un logo. C'est ce qui relie une chaine fusionnee a
 * son guide.
 */

const SOURCE_FILE = () => paths.inData('iptv-epg-source.xml.gz');
const FILTERED_FILE = () => paths.inData('iptv-epg.xml.gz');

const DOWNLOAD_TIMEOUT_MS = 120000;

function enabled() {
  return !!config.IPTV_EPG_URL;
}

function sourceAgeMs() {
  try {
    return Date.now() - fs.statSync(SOURCE_FILE()).mtimeMs;
  } catch {
    return Infinity;
  }
}

let downloading = null;

function urls() {
  return String(config.IPTV_EPG_URL || '').split(',').map((url) => url.trim()).filter(Boolean);
}

async function download(url, file) {
  const res = await axios.get(url, {
    responseType: 'stream',
    timeout: DOWNLOAD_TIMEOUT_MS,
    // Garder les .gz tels quels: `textOf` decompresse d'apres les octets, pas l'en-tete HTTP.
    decompress: false,
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Encoding': 'identity' },
  });
  await pipeline(res.data, fs.createWriteStream(file));
}

/** Telecharge les guides s'ils sont absents ou perimes. Garde l'ancien si TOUS echouent. */
async function refresh({ force = false } = {}) {
  if (!enabled()) return false;
  if (!force && sourceAgeMs() < config.IPTV_EPG_REFRESH_MS) return false;
  if (downloading) return downloading;

  downloading = (async () => {
    fs.mkdirSync(paths.DATA_DIR, { recursive: true });
    const list = urls();
    const parts = list.map((_, i) => `${SOURCE_FILE()}.part${i}`);
    const tmp = `${SOURCE_FILE()}.tmp`;
    try {
      const results = await Promise.allSettled(list.map((url, i) => download(url, parts[i])));
      results.forEach((r, i) => r.status === 'rejected' && console.warn(`[iptv] guide indisponible (${list[i]}): ${r.reason?.message}`));
      const ok = parts.filter((_, i) => results[i].status === 'fulfilled');
      if (ok.length === 0) return false;
      const stats = await merge(ok, tmp);
      fs.renameSync(tmp, SOURCE_FILE());
      channelIndex = null;
      filteredSignature = null;
      console.log(`[iptv] guide telecharge: ${ok.length}/${list.length} source(s), ${stats.channels} chaine(s), ` +
        `${Math.round(fs.statSync(SOURCE_FILE()).size / 1024)} Ko`);
      return true;
    } catch (err) {
      console.warn(`[iptv] guide indisponible: ${err.message}`);
      return false;
    } finally {
      for (const file of [...parts, tmp]) fs.rmSync(file, { force: true });
      downloading = null;
    }
  })();
  return downloading;
}

/** Flux texte d'un XMLTV, gzip ou non (detecte aux octets: les URL ne le disent pas toujours). */
function textOf(file) {
  const head = Buffer.alloc(2);
  const fd = fs.openSync(file, 'r');
  fs.readSync(fd, head, 0, 2, 0);
  fs.closeSync(fd);
  const raw = fs.createReadStream(file);
  const stream = head[0] === 0x1f && head[1] === 0x8b ? raw.pipe(zlib.createGunzip()) : raw;
  stream.setEncoding('utf8');
  // Sans ca, une erreur de lecture du fichier ne remonterait pas au consommateur du flux.
  raw.on('error', (err) => stream.destroy(err));
  return stream;
}

const XMLTV_HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE tv SYSTEM "xmltv.dtd">\n<tv>\n';

/**
 * Blocs `<channel>...</channel>` et `<programme>...</programme>` d'un XMLTV, au fil de la
 * decompression, sans jamais tenir le document en memoire.
 */
async function* blocks(stream) {
  const opening = /<(?:channel|programme)\b/g;
  let buffer = '';
  for await (const chunk of stream) {
    buffer += chunk;
    // Curseur plutot que decoupes successives: un morceau porte des centaines de blocs.
    let cursor = 0;
    for (;;) {
      opening.lastIndex = cursor;
      const found = opening.exec(buffer);
      if (!found) {
        // Garde la queue: une balise ouvrante peut etre coupee entre deux morceaux.
        cursor = Math.max(cursor, buffer.length - 16);
        break;
      }
      const start = found.index;
      const closing = buffer.startsWith('<channel', start) ? '</channel>' : '</programme>';
      const end = buffer.indexOf(closing, start);
      if (end < 0) {
        cursor = start;
        break;
      }
      yield buffer.slice(start, end + closing.length);
      cursor = end + closing.length;
    }
    buffer = buffer.slice(cursor);
  }
}

/** Identifiant de chaine d'un bloc (`id` d'un `<channel>`, `channel` d'un `<programme>`). */
function blockChannel(block) {
  const tag = block.slice(0, block.indexOf('>'));
  return decodeEntities((tag.match(block.startsWith('<channel') ? /\sid="([^"]*)"/ : /\schannel="([^"]*)"/) || [])[1] || '');
}

/**
 * Fusionne plusieurs XMLTV en un seul (gzip): toutes les `<channel>` d'abord, puis les
 * programmes. Un identifiant appartient au PREMIER guide de la liste qui le declare: les
 * programmes des suivants pour ce meme identifiant sont ecartes, sinon ils s'empileraient.
 */
async function merge(files, target) {
  const out = zlib.createGzip();
  const written = pipeline(out, fs.createWriteStream(target));
  const owner = new Map();
  const write = async (text) => {
    if (!out.write(text)) await once(out, 'drain');
  };
  await write(XMLTV_HEAD);
  for (const [i, file] of files.entries()) {
    const stream = textOf(file);
    for await (const block of blocks(stream)) {
      // Les `<channel>` ouvrent le fichier: inutile de decompresser les programmes ici.
      if (block.startsWith('<programme')) break;
      const id = blockChannel(block);
      if (!id || owner.has(id)) continue;
      owner.set(id, i);
      await write(`  ${block}\n`);
    }
    stream.destroy();
  }
  for (const [i, file] of files.entries()) {
    for await (const block of blocks(textOf(file))) {
      if (block.startsWith('<programme') && owner.get(blockChannel(block)) === i) await write(`  ${block}\n`);
    }
  }
  out.end('</tv>\n');
  await written;
  return { channels: owner.size };
}

/** Flux texte du guide source (fusionne, toujours en gzip). */
function sourceText() {
  return textOf(SOURCE_FILE());
}

function decodeEntities(text) {
  return String(text || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

let channelIndex = null;

/**
 * Chaines du guide, indexees par cle de fusion.
 *
 * Les `<channel>` ouvrent le fichier: la lecture s'arrete au premier `<programme>`, sans
 * decompresser les 65 Mo qui suivent. Une chaine est indexee sous son nom affiche ET sous
 * son identifiant (`CanalPlusSport360.fr` -> `canalplussport360`), les deux ecritures se
 * completant: l'identifiant n'a pas d'accent, le nom a parfois le bon numero.
 */
async function channels() {
  if (channelIndex) return channelIndex;
  if (!enabled() || sourceAgeMs() === Infinity) return new Map();

  const index = new Map();
  let head = '';
  try {
    const stream = sourceText();
    for await (const chunk of stream) {
      head += chunk;
      const stop = head.indexOf('<programme');
      if (stop >= 0) {
        head = head.slice(0, stop);
        stream.destroy();
        break;
      }
    }
  } catch (err) {
    console.warn(`[iptv] guide illisible: ${err.message}`);
    return index;
  }

  const pattern = /<channel\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/channel>/g;
  for (const match of head.matchAll(pattern)) {
    const id = decodeEntities(match[1]);
    const name = decodeEntities((match[2].match(/<display-name[^>]*>([^<]*)</) || [])[1] || '').trim();
    const icon = decodeEntities((match[2].match(/<icon\s+src="([^"]*)"/) || [])[1] || '');
    const entry = { id, name, icon };
    // Un `.fr` l'emporte sur son homonyme belge ou suisse (`Arte.fr` avant `Arte.be`).
    const french = /\.fr$/i.test(id);
    for (const key of new Set([keyOf(name), keyOf(id.replace(/\.[a-z]{2,3}$/i, ''))])) {
      if (!key) continue;
      const known = index.get(key);
      if (!known || (french && !/\.fr$/i.test(known.id))) index.set(key, entry);
    }
  }

  channelIndex = index;
  return index;
}

/** Chaine du guide correspondant a une cle de fusion, avec quelques ecritures voisines. */
function lookup(index, key) {
  if (!key) return null;
  return (
    index.get(key) ||
    index.get(`${key}tv`) ||
    index.get(key.replace(/tv$/, '')) ||
    index.get(key.replace(/fr$/, '')) ||
    index.get(key.replace(/france$/, '')) ||
    index.get(key.replace(/channel$/, '')) ||
    null
  );
}

let filteredSignature = null;
let filtering = null;

/**
 * Chemin du guide filtre sur `ids`, regenere quand la source ou la liste change.
 *
 * Le XMLTV est une suite plate de blocs `<channel>` puis `<programme>`: on le parcourt au
 * fil de la decompression, bloc par bloc, sans jamais tenir le document en memoire.
 */
async function filteredFile(ids) {
  if (!enabled() || sourceAgeMs() === Infinity) return null;

  const signature = crypto
    .createHash('sha1')
    .update(`${fs.statSync(SOURCE_FILE()).mtimeMs}|${[...ids].sort().join(',')}`)
    .digest('hex');
  if (signature === filteredSignature && fs.existsSync(FILTERED_FILE())) return FILTERED_FILE();
  if (filtering) return filtering;

  filtering = (async () => {
    const tmp = `${FILTERED_FILE()}.tmp`;
    const started = Date.now();
    const out = zlib.createGzip();
    const written = pipeline(out, fs.createWriteStream(tmp));
    let kept = 0;

    try {
      out.write(XMLTV_HEAD);
      for await (const block of blocks(sourceText())) {
        if (!ids.has(blockChannel(block))) continue;
        kept += 1;
        if (!out.write(`  ${block}\n`)) await once(out, 'drain');
      }
      out.end('</tv>\n');
      await written;
      fs.renameSync(tmp, FILTERED_FILE());
      filteredSignature = signature;
      console.log(`[iptv] guide filtre: ${kept} bloc(s) pour ${ids.size} chaine(s), ${Date.now() - started} ms`);
      return FILTERED_FILE();
    } catch (err) {
      out.destroy();
      fs.rmSync(tmp, { force: true });
      console.warn(`[iptv] filtrage du guide echoue: ${err.message}`);
      // Mieux vaut le guide complet que pas de guide.
      return SOURCE_FILE();
    } finally {
      filtering = null;
    }
  })();
  return filtering;
}

// --- Programmes en memoire (guide court) -------------------------------------------

/** `20261011203000 +0200` -> horodatage en ms. */
function parseXmltvTime(text) {
  const m = String(text || '').match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?/);
  if (!m) return 0;
  const zone = m[7] ? `${m[7].slice(0, 3)}:${m[7].slice(3)}` : 'Z';
  return Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || '00'}${zone}`) || 0;
}

// Fenetre gardee en memoire: de quoi repondre "maintenant / ensuite" et remplir une soiree,
// sans tenir les 80 000 programmes de la semaine.
const WINDOW_BEFORE_MS = 3 * 60 * 60 * 1000;
const WINDOW_AFTER_MS = 36 * 60 * 60 * 1000;
const PROGRAMMES_TTL_MS = 3 * 60 * 60 * 1000;

let programmeCache = null; // { stamp, at, byChannel }

/**
 * Programmes par chaine du guide (`tvg-id`), tries, sur la fenetre courante.
 *
 * Certaines applications n'affichent "maintenant / ensuite" que par l'API Xtream
 * (`get_short_epg`), sans jamais lire le XMLTV: il faut donc pouvoir repondre programme
 * par programme. L'index est tire du guide FILTRE, deja reduit aux chaines de la grille.
 */
async function programmes(ids) {
  const file = await filteredFile(ids);
  if (!file) return new Map();
  const stamp = `${file}|${fs.statSync(file).mtimeMs}`;
  if (programmeCache && programmeCache.stamp === stamp && Date.now() - programmeCache.at < PROGRAMMES_TTL_MS) {
    return programmeCache.byChannel;
  }

  const from = Date.now() - WINDOW_BEFORE_MS;
  const until = Date.now() + WINDOW_AFTER_MS;
  const byChannel = new Map();
  const pattern = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/g;
  const attr = (text, name) => (text.match(new RegExp(`\\b${name}="([^"]*)"`)) || [])[1] || '';
  const tag = (text, name) => decodeEntities((text.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`)) || [])[1] || '').trim();

  try {
    const raw = fs.createReadStream(file);
    const stream = raw.pipe(zlib.createGunzip());
    stream.setEncoding('utf8');
    raw.on('error', (err) => stream.destroy(err));

    let buffer = '';
    for await (const chunk of stream) {
      buffer += chunk;
      let consumed = 0;
      pattern.lastIndex = 0;
      for (let match = pattern.exec(buffer); match; match = pattern.exec(buffer)) {
        consumed = pattern.lastIndex;
        const start = parseXmltvTime(attr(match[1], 'start'));
        const stop = parseXmltvTime(attr(match[1], 'stop'));
        if (!start || stop < from || start > until) continue;
        const channel = decodeEntities(attr(match[1], 'channel'));
        if (!byChannel.has(channel)) byChannel.set(channel, []);
        byChannel.get(channel).push({ start, stop, title: tag(match[2], 'title'), desc: tag(match[2], 'desc') });
      }
      buffer = buffer.slice(consumed);
    }
  } catch (err) {
    console.warn(`[iptv] programmes illisibles: ${err.message}`);
    return new Map();
  }

  for (const list of byChannel.values()) list.sort((a, b) => a.start - b.start);
  programmeCache = { stamp, at: Date.now(), byChannel };
  return byChannel;
}

module.exports = { enabled, refresh, channels, lookup, filteredFile, programmes, sourceAgeMs, merge };
