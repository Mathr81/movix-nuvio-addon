const fs = require('fs');
const { execFile } = require('child_process');
const axios = require('axios');
const config = require('../core/config');
const paths = require('../core/paths');
const { resolve } = require('./sources');

/**
 * Sante et definition REELLE des flux, mesurees en tache de fond.
 *
 * Deux choses que le catalogue ne dit pas, ou dit mal:
 *
 *   vivant ?      une part des flux Vavoo est morte a tout instant. Le savoir AVANT le zap
 *                 evite d'attendre quatre secondes un flux qui ne repondra pas, et permet
 *                 de retirer de la playlist une chaine dont plus rien ne repond.
 *   definition    le libelle ment volontiers (`FHD` servi en 720p, `4K` en 1080p). ffprobe
 *                 lit la taille de l'image dans le flux; c'est elle qui classe ensuite.
 *
 * Une ronde passe sur tous les flux, quelques-uns a la fois, toutes les IPTV_SWEEP_MS.
 * Le test de vie est leger (debut de playlist); la mesure ffprobe, plus chere, n'est
 * refaite qu'une fois par semaine et par flux.
 */

const FILE = () => paths.inData('iptv-health.json');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const MEASURE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FFPROBE_TIMEOUT_MS = 20000;
const XTREAM_SWEEP_TIMEOUT_MS = 15000;
const RETRY_PAUSE_MS = 2500;

