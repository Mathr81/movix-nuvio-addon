const https = require('https');
const axios = require('axios');
const config = require('../config');
const kit = require('./kit');

/**
 * Diagnostic du serveur "link" d'Aether.
 *
 * Ce serveur est le seul dont le flux vient d'un CDN tiers, et le seul a poser probleme.
 * Plutot que d'essayer des correctifs a l'aveugle, ce script joue LA MEME requete avec
 * plusieurs jeux d'en-tetes et affiche ce que chacun obtient: c'est la reponse du CDN qui
 * dit quel chemin fonctionne, pas une supposition.
 *
 *   npm run aether:diag -- 157336
 */

const insecureAgent = new https.Agent({ rejectUnauthorized: false });

// Espacement entre deux requetes vers le meme CDN. Sans lui, le diagnostic declenche
// lui-meme la limitation de debit qu'il cherche a mesurer.
const REQUEST_SPACING_MS = 1500;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const http = axios.create({
  timeout: 15000,
  maxRedirects: 5,
  httpsAgent: insecureAgent,
  validateStatus: () => true,
});

function preview(data, length = 90) {
  const text = typeof data === 'string' ? data : JSON.stringify(data ?? '');
  return text.replace(/\s+/g, ' ').slice(0, length);
}

async function timed(label, request) {
  const startedAt = Date.now();
  try {
    const response = await request();
    const elapsed = Date.now() - startedAt;
    const type = response.headers['content-type'] || '?';
    const body = typeof response.data === 'string' ? response.data : '';
    const isPlaylist = body.trimStart().startsWith('#EXTM3U');

    console.log(
      `  ${label.padEnd(34)} ${String(response.status).padEnd(4)} ${String(elapsed).padStart(6)} ms  ` +
        `${isPlaylist ? 'PLAYLIST' : type.slice(0, 24).padEnd(8)}  ${preview(response.data, 60)}`,
    );
    return { ...response, elapsed, isPlaylist, body };
  } catch (err) {
    console.log(`  ${label.padEnd(34)} ${'ERR'.padEnd(4)} ${String(Date.now() - startedAt).padStart(6)} ms  ${err.message}`);
    return null;
  }
}

/** Premiere URI de la playlist qui ne soit ni vide ni une balise. */
function firstUri(body) {
  return body
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('#'));
}

/**
 * Nature reelle d'une reponse, lue sur ses octets.
 *
 * Un CDN qui refuse un segment ne repond pas forcement 403: il sert volontiers une page
 * d'erreur en 200. Le lecteur, lui, n'y voit pas de video, redemande, et boucle sans
 * jamais demarrer -- ce que le seul code de statut ne montre pas.
 */
function identify(buffer) {
  if (buffer.length === 0) return { kind: 'vide', playable: false };
  const head = buffer.subarray(0, 16).toString('latin1');
  if (head.trimStart().startsWith('<')) return { kind: 'HTML (page d\'erreur ou anti-bot)', playable: false };
  if (head.startsWith('#EXTM3U')) return { kind: 'playlist', playable: false };
  // MPEG-TS: octet de synchro 0x47 tous les 188 octets.
  if (buffer[0] === 0x47 && (buffer.length < 189 || buffer[188] === 0x47)) return { kind: 'MPEG-TS', playable: true };
  const boxType = buffer.subarray(4, 8).toString('latin1');
  if (['ftyp', 'moof', 'styp', 'sidx'].includes(boxType)) return { kind: `MP4 fragmente (${boxType})`, playable: true };
  return { kind: 'binaire non reconnu', playable: buffer.length > 10000 };
}

/**
 * Suit la chaine master -> variante -> segment et rend compte du SEGMENT.
 * C'est la seule etape qui prouve qu'un flux est jouable.
 */
async function walkToSegment(title, playlistUrl, headers, label) {
  console.log(`\n${title}`);

  let currentUrl = playlistUrl;
  for (let depth = 0; depth < 3; depth += 1) {
    await pause(REQUEST_SPACING_MS);
    const response = await timed(`playlist niveau ${depth + 1}`, () =>
      http.get(currentUrl, { headers, responseType: 'text' }),
    );
    // Une expiration APRES un premier niveau servi n'est pas un refus: c'est le CDN qui
    // s'est tu. On le distingue, c'est ce qui oriente vers la limitation de debit.
    if (!response) return { playable: false, timedOut: depth > 0 };
    if (response.status >= 400 || !response.isPlaylist) return null;

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

    await pause(REQUEST_SPACING_MS);
    const segment = await timed('segment', () =>
      http.get(childUrl, { headers, responseType: 'arraybuffer' }),
    );
    if (!segment) return null;

    const buffer = Buffer.from(segment.data || []);
    const nature = identify(buffer);
    console.log(
      `   -> ${label}: ${buffer.length} octets, ${nature.kind}` +
        ` ${nature.playable ? '(LISIBLE)' : '(INEXPLOITABLE)'}`,
    );
    if (!nature.playable && buffer.length > 0) {
      console.log(`      debut: ${buffer.subarray(0, 120).toString('utf8').replace(/\s+/g, ' ')}`);
    }
    return nature;
  }
  return null;
}

