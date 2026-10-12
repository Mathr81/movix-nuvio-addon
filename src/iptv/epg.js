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

/** Telecharge le guide s'il est absent ou perime. Garde l'ancien si le telechargement echoue. */
async function refresh({ force = false } = {}) {
  if (!enabled()) return false;
  if (!force && sourceAgeMs() < config.IPTV_EPG_REFRESH_MS) return false;
  if (downloading) return downloading;

  downloading = (async () => {
    const tmp = `${SOURCE_FILE()}.tmp`;
    try {
      fs.mkdirSync(paths.DATA_DIR, { recursive: true });
      const res = await axios.get(config.IPTV_EPG_URL, {
        responseType: 'stream',
        timeout: DOWNLOAD_TIMEOUT_MS,
        // Le fichier est deja un .gz: le laisser tel quel, sans decompression transparente.
        decompress: false,
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Encoding': 'identity' },
      });
      await pipeline(res.data, fs.createWriteStream(tmp));
      fs.renameSync(tmp, SOURCE_FILE());
      channelIndex = null;
      filteredSignature = null;
      console.log(`[iptv] guide telecharge (${Math.round(fs.statSync(SOURCE_FILE()).size / 1024)} Ko)`);
      return true;
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      console.warn(`[iptv] guide indisponible (${config.IPTV_EPG_URL}): ${err.message}`);
      return false;
    } finally {
      downloading = null;
    }
  })();
  return downloading;
}

/** Flux texte du guide source, que le fichier soit compresse ou non. */
function sourceText() {
  const raw = fs.createReadStream(SOURCE_FILE());
  const gz = /\.gz(?:$|\?)/i.test(config.IPTV_EPG_URL);
  const stream = gz ? raw.pipe(zlib.createGunzip()) : raw;
  stream.setEncoding('utf8');
  // Sans ca, une erreur de lecture du fichier ne remonterait pas au consommateur du flux.
  raw.on('error', (err) => stream.destroy(err));
  return stream;
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

  const pattern = /<channel\s+id="([^"]+)"\s*>([\s\S]*?)<\/channel>/g;
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

    const keep = (block) => {
      const id = decodeEntities((block.match(/^<(?:channel\s+id|programme\b[^>]*?\schannel)="([^"]*)"/) || [])[1] || '');
      if (!ids.has(id)) return;
      kept += 1;
      out.write(`  ${block}\n`);
    };

    try {
      const opening = /<(?:channel|programme)\b/g;
      let buffer = '';
      let headerDone = false;
      for await (const chunk of sourceText()) {
        buffer += chunk;

        if (!headerDone) {
          const first = buffer.search(/<(?:channel|programme)\b/);
          if (first < 0) continue;
          out.write(buffer.slice(0, first).replace(/\s+$/, '\n'));
          buffer = buffer.slice(first);
          headerDone = true;
        }

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
          keep(buffer.slice(start, end + closing.length));
          cursor = end + closing.length;
        }
        buffer = buffer.slice(cursor);
        if (out.writableNeedDrain) await once(out, 'drain');
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

module.exports = { enabled, refresh, channels, lookup, filteredFile, sourceAgeMs };
