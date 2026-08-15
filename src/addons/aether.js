const config = require('../config');
const log = require('../log');
const kit = require('./kit');

/**
 * Aether (aether.bar) -- trois serveurs derriere le meme site, chacun avec sa propre
 * facon de rendre le flux:
 *
 *  - aurora (nebula.<domaine>) : renvoie directement l'URL m3u8 dans son JSON;
 *  - lul    (lul.<domaine>)    : renvoie une URL intermediaire qui repond 302 vers le master;
 *  - link   (link.<domaine>)   : renvoie une URL brute qu'il faut encapsuler dans le
 *                                m3u8-proxy officiel du site (le CDN d'origine refuse tout
 *                                ce qui ne vient pas de nextgencloudfabric.com).
 *
 * Point commun aux trois: les segments ne sortent que si la requete porte l'Origin du site
 * et le Referer de la page du media. C'est le proxy de flux qui s'en charge.
 *
 * Films uniquement: c'est la seule forme d'URL observee (`/movie/<tmdbId>`). Le jour ou
 * l'equivalent serie est identifie, il n'y a qu'a ajouter le chemin dans chaque resolveur
 * et basculer `supports.series`.
 */

const API_TIMEOUT_MS = 10000;

function siteOrigin() {
  return config.AETHER_SITE_ORIGIN.replace(/\/+$/, '');
}

/** URL de la page du media, telle que le site l'affiche -- c'est elle le Referer attendu. */
function mediaPageUrl(tmdbId, slug) {
  return `${siteOrigin()}/media/tmdb-movie-${tmdbId}-${slug || 'movie'}`;
}

function apiHeaders(refererUrl) {
  return { accept: '*/*', origin: siteOrigin(), referer: refererUrl };
}

/**
 * En-tetes de LECTURE, rejoues par le proxy sur la playlist puis sur chaque segment.
 * Plus complets que ceux des appels d'API: les CDN filtrent aussi sur les Client Hints.
 */
function playbackHeaders(refererUrl) {
  return {
    accept: '*/*',
    'accept-language': kit.ACCEPT_LANGUAGE,
    origin: siteOrigin(),
    referer: refererUrl,
    'user-agent': kit.BROWSER_UA,
    ...kit.chromeHints(),
  };
}

const PROXY_SPEC_RULES = [
  {
    // Aurora sert ses segments deguises en images TikTok, precedees de 8 octets d'amorce
    // qu'aucun demuxeur ne sait lire: on les retire et on retablit le vrai type MIME.
    match: 'tiktokcdn\\.com|origin\\.image',
    skipBytes: 8,
    contentType: 'video/mp2t',
  },
];