async function diagnose(tmdbId) {
  const site = config.AETHER_SITE_ORIGIN.replace(/\/+$/, '');
  const cdn = config.AETHER_LINK_ORIGIN.replace(/\/+$/, '');

  const { slug } = await kit.titleOf('movie', tmdbId).catch(() => ({ slug: 'movie' }));
  const referer = `${site}/media/tmdb-movie-${tmdbId}-${slug}`;

  console.log(`\n=== Aether / link -- tmdbId=${tmdbId} ===`);
  console.log(`Page du media : ${referer}\n`);

  // 1. L'API rend-elle un flux ?
  console.log('1) API link.aether.cx');
  const api = await timed('GET /movie/:id', () =>
    http.get(`https://link.${config.AETHER_API_DOMAIN}/movie/${tmdbId}`, {
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
    console.log('\n=> L\'API ne rend aucun flux pour ce titre. Rien a diagnostiquer plus loin.');
    console.log('   (Essaie un autre tmdbId: tous les films ne sont pas sur ce serveur.)');
    return;
  }
  console.log(`\n   Flux annonce : ${stream.slice(0, 120)}${stream.length > 120 ? '...' : ''}`);

  const cdnHeaders = { origin: cdn, referer: `${cdn}/`, 'user-agent': kit.BROWSER_UA, accept: '*/*' };
  const siteHeaders = { origin: site, referer, 'user-agent': kit.BROWSER_UA, accept: '*/*' };
  const jbamUrl =
    `${config.AETHER_M3U8_PROXY}?url=${encodeURIComponent(stream)}` +
    `&headers=${encodeURIComponent(JSON.stringify({ Origin: cdn, Referer: `${cdn}/` }))}`;

  // Les chaines completes D'ABORD, et une seule requete a la fois.
  //
  // Ce CDN limite le debit de requetes: une rafale rapide passe les premieres et fait
  // expirer les suivantes. Mesurer la matrice d'en-tetes en premier declenchait donc la
  // limite AVANT d'arriver aux segments, et faisait conclure a tort que rien ne sortait.
  const directSegment = await walkToSegment('2) Chaine complete en direct', stream, cdnHeaders, 'direct');
  const jbamSegment = await walkToSegment('3) Chaine complete par jbam', jbamUrl, siteHeaders, 'jbam');

  // Quel jeu d'en-tetes le CDN accepte-t-il ? Secondaire: on sait deja que la lecture
  // n'echoue pas la-dessus, et c'est l'etape la plus consommatrice en requetes.
  console.log('\n4) Acces au CDN, meme URL, en-tetes differents');
  const attempts = {
    'aucun en-tete': {},
    [`origin ${cdn}`]: cdnHeaders,
    [`origin ${site}`]: siteHeaders,
    'user-agent seul': { 'user-agent': kit.BROWSER_UA },
  };

  const results = {};
  for (const [label, headers] of Object.entries(attempts)) {
    await pause(REQUEST_SPACING_MS);
    results[label] = await timed(label, () => http.get(stream, { headers, responseType: 'text' }));
  }
  const winner = Object.entries(results).find(([, r]) => r?.isPlaylist);

  // Des expirations qui n'apparaissent qu'apres coup ne disent rien des en-tetes: elles
  // disent que le CDN a cesse de repondre a CE demandeur.
  const timeouts = Object.values(results).filter((r) => r === null).length;
  const rateLimited = timeouts > 0 && Object.values(results).some((r) => r?.isPlaylist);

  // --- Verdict --------------------------------------------------------------
  console.log('\n=== Verdict ===');
  if (directSegment?.playable) {
    console.log('L\'acces DIRECT sort un segment lisible de bout en bout.');
    console.log('=> AETHER_LINK_VIA_JBAM=false convient, et est plus rapide.');
  } else if (jbamSegment?.playable) {
    console.log('Seul le chemin par JBAM sort un segment lisible.');
    if (winner) {
      console.log('En direct, la playlist se resout mais le segment ne suit pas: c\'est exactement');
      console.log('ce qui fait boucler le lecteur sans jamais demarrer.');
    }
    console.log('=> AETHER_LINK_VIA_JBAM=true (valeur par defaut).');
  } else if (rateLimited || directSegment?.timedOut || jbamSegment?.timedOut) {
    console.log('Le CDN a cesse de repondre en cours de route, apres avoir servi les premieres');
    console.log('requetes: il LIMITE LE DEBIT de requetes par demandeur.');
    console.log('');
    console.log('C\'est coherent avec le symptome de lecture: la sonde de debit depense le');
    console.log('quota en pesant 5 segments avant meme que tu appuies sur lecture, et le');
    console.log('lecteur se retrouve devant un CDN muet -- d\'ou la boucle sans demarrage.');
    console.log('=> AETHER_PROBE_LINK=false (defaut) empeche la sonde de toucher ce serveur.');
  } else if (winner) {
    console.log('Les playlists se resolvent mais aucun segment lisible n\'a ete obtenu.');
    console.log('Le flux annonce est peut-etre lie a une session ou a l\'IP du demandeur.');
  } else {
    console.log('Aucun chemin ne rend de playlist -- ni en direct, ni par jbam.');
    console.log('Le flux annonce par l\'API est probablement expire, a usage unique, ou lie a une session.');
  }
  console.log('');
}

module.exports = { diagnose };

if (require.main === module) {
  diagnose(process.argv[2] || '157336').catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
