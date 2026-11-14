const config = require('../core/config');
const { mainApi } = require('../integrations/movixClient');
const streamProxy = require('../streaming/streamProxy');
const log = require('../core/log');

/**
 * SwiftFlux, le versant MP4 direct de SwiftFlow (Mainapi/routes/swiftflow.js).
 *
 * Le catalogue (`/api/swiftflow/movie/:id`, `/tv/:id/season/:s?episode=`) ne rend qu'un
 * iframe (blinkflux, derriere une page pub) et un bloc `mp4` sans URL. L'URL du fichier
 * s'obtient par `POST /api/swiftflow/tv/mp4/resolve`, la route de l'appli tele Movix:
 * ouverte sans captcha par choix de Movix, limitee a 60 appels / 10 min par IP.
 *
 * Le CDN n'autorise que le Referer des domaines Movix (sinon il rend une page HTML):
 * le fichier passe donc par notre proxy, qui relaie le Range du lecteur.
 *
 * Cache froid cote Movix: le catalogue repond `pending` et charge en fond. On reessaie
 * une fois apres un court delai.
 */
const PENDING_RETRY_MS = 2500;

async function catalog(tmdbId, type, season, episode) {
  const get = () =>
    type === 'movie'
      ? mainApi.get(`/api/swiftflow/movie/${tmdbId}`)
      : mainApi.get(`/api/swiftflow/tv/${tmdbId}/season/${season}`, { params: { episode } });
  let { data } = await get();
  if (data?.pending) {
    await new Promise((resolve) => setTimeout(resolve, PENDING_RETRY_MS));
    ({ data } = await get());
  }
  return data;
}

async function getStreams({ tmdbId, type, season, episode }) {
  try {
    const data = await catalog(tmdbId, type, season, episode);
    const entries = data?.success ? data.mp4?.entries || [] : [];
    if (entries.length === 0) {
      log.ok('SwiftFlux', tmdbId, data?.pending ? 'chargement en cours cote Movix' : `rien (${data?.error || 'pas de MP4'})`);
      return [];
    }

    const kind = type === 'movie' ? 'movie' : 'tv';
    const items = [];
    for (const entry of entries) {
      const { data: file } = await mainApi.post('/api/swiftflow/tv/mp4/resolve', {
        kind, tmdbId: Number(tmdbId), season: Number(season) || undefined, episode: Number(episode) || undefined, index: entry.index,
      });
      if (!file?.success || typeof file.url !== 'string') continue;
      const referer = `${config.SPOOFED_ORIGIN.replace(/\/+$/, '')}/`;
      items.push({
        url: config.STREAM_PROXY_ENABLED ? streamProxy.proxyUrl(file.url, { headers: { referer }, rules: [{ match: '.', contentType: 'video/mp4' }] }) : file.url,
        sourceName: 'SwiftFlux',
        player: 'SwiftFlux',
        lang: file.language || entry.language,
        quality: [file.quality, file.size].filter(Boolean).join(' ') || undefined,
        direct: true,
      });
    }
    log.ok('SwiftFlux', tmdbId, `${type === 'movie' ? '' : `S${season}E${episode}: `}${items.length} fichier(s) MP4`);
    return items;
  } catch (err) {
    log.fail('SwiftFlux', tmdbId, err);
    return [];
  }
}

module.exports = { name: 'SwiftFlux', getStreams };
