const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');
const express = require('express');
const config = require('../core/config');
const lineup = require('./lineup');
const epg = require('./epg');
const play = require('./play');
const health = require('./health');
const names = require('./names');

/**
 * Playlist IPTV: les chaines de Movix, fusionnees, pour un lecteur IPTV.
 *
 * Deux facades sur la meme grille:
 *
 *   M3U     /iptv/<jeton>/playlist.m3u  + /iptv/<jeton>/epg.xml.gz
 *           Lu par tout ce qui existe (VLC, TiviMate, IPTV Smarters, Kodi, Jellyfin...).
 *   Xtream  /player_api.php, /live/<u>/<jeton>/<id>.m3u8, /xmltv.php, /get.php
 *           Meme contenu, sous la forme "serveur + identifiant + mot de passe" que les
 *           applications TV preferent: categories natives, guide rattache tout seul.
 *
 * Dans les deux cas une chaine pointe sur NOTRE route de lecture, qui choisit le flux au
 * moment de zapper (cf. play.js) et repond par une redirection.
 *
 * Le jeton protege l'ensemble: ces routes distribuent, a qui les appelle, l'acces VIP du
 * compte Movix. Sans IPTV_TOKEN le module ne s'active pas.
 */

function enabled() {
  return config.IPTV_ENABLED && !!config.IPTV_TOKEN && !!config.MAIN_API_BASE_URL;
}