/** Premiere URL .m3u8 trouvee dans un JSON, quelle que soit la cle utilisee. */
function findM3u8(data, rawBody) {
  for (const key of ['url', 'file', 'src', 'stream', 'link']) {
    const value = data?.[key];
    if (typeof value === 'string' && value.includes('.m3u8')) return value.replace(/\\\//g, '/');
  }
  const match = /(https?:\/\/[^\s"']+\.m3u8[^\s"']*)/.exec(String(rawBody || '').replace(/\\\//g, '/'));
  return match ? match[1] : null;
}

const SERVERS = {
  aurora: {
    label: 'Aurora',
    async resolve({ http, tmdbId, refererUrl }) {
      const { data, status } = await http.get(`https://nebula.${config.AETHER_API_DOMAIN}/movie/${tmdbId}`, {
        params: { ser: 'tik' },
        headers: apiHeaders(refererUrl),
        validateStatus: () => true,
        // Le repli par regex a besoin du corps tel quel, pas d'un objet deja parse.
        transformResponse: (body) => body,
      });
      if (status !== 200) return null;

      let parsed = {};
      try {
        parsed = JSON.parse(data);
      } catch {
        // Reponse non-JSON: la regex sur le corps brut reste valable.
      }
      return findM3u8(parsed, data);
    },
  },

  lul: {
    label: 'Lul',
    async resolve({ http, tmdbId, refererUrl }) {
      const { data, status } = await http.get(`https://lul.${config.AETHER_API_DOMAIN}/movie/${tmdbId}`, {
        headers: apiHeaders(`${refererUrl}?r=%2Fsettings%2Fsource%2Fembeds`),
        validateStatus: () => true,
      });
      if (status !== 200 || !data?.stream) return null;

      // L'URL intermediaire ne sert qu'a porter une redirection: c'est sa cible qu'il faut
      // remettre au lecteur, pas elle (le 302 ne survit pas au passage dans le proxy HLS).
      const redirect = await http.get(data.stream, {
        headers: apiHeaders(refererUrl),
        maxRedirects: 0,
        validateStatus: () => true,
      });
      return redirect.headers?.location || (redirect.status < 400 ? data.stream : null);
    },
  },

  link: {
    label: 'Link',
    async resolve({ http, tmdbId, refererUrl }) {
      const { data, status } = await http.get(`https://link.${config.AETHER_API_DOMAIN}/movie/${tmdbId}`, {
        headers: apiHeaders(`${refererUrl}?r=%2Fsettings%2Fsource%2Fembeds`),
        validateStatus: () => true,
      });
      if (status !== 200 || !data?.stream) return null;

      // Ce flux vient d'un CDN tiers, qui attend l'Origin d'un autre site que celui d'ou
      // on vient. Le site encapsule donc cette URL dans son propre proxy HLS -- parce
      // qu'un NAVIGATEUR ne peut ni forger un Origin ni echapper au CORS. Nous, si: on
      // pose ces en-tetes directement et on economise le rebond.
      const cdnOrigin = config.AETHER_LINK_ORIGIN.replace(/\/+$/, '');
      return {
        url: data.stream,
        headers: {
          accept: '*/*',
          'accept-language': kit.ACCEPT_LANGUAGE,
          origin: cdnOrigin,
          referer: `${cdnOrigin}/`,
          'user-agent': kit.BROWSER_UA,
          ...kit.chromeHints(),
        },
      };
    },
  },
};

function selectedServers() {
  return config.AETHER_SERVERS.map((name) => [name.toLowerCase(), SERVERS[name.toLowerCase()]]).filter(
    ([name, server]) => {
      if (!server) console.warn(`[aether] serveur inconnu ignore: "${name}"`);
      return !!server;
    },
  );
}

async function getStreams({ tmdbId, type }) {
  if (type !== 'movie') return [];

  const { slug } = await kit.titleOf(type, tmdbId).catch(() => ({ slug: 'movie' }));
  const refererUrl = mediaPageUrl(tmdbId, slug);
  const http = kit.createHttp({ timeout: API_TIMEOUT_MS });

  const servers = selectedServers();
  const settled = await Promise.allSettled(
    servers.map(([, server]) => server.resolve({ http, tmdbId, refererUrl })),
  );

  const results = [];
  settled.forEach((outcome, index) => {
    const [, server] = servers[index];
    if (outcome.status === 'rejected') {
      log.ok('Aether', tmdbId, `${server.label}: echec (${outcome.reason?.message || outcome.reason})`);
      return;
    }
    if (!outcome.value) {
      log.ok('Aether', tmdbId, `${server.label}: aucun flux`);
      return;
    }

    // Un resolveur rend soit une URL seule (en-tetes communs), soit {url, headers} quand
    // SON CDN en attend d'autres -- c'est le cas de "link", dont le flux vient d'un tiers
    // et n'a rien a faire des en-tetes d'aether.bar.
    const resolved = typeof outcome.value === 'string' ? { url: outcome.value } : outcome.value;

    results.push({
      url: kit.proxied(resolved.url, {
        headers: resolved.headers || playbackHeaders(refererUrl),
        rules: PROXY_SPEC_RULES,
      }),
      direct: true,
      sourceName: `Aether · ${server.label}`,
      lang: config.AETHER_LANG || undefined,
    });
  });

  log.ok('Aether', tmdbId, `${results.length}/${servers.length} serveur(s) ont rendu un flux`);
  return results;
}

module.exports = {
  id: 'aether',
  name: 'Aether',
  supports: { movie: true, series: false },
  available: () => selectedServers().length > 0,
  getStreams,
  // Reglages effectifs, exposes par /debug/addons: un .env qui traine peut contredire un
  // defaut change depuis, et rien ne le montrait.
  settings: () => ({
    serveurs: config.AETHER_SERVERS,
    origineCdnLink: config.AETHER_LINK_ORIGIN,
    langue: config.AETHER_LANG,
  }),
};
