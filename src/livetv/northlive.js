const axios = require('axios');
const config = require('../core/config');
const cache = require('../core/cache');
const streamProxy = require('../streaming/streamProxy');

/**
 * NorthLive: Movix ne donne qu'une page de lecteur (`/api/v1/tv/<slug>/player?api_key=`).
 * Le lecteur y lit un `PLAY_TOKEN`, puis `POST /api/v1/index.php?route=play_url` (refuse
 * sans l'Origin/Referer de northlive) rend une playlist HLS sur `tv_proxy.php`, jouable
 * depuis le VPS. Le CDN refuse certains User-Agent (okhttp, celui de Nuvio sur Android):
 * on sert donc le flux par notre proxy, avec un UA de navigateur.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';
// Le jeton `tok` de la playlist vaut ~1 h, le `pt` 2 h.
// shortcut: un direct regarde plus d'une heure d'affilee peut couper au renouvellement du jeton; rezapper le relance.
const RESOLVE_TTL_MS = 20 * 60 * 1000;

function isNorthlivePlayer(url) {
  return /^https?:\/\/[^/]*northlive\.[a-z]+\/api\/v1\/tv\/[^/]+\/player/i.test(String(url || ''));
}

/** Page de lecteur NorthLive -> URL HLS jouable (proxifiee si le proxy est actif), ou null. */
async function resolvePlayer(playerUrl) {
  return cache.wrap(`northlive:${playerUrl}`, RESOLVE_TTL_MS, 5000, async () => {
    const { origin, searchParams } = new URL(playerUrl);
    const key = searchParams.get('api_key') || '';
    const { data: html } = await axios.get(playerUrl, {
      timeout: 10000,
      headers: { 'User-Agent': UA, Referer: 'https://movix.cash/' },
    });
    const playToken = (String(html).match(/PLAY_TOKEN\s*=\s*"([^"]+)"/) || [])[1];
    const slug = (String(html).match(/PRIMARY_SLUG\s*=\s*"([^"]+)"/) || [])[1];
    if (!playToken || !slug) return null;

    const { data } = await axios.post(
      `${origin}/api/v1/index.php?route=play_url&api_key=${encodeURIComponent(key)}`,
      { slug, api_key: key, play_token: playToken },
      { timeout: 10000, headers: { 'User-Agent': UA, Origin: origin, Referer: playerUrl, Authorization: `Bearer ${key}` } },
    );
    if (!data?.success || typeof data.url !== 'string') return null;
    const url = new URL(data.url, origin);
    if (!url.searchParams.has('pt')) url.searchParams.set('pt', playToken);
    // Parametre ignore par NorthLive: dit au proxy que c'est une playlist (segments et
    // master partagent tv_proxy.php, un indice de chemin ferait relire chaque segment).
    url.searchParams.set('f', '.m3u8');

    return config.STREAM_PROXY_ENABLED
      ? streamProxy.proxyUrl(url.href, { headers: { accept: '*/*', 'user-agent': UA } })
      : url.href;
  });
}

module.exports = { isNorthlivePlayer, resolvePlayer };
