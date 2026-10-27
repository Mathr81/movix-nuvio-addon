const config = require('../core/config');
const lineup = require('./lineup');
const overrides = require('./overrides');
const health = require('./health');
const play = require('./play');
const epg = require('./epg');
const routes = require('./routes');
const streamProxy = require('../streaming/streamProxy');

/**
 * Cote administration de la playlist IPTV, appele par la WebUI (`/ui/api/iptv/...`).
 * Rien ici n'est expose par les routes a jeton: ce sont des ECRITURES.
 */

function publicUrls() {
  if (!config.PUBLIC_URL) return null;
  const base = config.PUBLIC_URL.replace(/\/+$/, '');
  // Le jeton ne sort que derriere un mot de passe: une WebUI ouverte le donnerait a tous.
  const token = config.WEBUI_PASSWORD ? config.IPTV_TOKEN : '<IPTV_TOKEN>';
  return {
    tokenShown: !!config.WEBUI_PASSWORD,
    m3u: `${base}/iptv/${token}/playlist.m3u`,
    m3uAll: `${base}/iptv/${token}/playlist.m3u?sources=all`,
    epg: `${base}/iptv/${token}/epg.xml.gz`,
    // + `/<cle>.m3u8` (chaine, bascule auto) ou `/<cle>/<sid>.m3u8` (un flux precis)
    play: `${base}/iptv/${token}/play`,
    xtream: { server: base, username: 'movix', password: token },
  };
}

async function state() {
  if (!routes.enabled()) return { enabled: false };
  const view = await lineup.get();
  const edits = overrides.get();
  return {
    enabled: true,
    urls: publicUrls(),
    edits: {
      hiddenGroups: edits.hiddenGroups,
      splits: edits.splits,
      merges: edits.merges,
      count:
        edits.hiddenChannels.length + edits.hiddenGroups.length + edits.splits.length +
        Object.keys(edits.preferred).length + Object.keys(edits.merges).length +
        Object.keys(edits.groups).length + Object.keys(edits.names).length,
    },
    ...routes.describe(view),
  };
}

async function override(action, payload) {
  const remerge = overrides.apply(action, payload);
  if (remerge) await lineup.remerge();
  return { ok: true };
}

async function test(key) {
  const { byKey } = await lineup.get();
  const channel = byKey.get(key);
  if (!channel) throw Object.assign(new Error('chaine inconnue'), { status: 404 });
  const started = Date.now();
  const result = await play.pick(channel, { fresh: true });
  return {
    ms: Date.now() - started,
    chosen: result.stream ? { sid: result.stream.sid, label: result.stream.label } : null,
    host: result.url ? new URL(result.url).host : null,
    tried: result.tried,
  };
}

/**
 * Lien a lire dans la WebUI: la chaine (bascule auto) ou un de ses flux. Le zap renvoie
 * l'URL amont, que le navigateur ne peut pas lire lui-meme (CORS): on la proxifie.
 */
async function watch(key, sid) {
  const { byKey } = await lineup.get();
  const channel = byKey.get(key);
  if (!channel) throw Object.assign(new Error('chaine inconnue'), { status: 404 });
  const stream = sid ? channel.streams.find((s) => s.sid === sid) : null;
  if (sid && !stream) throw Object.assign(new Error('flux inconnu'), { status: 404 });
  const picked = stream ? { url: await play.direct(stream), stream } : await play.pick(channel);
  if (!picked.url) throw Object.assign(new Error('aucun flux ne répond'), { status: 502 });
  return {
    label: picked.stream.label,
    url: config.STREAM_PROXY_ENABLED ? streamProxy.proxyUrl(picked.url, { headers: { 'User-Agent': health.USER_AGENT }, playlistHints: ['m3u8'] }) : picked.url,
  };
}

/** Lance une ronde sans l'attendre: elle dure plusieurs minutes, la page suit sa progression. */
function sweep() {
  health.sweep(lineup.allStreams);
  return { ok: true, started: true };
}

async function refresh() {
  await epg.refresh({ force: true });
  await lineup.refresh();
  return { ok: true };
}

module.exports = { state, override, test, watch, sweep, refresh };