function tokenOk(candidate) {
  const given = Buffer.from(String(candidate || ''));
  const expected = Buffer.from(config.IPTV_TOKEN);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function baseUrl(req) {
  if (config.PUBLIC_URL) return config.PUBLIC_URL.replace(/\/+$/, '');
  return `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}`;
}

function attr(value) {
  return String(value || '').replace(/"/g, "'").replace(/[\r\n]+/g, ' ');
}

/**
 * `sources=all` deroule chaque flux en entree separee (`TF1 · FHD · IPTV`), pour choisir
 * a la main; par defaut une chaine = une ligne, et la bascule est automatique.
 */
function buildM3u(channels, base, { all = false } = {}) {
  const root = `${base}/iptv/${config.IPTV_TOKEN}`;
  const lines = [epg.enabled() ? `#EXTM3U url-tvg="${root}/epg.xml.gz" x-tvg-url="${root}/epg.xml.gz"` : '#EXTM3U'];

  for (const channel of channels) {
    const common = `tvg-id="${attr(channel.tvgId)}" tvg-logo="${attr(channel.logo)}" group-title="${attr(channel.group)}"`;
    if (!all) {
      lines.push(`#EXTINF:-1 tvg-chno="${channel.num}" tvg-name="${attr(channel.name)}" ${common},${channel.name}`);
      lines.push(`${root}/play/${channel.key}.m3u8`);
      continue;
    }
    for (const stream of channel.streams) {
      const title = `${channel.name} · ${stream.label}`;
      lines.push(`#EXTINF:-1 tvg-name="${attr(title)}" ${common},${title}`);
      lines.push(`${root}/play/${channel.key}/${stream.sid}.m3u8`);
    }
  }
  return `${lines.join('\n')}\n`;
}

async function sendPlaylist(req, res) {
  const { channels } = await lineup.get();
  const all = /^(all|1|true)$/i.test(String(req.query.sources || ''));
  res.set('Cache-Control', 'no-store');
  res.type('audio/x-mpegurl').send(buildM3u(channels, baseUrl(req), { all }));
}

/** Guide filtre sur la grille. `.xml` le sert decompresse, pour les lecteurs qui ignorent le gzip. */
async function sendEpg(res, { gzip }) {
  const { channels } = await lineup.get();
  const ids = new Set(channels.map((channel) => channel.tvgId).filter(Boolean));
  const file = await epg.filteredFile(ids);
  if (!file) return res.status(404).type('text/plain').send('guide indisponible');

  // Le repli sur le fichier source peut rendre un XML non compresse (IPTV_EPG_URL en .xml).
  const head = Buffer.alloc(2);
  const fd = fs.openSync(file, 'r');
  fs.readSync(fd, head, 0, 2, 0);
  fs.closeSync(fd);
  const compressed = head[0] === 0x1f && head[1] === 0x8b;

  res.set('Cache-Control', 'public, max-age=3600');
  const stream = fs.createReadStream(file);
  stream.on('error', () => res.destroy());
  if (gzip && compressed) return stream.pipe(res.type('application/gzip'));
  res.type('application/xml');
  return (compressed ? stream.pipe(zlib.createGunzip()) : stream).pipe(res);
}

function redirect(res, url) {
  // Jamais de cache: l'URL cible porte un jeton qui expire, et change d'un zap a l'autre.
  res.set('Cache-Control', 'no-store');
  res.redirect(302, url);
}

// Debit annonce par palier, faute de mesure: il sert au lecteur a ordonner ses choix.
const NOMINAL = {
  2160: { bandwidth: 16000000, resolution: '3840x2160' },
  1080: { bandwidth: 6000000, resolution: '1920x1080' },
  720: { bandwidth: 3000000, resolution: '1280x720' },
  480: { bandwidth: 1200000, resolution: '854x480' },
};

/**
 * Variantes de qualite d'une chaine: le meilleur flux vivant de CHAQUE definition.
 *
 * Un lecteur ne propose un choix de qualite que s'il recoit un master HLS a plusieurs
 * variantes; une redirection vers un flux unique n'en a aucune. On lui en fabrique donc
 * un, dont chaque variante est un de nos flux. Une seule par definition: le menu du
 * lecteur liste des definitions, et dix "1080p" indiscernables n'aideraient personne.
 */
function variantsOf(channel) {
  const usable = channel.streams.filter((stream) => stream.ok !== false && !stream.backup && !stream.eventOnly);
  const seen = new Set();
  const variants = [];
  for (const stream of usable) {
    if (!NOMINAL[stream.quality] || seen.has(stream.quality)) continue;
    seen.add(stream.quality);
    variants.push(stream);
  }
  return variants;
}

function buildMaster(channel, variants, base) {
  const root = `${base}/iptv/${config.IPTV_TOKEN}/play/${channel.key}`;
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];
  for (const stream of variants) {
    const nominal = NOMINAL[stream.quality];
    const resolution = stream.width && stream.height ? `${stream.width}x${stream.height}` : nominal.resolution;
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${nominal.bandwidth},RESOLUTION=${resolution},NAME="${attr(stream.label)}"`);
    lines.push(`${root}/${stream.sid}.m3u8`);
  }
  return `${lines.join('\n')}\n`;
}

async function playChannel(req, res, channel) {
  if (!channel) return res.status(404).type('text/plain').send('chaine inconnue');

  if (config.IPTV_VARIANTS && req.query.variants !== '0') {
    const variants = variantsOf(channel);
    if (variants.length > 1) {
      res.set('Cache-Control', 'no-store');
      return res.type('application/vnd.apple.mpegurl').send(buildMaster(channel, variants, baseUrl(req)));
    }
  }

  const result = await play.pick(channel);
  if (!result.url) return res.status(503).type('text/plain').send('aucun flux disponible pour cette chaine');
  if (config.IPTV_LOG) console.log(`[iptv] ${channel.name} -> ${result.stream.label}`);
  return redirect(res, result.url);
}

async function playStream(res, channel, sid) {
  const stream = channel?.streams.find((row) => row.sid === sid);
  if (!stream) return res.status(404).type('text/plain').send('flux inconnu');
  const url = await play.direct(stream);
  if (url) return redirect(res, url);
  // Le flux demande est mort: une autre definition vaut mieux qu'une erreur.
  const result = await play.pick(channel);
  if (!result.url) return res.status(503).type('text/plain').send('aucun flux disponible pour cette chaine');
  return redirect(res, result.url);
}

/** Etat lisible de la grille: route de diagnostic et page Chaines de la WebUI. */
function describe(view, { q, unmatched, merged } = {}) {
  const query = names.keyOf(q || '');
  const rows = view.all
    .filter((channel) => !query || channel.key.includes(query) || names.keyOf(channel.name).includes(query))
    .filter((channel) => !unmatched || !channel.tvgId)
    .filter((channel) => !merged || channel.aliases?.length);
  const streams = view.all.flatMap((channel) => channel.streams);
  return {
    builtAt: view.builtAt ? new Date(view.builtAt).toISOString() : null,
    channels: view.channels.length,
    hidden: view.all.length - view.channels.length,
    withGuide: view.channels.filter((channel) => channel.tvgId).length,
    streams: streams.length,
    alive: streams.filter((stream) => stream.ok === true).length,
    dead: streams.filter((stream) => stream.ok === false).length,
    measured: streams.filter((stream) => stream.height).length,
    rankBy: config.IPTV_RANK_BY,
    variants: config.IPTV_VARIANTS,
    sweep: health.status(),
    groups: names.GROUPS,
    shown: rows.length,
    rows: rows.map((channel) => ({
      num: channel.num || null,
      id: channel.id,
      key: channel.key,
      name: channel.name,
      group: channel.group,
      logo: channel.logo,
      tvgId: channel.tvgId,
      hidden: channel.hidden,
      ...(channel.aliases?.length ? { aliases: channel.aliases } : {}),
      streams: channel.streams.map((stream) => ({
        sid: stream.sid,
        source: stream.source,
        label: stream.label,
        raw: stream.raw,
        announced: stream.announced,
        ...(stream.height ? { width: stream.width, height: stream.height, codec: stream.codec } : {}),
        ok: stream.ok,
        checkedAt: stream.checkedAt,
        ...(stream.preferred ? { preferred: true } : {}),
      })),
    })),
  };
}

const stripExt = (file) => String(file || '').replace(/\.(?:m3u8|ts|mp4)$/i, '');

// --- Facade M3U ----------------------------------------------------------------

const router = express.Router();

router.use('/iptv/:token', (req, res, next) => {
  if (!enabled()) return res.status(404).end();
  if (!tokenOk(req.params.token)) return res.status(403).type('text/plain').send('jeton invalide');
  return next();
});

router.get('/iptv/:token/playlist.m3u', sendPlaylist);
router.get('/iptv/:token/playlist.m3u8', sendPlaylist);
router.get('/iptv/:token/epg.xml.gz', (_req, res) => sendEpg(res, { gzip: true }));
router.get('/iptv/:token/epg.xml', (_req, res) => sendEpg(res, { gzip: false }));

router.get('/iptv/:token/play/:file', async (req, res) => {
  const { byKey } = await lineup.get();
  return playChannel(req, res, byKey.get(stripExt(req.params.file)));
});

router.get('/iptv/:token/play/:key/:file', async (req, res) => {
  const { byKey } = await lineup.get();
  return playStream(res, byKey.get(req.params.key), stripExt(req.params.file));
});

/**
 * Etat de la grille, pour comprendre une fusion ratee.
 *   ?q=tf1         filtre sur le nom
 *   ?unmatched=1   chaines sans guide (candidates a un alias dans names.js)
 *   ?merged=1      chaines nees d'un rapprochement d'ecritures, pour le relire
 */
router.get('/iptv/:token/channels.json', async (req, res) => {
  const view = await lineup.get();
  res.json(describe(view, { q: req.query.q, unmatched: req.query.unmatched, merged: req.query.merged }));
});

/** Teste la bascule d'une chaine sans lecteur: quels flux essayes, lequel retenu. */
router.get('/iptv/:token/test/:key', async (req, res) => {
  const { byKey } = await lineup.get();
  const channel = byKey.get(names.keyOf(req.params.key));
  if (!channel) return res.status(404).json({ error: 'chaine inconnue' });
  const started = Date.now();
  const result = await play.pick(channel, { fresh: true });
  return res.json({
    channel: channel.name,
    ms: Date.now() - started,
    chosen: result.stream?.label || null,
    host: result.url ? new URL(result.url).host : null,
    tried: result.tried,
  });
});

router.post('/iptv/:token/refresh', async (_req, res) => {
  await epg.refresh({ force: true });
  const state = await lineup.refresh();
  res.json({ channels: state.channels.length, builtAt: new Date(state.builtAt).toISOString() });
});

// --- Facade Xtream ---------------------------------------------------------------
// Le mot de passe EST le jeton; l'identifiant est libre (les applications en exigent un).

function xtreamAuth(req, res, next) {
  if (!enabled()) return next('route');
  if (!tokenOk(req.query.password)) return res.status(403).json({ user_info: { auth: 0 } });
  return next();
}

function xtreamCategories(channels) {
  const present = new Set(channels.map((channel) => channel.group));
  return names.GROUPS.filter((group) => present.has(group)).map((group) => ({
    category_id: String(names.GROUPS.indexOf(group) + 1),
    category_name: group,
    parent_id: 0,
  }));
}

function xtreamStream(channel) {
  return {
    num: channel.num,
    name: channel.name,
    stream_type: 'live',
    stream_id: channel.id,
    stream_icon: channel.logo || '',
    epg_channel_id: channel.tvgId || null,
    added: '0',
    category_id: String(names.GROUPS.indexOf(channel.group) + 1),
    custom_sid: '',
    tv_archive: 0,
    direct_source: '',
    tv_archive_duration: 0,
  };
}

const parisTime = (ms) => new Date(ms).toLocaleString('sv-SE', { timeZone: 'Europe/Paris' });
const base64 = (text) => Buffer.from(String(text || ''), 'utf8').toString('base64');

/** Programmes a venir d'une chaine, au format Xtream (titres et resumes en base64). */
async function shortEpg(channel, channels, limit) {
  if (!channel?.tvgId) return [];
  const ids = new Set(channels.map((row) => row.tvgId).filter(Boolean));
  const list = (await epg.programmes(ids)).get(channel.tvgId) || [];
  const now = Date.now();
  return list
    .filter((programme) => programme.stop > now)
    .slice(0, limit)
    .map((programme) => ({
      id: String(Math.floor(programme.start / 1000)),
      epg_id: channel.tvgId,
      title: base64(programme.title),
      lang: 'fr',
      start: parisTime(programme.start),
      end: parisTime(programme.stop),
      description: base64(programme.desc),
      channel_id: channel.tvgId,
      start_timestamp: String(Math.floor(programme.start / 1000)),
      stop_timestamp: String(Math.floor(programme.stop / 1000)),
      now_playing: programme.start <= now ? 1 : 0,
      has_archive: 0,
    }));
}

router.get('/player_api.php', xtreamAuth, async (req, res) => {
  const { channels, byId } = await lineup.get();
  const action = String(req.query.action || '');

  if (action === 'get_live_categories') return res.json(xtreamCategories(channels));
  if (action === 'get_live_streams') {
    const category = req.query.category_id ? String(req.query.category_id) : null;
    return res.json(channels.map(xtreamStream).filter((row) => !category || row.category_id === category));
  }
  // Ni films ni series: des listes vides, pas des erreurs, pour ne pas bloquer l'accueil.
  if (/^get_(?:vod|series)/.test(action)) return res.json([]);
  if (action === 'get_short_epg' || action === 'get_simple_data_table') {
    // Guide court = les N prochains programmes; table complete = toute la fenetre connue.
    const limit = action === 'get_short_epg' ? Math.max(1, Number(req.query.limit) || 4) : Infinity;
    return res.json({ epg_listings: await shortEpg(byId.get(String(req.query.stream_id || '')), channels, limit) });
  }

  const base = new URL(baseUrl(req));
  const https = base.protocol === 'https:';
  const now = Math.floor(Date.now() / 1000);
  return res.json({
    user_info: {
      username: String(req.query.username || 'movix'),
      password: config.IPTV_TOKEN,
      message: 'Movix',
      auth: 1,
      status: 'Active',
      exp_date: null,
      is_trial: '0',
      active_cons: '0',
      created_at: String(now),
      max_connections: '10',
      // HLS seulement: la route de lecture redirige vers une playlist, jamais un .ts.
      allowed_output_formats: ['m3u8'],
    },
    server_info: {
      url: base.hostname,
      port: https ? '80' : base.port || '80',
      https_port: https ? base.port || '443' : '443',
      server_protocol: https ? 'https' : 'http',
      rtmp_port: '0',
      timezone: 'Europe/Paris',
      timestamp_now: now,
      time_now: new Date().toISOString().slice(0, 19).replace('T', ' '),
    },
  });
});

router.get('/xmltv.php', xtreamAuth, (_req, res) => sendEpg(res, { gzip: false }));
router.get('/get.php', xtreamAuth, sendPlaylist);

async function xtreamPlay(req, res, next) {
  // Meme forme d'URL que des routes Stremio a trois segments (`/meta/tv/x.json`): on ne
  // repond que si le deuxieme segment est le jeton, et on passe la main sinon.
  if (!enabled() || !tokenOk(req.params.password) || !/^\d+(?:\.\w+)?$/.test(req.params.file)) return next();
  const { byId } = await lineup.get();
  return playChannel(req, res, byId.get(stripExt(req.params.file)));
}

router.get('/live/:username/:password/:file', xtreamPlay);
router.get('/:username/:password/:file', xtreamPlay);

function start() {
  if (!config.IPTV_ENABLED) return;
  if (!config.IPTV_TOKEN) {
    console.warn('[iptv] IPTV_ENABLED sans IPTV_TOKEN: playlist desactivee (elle exposerait l\'acces VIP sans protection)');
    return;
  }
  lineup.start();
  health.start(lineup.allStreams);
}

module.exports = { router, start, enabled, describe };
