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

  // 2. Quel jeu d'en-tetes le CDN accepte-t-il ?
  console.log('\n2) Acces au CDN, meme URL, en-tetes differents');
  const attempts = {
    'aucun en-tete': {},
    [`origin ${cdn}`]: { origin: cdn, referer: `${cdn}/`, 'user-agent': kit.BROWSER_UA, accept: '*/*' },
    [`origin ${site}`]: { origin: site, referer, 'user-agent': kit.BROWSER_UA, accept: '*/*' },
    'referer seul': { referer: `${cdn}/`, 'user-agent': kit.BROWSER_UA },
    'user-agent seul': { 'user-agent': kit.BROWSER_UA },
  };

  const results = {};
  for (const [label, headers] of Object.entries(attempts)) {
    results[label] = await timed(label, () => http.get(stream, { headers, responseType: 'text' }));
  }

  // 3. Et par le proxy du site, pour comparer les temps de reponse.
  console.log('\n3) Par le proxy HLS du site (jbam)');
  const jbamUrl =
    `${config.AETHER_M3U8_PROXY}?url=${encodeURIComponent(stream)}` +
    `&headers=${encodeURIComponent(JSON.stringify({ Origin: cdn, Referer: `${cdn}/` }))}`;
  const viaJbam = await timed('GET /m3u8-proxy', () =>
    http.get(jbamUrl, {
      headers: { origin: site, referer, 'user-agent': kit.BROWSER_UA, accept: '*/*' },
      responseType: 'text',
    }),
  );

  // 4. Un segment sort-il vraiment ? Une playlist qui repond 200 ne prouve rien.
  const winner = Object.entries(results).find(([, r]) => r?.isPlaylist);
  if (winner) {
    const [label, response] = winner;
    const child = response.body
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith('#'));

    if (child) {
      console.log(`\n4) Premier element reference par la playlist (en-tetes: ${label})`);
      const childUrl = new URL(child, stream).toString();
      console.log(`   ${childUrl.slice(0, 110)}`);
      await timed('GET enfant', () =>
        http.get(childUrl, { headers: attempts[label], responseType: 'arraybuffer' }),
      );
    }
  }

  // --- Verdict --------------------------------------------------------------
  console.log('\n=== Verdict ===');
  if (winner) {
    console.log(`Le CDN rend une playlist avec "${winner[0]}".`);
    if (winner[0].includes(cdn)) {
      console.log('C\'est la configuration par defaut (AETHER_LINK_VIA_JBAM=false): rien a changer ici,');
      console.log('le probleme est donc en aval (lecture, proxy) et non a la resolution.');
    } else {
      console.log(`Ajuste AETHER_LINK_ORIGIN en consequence.`);
    }
  } else if (viaJbam?.isPlaylist) {
    console.log('Seul le proxy du site rend une playlist: le CDN refuse l\'acces direct.');
    console.log('=> Mets AETHER_LINK_VIA_JBAM=true dans .env.');
    if (viaJbam.elapsed > 5000) {
      console.log(`   (Il a mis ${viaJbam.elapsed} ms: augmente aussi STREAM_PROXY_TIMEOUT_MS et PROBE_TIMEOUT_MS.)`);
    }
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
