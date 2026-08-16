const config = require('../core/config');
const log = require('../core/log');
const kit = require('./kit');

/**
 * Obrigoz (obrigoz.com) -- source sans API d'identifiants: elle ne connait ni TMDB ni
 * IMDB, seulement des titres. La resolution se fait donc en trois temps:
 *
 *   1. TMDB donne le titre francais et l'annee du tmdbId demande;
 *   2. une recherche sur le site rend une grille de fiches -> on retient celle dont
 *      l'annee correspond (a defaut, la premiere: le moteur classe deja par pertinence);
 *   3. la page de la fiche contient un iframe, dont le HTML porte le bloc `sources: [...]`
 *      d'un JWPlayer -- c'est la qu'on lit les URLs et leurs libelles de qualite.
 *
 * Le CDN qui sert ces flux exige le Referer de la page iframe: on ne le devine pas, on le
 * derive de l'URL de l'iframe reellement rencontree, et le proxy le rejoue ensuite.
 *
 * Films uniquement: la grille de recherche du site est une grille de films
 * (`#search-film-grid`), sans notion de saison ni d'episode.
 */

const HTTP_TIMEOUT_MS = 8000;

function baseUrl() {
  return config.OBRIGOZ_BASE_URL.replace(/\/+$/, '');
}

function sitePath(suffix) {
  return `${baseUrl()}/${config.OBRIGOZ_PATH_PREFIX}/${suffix}`;
}

/**
 * Le moteur du site ne tolere pas les titres decores: il ne trouve "Spider-Man: No Way
 * Home" qu'en cherchant "Spider-Man". On retire donc les parentheses et tout ce qui suit
 * un deux-points ou un tiret separateur.
 */
function cleanTitle(rawTitle) {
  let title = String(rawTitle || '').replace(/\([^)]*\)/g, '');
  if (title.includes(':')) [title] = title.split(':');
  if (title.includes(' - ')) [title] = title.split(' - ');
  return title.trim();
}

function attribute(tag, name) {
  const match = new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag);
  return match ? match[1] : '';
}

function innerText(html, className) {
  const match = new RegExp(`class=["'][^"']*${className}[^"']*["'][^>]*>([^<]*)<`, 'i').exec(html);
  return match ? match[1].trim() : '';
}

/**
 * Extrait les fiches de la grille de resultats. Un `<a class="film-card">` ne contient
 * jamais d'autre lien, on peut donc decouper la grille sur les fermetures d'ancre.
 */
function parseSearchResults(html) {
  const grid = /id=["']search-film-grid["'][^>]*>([\s\S]*)/i.exec(html);
  const scope = grid ? grid[1] : html;

  const results = [];
  const cardRegex = /<a\b([^>]*class=["'][^"']*film-card[^"']*["'][^>]*)>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = cardRegex.exec(scope)) !== null) {
    const [, attrs, body] = match;
    const href = attribute(attrs, 'href');
    const id = /\/([^/]+)\/?$/.exec(href)?.[1];
    if (!id) continue;

    results.push({
      id,
      title: innerText(body, 'film-card-title') || 'Sans titre',
      year: innerText(body, 'trend-card-date'),
    });
  }
  return results;
}

/** Bloc `sources: [{file: "...", label: "1080p"}, ...]` d'un JWPlayer. */
function parseJwPlayerSources(html) {
  const block = /sources\s*:\s*\[([\s\S]*?)\]/.exec(html);
  if (!block) return [];

  return [...block[1].matchAll(/\{([\s\S]*?)\}/g)]
    .map((entry) => {
      const file = /file\s*:\s*["'](https?:\/\/[^"']+)["']/.exec(entry[1])?.[1];
      const label = /label\s*:\s*["']([^"']+)["']/.exec(entry[1])?.[1];
      return file ? { url: file, label } : null;
    })
    .filter(Boolean);
}

async function search(http, query) {
  const { data, status } = await http.post(
    sitePath('home/obrigoz'),
    new URLSearchParams({ searchword: query }).toString(),
    {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      validateStatus: () => true,
    },
  );
  if (status !== 200 || typeof data !== 'string') return [];
  return parseSearchResults(data);
}

async function extractSources(http, videoId) {
  const page = await http.get(sitePath(`b/obrigoz/${videoId}`), { validateStatus: () => true });
  if (page.status !== 200 || typeof page.data !== 'string') return [];

  const iframeUrl = /<iframe\s+[^>]*src=["']([^"']+)["']/i.exec(page.data)?.[1];
  if (!iframeUrl) return [];

  const absoluteIframeUrl = new URL(iframeUrl, baseUrl()).toString();
  const iframe = await http.get(absoluteIframeUrl, {
    headers: { Referer: `${baseUrl()}/` },
    validateStatus: () => true,
  });
  if (iframe.status !== 200 || typeof iframe.data !== 'string') return [];

  const sources = parseJwPlayerSources(iframe.data);
  // Le CDN veut le Referer du lecteur qui l'integre, pas le sien: on remonte l'origine de
  // l'iframe avec les sources pour que le proxy la rejoue telle quelle.
  return sources.map((source) => ({ ...source, playerOrigin: new URL(absoluteIframeUrl).origin }));
}

async function getStreams({ tmdbId, type }) {
  if (type !== 'movie') return [];

  const { title, year } = await kit.titleOf(type, tmdbId);
  const query = cleanTitle(title);
  if (!query) {
    log.ok('Obrigoz', tmdbId, 'pas de titre exploitable cote TMDB');
    return [];
  }

  const http = kit.createHttp({
    timeout: HTTP_TIMEOUT_MS,
    headers: { Referer: `${baseUrl()}/` },
  });

  const found = await search(http, query);
  if (found.length === 0) {
    log.ok('Obrigoz', tmdbId, `aucun resultat pour "${query}"`);
    return [];
  }

  // L'annee departage les remakes et les homonymes, que le titre seul confond.
  const selected = (year && found.find((item) => item.year === year)) || found[0];
  const sources = await extractSources(http, selected.id);
  if (sources.length === 0) {
    log.ok('Obrigoz', tmdbId, `"${selected.title}" (${selected.year}): aucune source dans l'iframe`);
    return [];
  }

  const results = sources.map((source) => ({
    url: kit.proxied(source.url, {
      headers: {
        accept: '*/*',
        'accept-language': kit.ACCEPT_LANGUAGE,
        origin: source.playerOrigin,
        referer: `${source.playerOrigin}/`,
        'user-agent': kit.BROWSER_UA,
      },
    }),
    direct: true,
    sourceName: 'Obrigoz',
    quality: source.label,
    lang: config.OBRIGOZ_LANG || undefined,
  }));

  log.ok(
    'Obrigoz',
    tmdbId,
    `${results.length} source(s) pour "${selected.title}" (${selected.year || 'annee inconnue'})` +
      `${year && selected.year !== year ? ` -- ATTENTION: annee TMDB ${year}, correspondance approximative` : ''}`,
  );
  return results;
}

module.exports = {
  id: 'obrigoz',
  name: 'Obrigoz',
  supports: { movie: true, series: false },
  available: () => !!config.OBRIGOZ_BASE_URL && !!config.OBRIGOZ_PATH_PREFIX,
  getStreams,
};
