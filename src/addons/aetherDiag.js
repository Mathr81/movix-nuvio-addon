const https = require('https');
const axios = require('axios');
const config = require('../config');
const kit = require('./kit');

/**
 * Diagnostic d'un serveur Aether: suit la chaine master -> variante -> segment et se
 * prononce sur les OCTETS du segment, pas sur son code de statut.
 *
 * C'est la seule etape qui prouve qu'un flux est jouable. Un CDN qui refuse un segment ne
 * repond pas forcement 403: il sert volontiers une page d'erreur en 200, et un proxy peut
 * etiqueter de la video en text/html. Dans les deux cas le lecteur redemande en boucle
 * sans jamais demarrer, et rien dans les statuts ne le laisse voir.
 *
 *   npm run aether:diag -- 157336          (film)
 *   npm run aether:diag -- 273240 1 1      (serie: tmdbId saison episode)
 */

const insecureAgent = new https.Agent({ rejectUnauthorized: false });

const http = axios.create({
  timeout: 15000,
  maxRedirects: 5,
  httpsAgent: insecureAgent,
  validateStatus: () => true,
});

function preview(data, length = 60) {
  const text = typeof data === 'string' ? data : JSON.stringify(data ?? '');
  return text.replace(/\s+/g, ' ').slice(0, length);
}

async function timed(label, request) {
  const startedAt = Date.now();
  try {
    const response = await request();
    const elapsed = Date.now() - startedAt;
    const body = typeof response.data === 'string' ? response.data : '';
    const isPlaylist = body.trimStart().startsWith('#EXTM3U');

    console.log(
      `  ${label.padEnd(22)} ${String(response.status).padEnd(4)} ${String(elapsed).padStart(6)} ms  ` +
        `${isPlaylist ? 'PLAYLIST' : (response.headers['content-type'] || '?').slice(0, 26)}  ${preview(response.data)}`,
    );
    return { ...response, isPlaylist, body };
  } catch (err) {
    console.log(`  ${label.padEnd(22)} ${'ERR'.padEnd(4)} ${String(Date.now() - startedAt).padStart(6)} ms  ${err.message}`);
    return null;
  }
}

/**
 * Nature reelle d'une reponse, lue sur ses octets: c'est ce qu'un demuxeur y verra, quel
 * que soit le type MIME annonce.
 */
function identify(buffer) {
  if (buffer.length === 0) return { kind: 'vide', playable: false };
  const head = buffer.subarray(0, 16).toString('latin1');
  if (head.trimStart().startsWith('<')) return { kind: "HTML (page d'erreur ou anti-bot)", playable: false };
  if (head.startsWith('#EXTM3U')) return { kind: 'playlist', playable: false };
  // Gzip: une video servie compressee est illisible pour un lecteur.
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) return { kind: 'gzip (video compressee)', playable: false };
  // MPEG-TS: octet de synchro 0x47 tous les 188 octets.
  if (buffer[0] === 0x47 && (buffer.length <= 188 || buffer[188] === 0x47)) return { kind: 'MPEG-TS', playable: true };
  const boxType = buffer.subarray(4, 8).toString('latin1');
  if (['ftyp', 'moof', 'styp', 'sidx'].includes(boxType)) return { kind: `MP4 fragmente (${boxType})`, playable: true };
  return { kind: 'binaire non reconnu', playable: buffer.length > 10000 };
}

/** Premiere URI de la playlist qui ne soit ni vide ni une balise. */
function firstUri(body) {
  return body
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('#'));
}

