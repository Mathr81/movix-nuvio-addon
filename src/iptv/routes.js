const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');
const express = require('express');
const config = require('../core/config');
const lineup = require('./lineup');
const epg = require('./epg');
const play = require('./play');
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

async function playChannel(res, channel) {
  if (!channel) return res.status(404).type('text/plain').send('chaine inconnue');
  const result = await play.pick(channel);
  if (!result.url) return res.status(503).type('text/plain').send('aucun flux disponible pour cette chaine');
  if (config.IPTV_LOG) console.log(`[iptv] ${channel.name} -> ${result.stream.label}`);
  return redirect(res, result.url);
}

async function playStream(res, channel, sid) {
  const stream = channel?.streams.find((row) => row.sid === sid);
  if (!stream) return res.status(404).type('text/plain').send('flux inconnu');
  const url = await play.direct(stream);
  if (!url) return res.status(502).type('text/plain').send('flux non resolu');
  return redirect(res, url);
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
  return playChannel(res, byKey.get(stripExt(req.params.file)));
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
  const { channels, builtAt } = await lineup.get();
  const failing = new Set(play.health());
  const query = names.keyOf(req.query.q || '');
  const rows = channels
    .filter((channel) => !query || channel.key.includes(query))
    .filter((channel) => !req.query.unmatched || !channel.tvgId)
    .filter((channel) => !req.query.merged || channel.aliases?.length);
  res.json({
    builtAt: new Date(builtAt).toISOString(),
    channels: channels.length,
    withGuide: channels.filter((channel) => channel.tvgId).length,
    streams: channels.reduce((sum, channel) => sum + channel.streams.length, 0),
    shown: rows.length,
    rows: rows.map((channel) => ({
      num: channel.num,
      id: channel.id,
      key: channel.key,
      name: channel.name,
      group: channel.group,
      tvgId: channel.tvgId,
      ...(channel.aliases?.length ? { aliases: channel.aliases } : {}),
      streams: channel.streams.map((stream) => ({
        sid: stream.sid,
        label: stream.label,
        raw: stream.raw,
        ...(failing.has(stream.sid) ? { failing: true } : {}),
      })),
    })),
  });
});

/** Teste la bascule d'une chaine sans lecteur: quels flux essayes, lequel retenu. */
router.get('/iptv/:token/test/:key', async (req, res) => {
  const { byKey } = await lineup.get();
  const channel = byKey.get(names.keyOf(req.params.key));
  if (!channel) return res.status(404).json({ error: 'chaine inconnue' });
  const started = Date.now();
  const result = await play.pick(channel);
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

router.get('/player_api.php', xtreamAuth, async (req, res) => {
  const { channels } = await lineup.get();
  const action = String(req.query.action || '');

  if (action === 'get_live_categories') return res.json(xtreamCategories(channels));
  if (action === 'get_live_streams') {
    const category = req.query.category_id ? String(req.query.category_id) : null;
    return res.json(channels.map(xtreamStream).filter((row) => !category || row.category_id === category));
  }
  // Ni films ni series: des listes vides, pas des erreurs, pour ne pas bloquer l'accueil.
  if (/^get_(?:vod|series)/.test(action)) return res.json([]);
  // Guide court: non servi ici, les applications retombent sur xmltv.php.
  if (action === 'get_short_epg' || action === 'get_simple_data_table') return res.json({ epg_listings: [] });

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
  return playChannel(res, byId.get(stripExt(req.params.file)));
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
}

module.exports = { router, start, enabled };