// sid -> { ok, at, fails, width, height, codec, measuredAt }
const store = new Map();
let version = 0;
let lastSweepAt = 0;
let progress = null; // { done, total, startedAt }

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    for (const [sid, row] of Object.entries(parsed.streams || {})) store.set(sid, row);
    lastSweepAt = parsed.lastSweepAt || 0;
    version += 1;
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[iptv] sante sur disque ignoree: ${err.message}`);
  }
}

function save() {
  try {
    fs.mkdirSync(paths.DATA_DIR, { recursive: true });
    fs.writeFileSync(`${FILE()}.tmp`, JSON.stringify({ lastSweepAt, streams: Object.fromEntries(store) }));
    fs.renameSync(`${FILE()}.tmp`, FILE());
  } catch (err) {
    console.warn(`[iptv] sante non sauvegardee: ${err.message}`);
  }
}

function get(sid) {
  return store.get(sid) || null;
}

/** Consigne un test de vie. `fails` compte les echecs CONSECUTIFS. */
function record(sid, ok) {
  const known = store.get(sid) || {};
  const next = { ...known, ok, at: Date.now(), fails: ok ? 0 : (known.fails || 0) + 1 };
  store.set(sid, next);
  if (known.ok !== ok) version += 1;
  return next;
}

/**
 * Le flux repond-il ? On lit le PREMIER morceau de la reponse puis on coupe: assez pour
 * distinguer une playlist HLS d'une page d'erreur, sans telecharger un flux continu quand
 * la source sert du MPEG-TS brut.
 */
async function responds(url, timeoutMs = config.IPTV_CHECK_TIMEOUT_MS) {
  let res;
  try {
    res = await axios.get(url, {
      responseType: 'stream',
      timeout: timeoutMs,
      headers: { 'User-Agent': USER_AGENT },
      validateStatus: () => true,
    });
  } catch {
    return false;
  }

  try {
    if (res.status < 200 || res.status >= 300) return false;
    const first = await new Promise((done) => {
      const timer = setTimeout(() => done(null), timeoutMs);
      const finish = (value) => {
        clearTimeout(timer);
        done(value);
      };
      res.data.once('data', (chunk) => finish(chunk));
      res.data.once('end', () => finish(null));
      res.data.once('error', () => finish(null));
    });
    if (!first || first.length === 0) return false;
    const hls = /mpegurl/i.test(res.headers['content-type'] || '') || /\.m3u8(?:$|\?)/i.test(url);
    return hls ? first.toString('utf8', 0, 64).includes('#EXTM3U') : true;
  } finally {
    res.data.destroy();
  }
}

let ffprobeAvailable = null;
function ffprobeReady() {
  if (!ffprobeAvailable) {
    ffprobeAvailable = new Promise((done) => {
      execFile(config.FFPROBE_PATH || 'ffprobe', ['-version'], { timeout: 5000 }, (err) => done(!err));
    });
  }
  return ffprobeAvailable;
}

/** Taille d'image et codec lus dans le flux. Un master a plusieurs variantes: la plus haute. */
function measure(url) {
  return new Promise((done) => {
    const args = [
      '-v', 'error',
      '-select_streams', 'v',
      '-show_entries', 'stream=codec_name,width,height',
      '-of', 'csv=p=0',
      '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
      '-user_agent', USER_AGENT,
      '-rw_timeout', String(FFPROBE_TIMEOUT_MS * 1000),
      '-probesize', '2000000',
      '-analyzeduration', '2000000',
      '-i', url,
    ];
    execFile(config.FFPROBE_PATH || 'ffprobe', args, { timeout: FFPROBE_TIMEOUT_MS }, (err, stdout) => {
      let best = null;
      for (const line of String(stdout || '').split('\n')) {
        const [codec, width, height] = line.trim().split(',');
        if (Number(height) > (best?.height || 0)) best = { codec, width: Number(width), height: Number(height) };
      }
      done(best);
    });
  });
}

/**
 * Delai accorde a un flux pour repondre.
 *
 * Le bouquet IPTV sert ses chaines A LA DEMANDE: une chaine que personne ne regarde met
 * 3 a 11 s a rendre sa premiere playlist, le temps que le fournisseur la demarre, puis
 * repond en 400 ms. Lui appliquer le delai des autres sources le declarerait mort a tort
 * -- et ferait perdre a l'IPTV la priorite qu'on lui donne. La ronde attend donc
 * franchement; au zap on attend moins (le lecteur a sa propre patience), quitte a
 * retomber sur un autre flux le temps que celui-ci demarre.
 */
function timeoutFor(stream, mode) {
  if (stream.source !== 'xtream') return config.IPTV_CHECK_TIMEOUT_MS;
  return mode === 'sweep' ? XTREAM_SWEEP_TIMEOUT_MS : config.IPTV_XTREAM_WAIT_MS;
}

/** Test complet d'un flux: resolution, vie, et definition si elle n'est pas (ou plus) connue. */
async function check(stream) {
  let url = null;
  try {
    url = await resolve(stream);
  } catch {
    url = null;
  }
  let ok = !!url && (await responds(url, timeoutFor(stream, 'sweep')));
  // Un 503 passager ne doit pas releguer un flux jusqu'a la ronde suivante: second essai.
  if (!ok && url) {
    await new Promise((done) => setTimeout(done, RETRY_PAUSE_MS));
    ok = await responds(url, timeoutFor(stream, 'sweep'));
  }
  const row = record(stream.sid, ok);

  const stale = !row.measuredAt || Date.now() - row.measuredAt > MEASURE_TTL_MS;
  if (ok && stale && (await ffprobeReady())) {
    const shape = await measure(url);
    if (shape) {
      if (row.height !== shape.height) version += 1;
      store.set(stream.sid, { ...store.get(stream.sid), ...shape, measuredAt: Date.now() });
    }
  }
  return store.get(stream.sid);
}

let sweeping = null;

/** Ronde sur tous les flux. `listStreams` est relu a chaque ronde: la grille bouge. */
function sweep(listStreams) {
  if (sweeping) return sweeping;

  sweeping = (async () => {
    const streams = await listStreams();
    progress = { done: 0, total: streams.length, startedAt: Date.now() };
    const before = version;
    let cursor = 0;

    const worker = async () => {
      while (cursor < streams.length) {
        const stream = streams[cursor];
        cursor += 1;
        try {
          await check(stream);
        } catch {
          // un flux qui fait echouer la sonde ne doit pas arreter la ronde
        }
        progress.done += 1;
        if (progress.done % 200 === 0) save();
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, config.IPTV_SWEEP_CONCURRENCY) }, worker));

    // Oublie les flux disparus de la grille.
    const present = new Set(streams.map((stream) => stream.sid));
    for (const sid of store.keys()) if (!present.has(sid)) store.delete(sid);

    lastSweepAt = Date.now();
    save();
    const rows = [...store.values()];
    const alive = rows.filter((row) => row.ok).length;
    const seconds = Math.round((Date.now() - progress.startedAt) / 1000);
    console.log(
      `[iptv] ronde: ${alive}/${streams.length} flux vivants, ${rows.filter((row) => row.height).length} mesures, ${seconds} s` +
        (version !== before ? '' : ' (aucun changement)'),
    );
  })()
    .catch((err) => console.warn(`[iptv] ronde interrompue: ${err.message}`))
    .finally(() => {
      sweeping = null;
      progress = null;
    });
  return sweeping;
}

function start(listStreams) {
  load();
  if (config.IPTV_SWEEP_MS <= 0) return;
  const run = () => sweep(listStreams);
  // La premiere ronde attend que la grille soit la, et ne repart pas a chaque redemarrage.
  const dueIn = Math.max(60 * 1000, lastSweepAt + config.IPTV_SWEEP_MS - Date.now());
  setTimeout(() => {
    run();
    setInterval(run, config.IPTV_SWEEP_MS).unref();
  }, dueIn).unref();
}

function status() {
  const rows = [...store.values()];
  return {
    running: !!sweeping,
    progress,
    lastSweepAt: lastSweepAt || null,
    intervalMs: config.IPTV_SWEEP_MS,
    alive: rows.filter((row) => row.ok === true).length,
    dead: rows.filter((row) => row.ok === false).length,
    measured: rows.filter((row) => row.height).length,
  };
}

module.exports = { start, sweep, check, get, record, responds, timeoutFor, status, version: () => version };