async function walkToSegment(startUrl, headers) {
  let currentUrl = startUrl;

  for (let depth = 0; depth < 3; depth += 1) {
    const response = await timed(`playlist niveau ${depth + 1}`, () =>
      http.get(currentUrl, { headers, responseType: 'text' }),
    );
    if (!response || response.status >= 400 || !response.isPlaylist) return null;

    const uri = firstUri(response.body);
    if (!uri) {
      console.log('   (playlist sans element referencable)');
      return null;
    }

    const childUrl = new URL(uri, currentUrl).toString();
    // Encore une playlist ? On redescend. Sinon, c'est le segment.
    if (response.body.includes('#EXT-X-STREAM-INF')) {
      currentUrl = childUrl;
      continue;
    }

    // Sans Accept-Encoding explicite, le CDN peut renvoyer du gzip -- et c'est
    // precisement un des pieges: la video est bonne, mais illisible telle quelle.
    const segment = await timed('segment', () =>
      http.get(childUrl, { headers: { ...headers, 'Accept-Encoding': 'identity' }, responseType: 'arraybuffer' }),
    );
    if (!segment) return null;

    const buffer = Buffer.from(segment.data || []);
    const nature = identify(buffer);
    console.log(
      `\n   -> ${buffer.length} octets, ${nature.kind} ${nature.playable ? '(LISIBLE)' : '(INEXPLOITABLE)'}` +
        `\n      type MIME annonce: ${segment.headers['content-type'] || '(aucun)'}`,
    );
    if (!nature.playable && buffer.length > 0) {
      console.log(`      debut: ${buffer.subarray(0, 120).toString('utf8').replace(/\s+/g, ' ')}`);
    }
    return nature;
  }
  return null;
}

async function diagnose(tmdbId, season, episode) {
  const site = config.AETHER_SITE_ORIGIN.replace(/\/+$/, '');
  const cdn = config.AETHER_LINK_ORIGIN.replace(/\/+$/, '');
  const isSeries = season != null && episode != null;
  const type = isSeries ? 'series' : 'movie';

  const { slug } = await kit.titleOf(type, tmdbId).catch(() => ({ slug: type === 'series' ? 'tv' : 'movie' }));
  const { seasonId, episodeId } = isSeries
    ? await kit.episodeRef(tmdbId, season, episode).catch(() => ({}))
    : {};

  const page = `${site}/media/tmdb-${isSeries ? 'tv' : 'movie'}-${tmdbId}-${slug}`;
  const referer = isSeries && seasonId && episodeId ? `${page}/${seasonId}/${episodeId}` : page;
  const path = isSeries ? `/tv/${tmdbId}/${season}/${episode}` : `/movie/${tmdbId}`;

  console.log(`\n=== Aether / link -- tmdbId=${tmdbId}${isSeries ? ` S${season}E${episode}` : ''} ===`);
  console.log(`Page du media : ${referer}\n`);

  console.log('1) API link.aether.cx');
  const api = await timed(`GET ${path}`, () =>
    http.get(`https://link.${config.AETHER_API_DOMAIN}${path}`, {
      headers: {
        accept: '*/*',
        origin: site,
        referer: `${referer}?r=%2Fsettings%2Fsource%2Fembeds`,
        'user-agent': kit.BROWSER_UA,
      },
    }),
  );

  const stream = api?.data?.stream;
  if (!stream) {
    console.log("\n=> L'API ne rend aucun flux pour ce titre. Rien a diagnostiquer plus loin.");
    console.log('   (Essaie un autre titre ou un autre episode: le catalogue de ce serveur a des trous.)');
    return;
  }
  console.log(`\n   Flux annonce : ${stream.slice(0, 110)}${stream.length > 110 ? '...' : ''}`);

  console.log('\n2) Chaine complete jusqu\'au segment');
  const segment = await walkToSegment(stream, {
    accept: '*/*',
    'accept-language': kit.ACCEPT_LANGUAGE,
    origin: cdn,
    referer: `${cdn}/`,
    'user-agent': kit.BROWSER_UA,
  });

  console.log('\n=== Verdict ===');
  if (segment?.playable) {
    console.log('La chaine sort un segment lisible de bout en bout: rien a signaler.');
  } else if (segment) {
    console.log(`Le segment obtenu est ${segment.kind} -- le lecteur n'y verra pas de video`);
    console.log('et redemandera en boucle sans jamais demarrer.');
  } else {
    console.log('La chaine ne descend pas jusqu\'a un segment.');
    console.log(`Verifie AETHER_LINK_ORIGIN (actuellement ${cdn}) si le CDN a change d'exigence.`);
  }
  console.log('');
}

module.exports = { diagnose, identify };

if (require.main === module) {
  diagnose(process.argv[2] || '157336', process.argv[3], process.argv[4]).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
