const crypto = require('crypto');
const config = require('../core/config');
const cache = require('../core/cache');
const tmdbClient = require('../integrations/tmdb');
const ids = require('../integrations/contentIds');
const catalogs = require('./catalogs');
const requestContext = require('../core/requestContext');
const { discoverFor, resolveDates } = require('./rows');
const { personalRecommendations, excluded, genreAffinity } = require('./recommend');

/**
 * Moteur des rangees de l'accueil: aucun titre en double, un ordre propre au profil, et
 * une pagination sans fin.
 *
 * Le probleme d'origine: chaque rangee interrogeait TMDB pour son compte, et les memes
 * gros succes trustaient le haut de "Tendances", "Populaires", "Les mieux notes"... On
 * voyait dix fois le meme film. Le client demande pourtant les rangees en parallele et
 * sans contexte: le dedoublonnage ne peut donc se faire que cote serveur, sur une
 * "mise en page" commune a toutes les rangees d'un type.
 *
 * Construction (une fois par type, puis toutes les CATALOG_REFRESH_MS):
 *  1. le profil: ce qui est deja vu/en cours/en liste est ecarte, et les genres regardes
 *     recemment font remonter les titres qui leur ressemblent;
 *  2. chaque rangee tire un "vivier" de ses premieres pages TMDB, classe par
 *     rang d'origine x affinite x tirage du jour (meme melange toute la journee, un autre
 *     le lendemain);
 *  3. les rangees se servent DANS L'ORDRE D'AFFICHAGE: un titre appartient a la premiere
 *     qui le montre, les suivantes piochent plus loin dans leur vivier.
 *
 * Au-dela de la premiere page, une rangee continue de puiser dans sa source TMDB (500
 * pages au plus) en sautant tout ce qui a deja ete montre ailleurs.
 */
const PAGE_SIZE = 20;
const DEFAULT_POOL_PAGES = 3;
const MAX_TMDB_PAGE = 500;
// Pages sources tentees au plus pour completer UNE page de rangee, si tout est deja pris.
const MAX_FETCH_PER_PAGE = 5;
// Une construction partiellement en echec (TMDB en 429...) est retentee bien plus tot.
const RETRY_FAILED_MS = 5 * 60 * 1000;
// Poids des gouts dans le classement: un titre du genre favori passe jusqu'a 2x plus haut.
const AFFINITY_WEIGHT = 1;

const layouts = new Map();

/** Tirage pseudo-aleatoire stable dans [0, 1) pour une graine donnee. */
function seeded(seed) {
  return crypto.createHash('md5').update(seed).digest().readUInt32BE(0) / 2 ** 32;
}

function affinityOf(item, affinity) {
  const genres = item.genre_ids || [];
  if (genres.length === 0 || affinity.size === 0) return 0;
  return genres.reduce((sum, genre) => sum + (affinity.get(genre) || 0), 0) / genres.length;
}

/** Classe des titres TMDB (dans leur ordre d'origine) selon la rangee et le profil. */
function rank(items, row, ctx, { rotate = row.rotate !== false } = {}) {
  return items
    .map((item, index) => {
      const draw = rotate ? 0.6 + 0.8 * seeded(`${ctx.day}:${row.id}:${item.id}`) : 1;
      const boost = 1 + AFFINITY_WEIGHT * affinityOf(item, ctx.affinity);
      return { item, score: ((index + 1) * draw) / boost };
    })
    .sort((a, b) => a.score - b.score)
    .map((entry) => entry.item);
}

/**
 * Un titre montrable: deja sorti (TMDB classe tres haut des films annonces pour dans
 * six mois, introuvables sur les sources), avec affiche et synopsis (sans eux, c'est
 * presque toujours un titre confidentiel), rien d'adulte, et pas deja vu ni en liste.
 */
function eligible(item, ctx) {
  const date = item?.release_date || item?.first_air_date;
  return (
    item?.id &&
    item.poster_path &&
    item.overview &&
    !item.adult &&
    date &&
    date <= ctx.today &&
    !ctx.seen.has(Number(item.id))
  );
}

// Talk-shows, journaux, telerealite et feuilletons quotidiens: tres "populaires" pour
// TMDB (des milliers d'episodes), hors sujet sur un accueil de streaming.
const SERIES_NOISE_GENRES = '10763,10764,10766,10767';

/** Une page brute de la source d'une rangee (memoisee: les rangees partagent TMDB). */
function sourcePage(row, type, page) {
  if (row.source === 'reco') return page === 1 ? personalRecommendations(type) : Promise.resolve([]);
  if (row.source === 'trending') {
    return cache.wrap(`tmdb:trending:${type}:${page}`, config.CACHE_TTL_MS, config.CACHE_EMPTY_TTL_MS, () =>
      tmdbClient.trending(type, page),
    );
  }
  const params = discoverFor(row, type);
  if (!params) return Promise.resolve([]);
  const resolved = resolveDates(
    type === 'series' && !params.without_genres ? { without_genres: SERIES_NOISE_GENRES, ...params } : params,
  );
  return cache.wrap(
    `tmdb:discover:${type}:${JSON.stringify(resolved)}:${page}`,
    config.CACHE_TTL_MS,
    config.CACHE_EMPTY_TTL_MS,
    () => tmdbClient.discoverWith(type, resolved, page),
  );
}

/** Vivier initial d'une rangee: ses premieres pages, filtrees et classees. */
async function firstPool(row, type, ctx) {
  const pages = row.source === 'reco' ? 1 : row.poolPages || DEFAULT_POOL_PAGES;
  const raw = (await Promise.all(Array.from({ length: pages }, (_, i) => sourcePage(row, type, i + 1)))).flat();
  const unique = [...new Map(raw.filter((item) => eligible(item, ctx)).map((item) => [item.id, item])).values()];
  return { items: rank(unique, row, ctx), pages };
}

const normalize = (text) =>
  String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();

/** Titre normalise: deux fiches TMDB du meme nom (remake, reboot) comptent pour une. */
const titleKey = (item) => `t:${normalize(item.title || item.name)}`;

/**
 * Cle de saga: le titre avant ses ":" / "," / "(", reduit a deux mots sans article.
 * "Harry Potter a l'ecole des sorciers" et "... et la Chambre des secrets" -> "harry
 * potter"; "Le Parrain, 2e partie" -> "parrain"; "Avengers : Endgame" -> "avengers".
 */
function sagaKey(item) {
  const head = normalize(item.title || item.name).split(/[:,(\u2013\u2014]/)[0];
  const words = head.replace(/^(le|la|les|l'|the|a|an)\s*/, '').split(/\s+/).filter(Boolean);
  return words.slice(0, 2).join(' ');
}

/**
 * Deplace du vivier vers la rangee ce qui n'a encore ete montre nulle part. Une saga
 * n'apparait qu'une fois par rangee: quatre Harry Potter d'affilee ne font pas une
 * rangee, et les suivants restent libres pour une autre.
 */
function take(feed, claimed, count) {
  while (feed.items.length < count && feed.backlog.length > 0) {
    const item = feed.backlog.shift();
    const title = titleKey(item);
    const saga = sagaKey(item);
    if (claimed.has(item.id) || claimed.has(title) || (saga && feed.sagas.has(saga))) continue;
    claimed.add(item.id);
    claimed.add(title);
    if (saga) feed.sagas.add(saga);
    feed.items.push(item);
  }
}

/** `fn` sur chaque element, `limit` a la fois, dans l'ordre. */
async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const index = next++;
      out[index] = await fn(list[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
  return out;
}

async function profile(type) {
  const [seen, affinity] = await Promise.all([
    excluded(type).catch(() => new Set()),
    genreAffinity(type).catch(() => new Map()),
  ]);
  const today = new Date().toISOString().slice(0, 10);
  return { seen, affinity, day: today, today };
}

// L'accueil des proches est neutre: ni les gouts ni les vus du proprietaire, ni sa
// rangee de recommandations. Une seule mise en page pour tous les proches.
const NEUTRAL_PROFILE = { seen: new Set(), affinity: new Map() };

async function build(type, neutral) {
  const started = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  const ctx = neutral ? { ...NEUTRAL_PROFILE, day: today, today } : await profile(type);
  const rows = catalogs.feedRows(type).filter((row) => !(neutral && catalogs.isPersonal(row)));

  let failed = 0;
  const pools = await mapLimit(rows, 6, (row) =>
    firstPool(row, type, ctx).catch((err) => {
      failed += 1;
      console.warn(`[catalog] rangee ${type}/${row.id}: ${err.response?.status ?? ''} ${err.message}`);
      return { items: [], pages: 0 };
    }),
  );

  const claimed = new Set();
  const feeds = new Map();
  rows.forEach((row, index) => {
    const feed = {
      row,
      type,
      ctx,
      items: [],
      backlog: pools[index].items,
      sagas: new Set(),
      srcPage: pools[index].pages,
      exhausted: row.source === 'reco',
      pending: Promise.resolve(),
    };
    take(feed, claimed, PAGE_SIZE);
    feeds.set(row.id, feed);
  });

  console.log(
    `[catalog] accueil ${type}${neutral ? ' (proches)' : ''}: ${rows.length} rangees, ${[...feeds.values()].reduce((n, f) => n + f.items.length, 0)} titres distincts, ` +
      `${ctx.seen.size} deja vus ecartes, ${ctx.affinity.size} genres au profil (${Date.now() - started} ms)` +
      (failed ? `, ${failed} rangee(s) en echec` : ''),
  );
  warmIds(type, [...feeds.values()].flatMap((feed) => feed.items));
  return { feeds, claimed, failed };
}

/**
 * En mode ID_FORMAT=imdb, chaque titre servi coute une resolution TMDB -> IMDb. Les
 * premieres pages de toutes les rangees sont resolues d'avance, en arriere-plan, pour
 * que l'accueil ne les attende pas une par une.
 */
function warmIds(type, items) {
  mapLimit(items, 8, (item) => ids.contentIdFor(type, item.id)).catch(() => {});
}

const layoutKey = (type, neutral) => (neutral ? `proches:${type}` : type);

/** Lance une construction; elle ne remplace la mise en page en service qu'une fois prete. */
function startBuild(type, neutral) {
  const entry = { expiresAt: Infinity, next: null, promise: null };
  entry.promise = build(type, neutral).then((result) => {
    entry.expiresAt = Date.now() + (result.failed ? RETRY_FAILED_MS : config.CATALOG_REFRESH_MS);
    layouts.set(layoutKey(type, neutral), entry);
    return result;
  });
  return entry;
}

/**
 * Mise en page d'un type. Perimee, elle reste servie pendant que la suivante se
 * construit (plusieurs secondes): l'accueil ne la fait jamais attendre, sauf la toute
 * premiere fois -- et `warm` la lance des le demarrage.
 */
function layout(type, neutral = false) {
  const key = layoutKey(type, neutral);
  const current = layouts.get(key);
  if (!current) {
    const entry = startBuild(type, neutral);
    layouts.set(key, entry);
    entry.promise.catch(() => layouts.delete(key));
    return entry.promise;
  }
  if (Date.now() >= current.expiresAt && !current.next) {
    current.next = startBuild(type, neutral);
    current.next.promise.catch((err) => {
      console.warn(`[catalog] reconstruction ${type} en echec: ${err.message}`);
      current.next = null;
      current.expiresAt = Date.now() + RETRY_FAILED_MS;
    });
  }
  return current.promise;
}

/** Construit les deux accueils d'avance (au demarrage). */
function warm() {
  for (const type of ['movie', 'series']) layout(type).catch(() => {});
}

/** Complete une rangee jusqu'a `need` titres, en puisant plus loin dans sa source. */
async function extend(feed, claimed, need) {
  // Budget de pages sources: de quoi combler l'ecart demande, plus une marge pour les
  // pages dont tout a deja ete montre ailleurs.
  const budget = MAX_FETCH_PER_PAGE + 2 * Math.ceil((need - feed.items.length) / PAGE_SIZE);
  let fetched = 0;
  while (feed.items.length < need) {
    take(feed, claimed, need);
    if (feed.items.length >= need || feed.exhausted) return;
    if (feed.srcPage >= MAX_TMDB_PAGE) {
      feed.exhausted = true;
      return;
    }
    if (fetched++ >= budget) return;

    feed.srcPage += 1;
    const raw = await sourcePage(feed.row, feed.type, feed.srcPage).catch(() => null);
    if (raw === null) return; // panne passagere: on retentera au prochain defilement
    if (raw.length === 0) {
      feed.exhausted = true;
      return;
    }
    // Plus de tirage du jour au-dela du vivier: la profondeur suit l'ordre de la source.
    feed.backlog.push(...rank(raw.filter((item) => eligible(item, feed.ctx)), feed.row, feed.ctx, { rotate: false }));
  }
}

/** Page `page` (1-based) d'une rangee: titres TMDB bruts, dans l'ordre. */
async function rowPage(type, rowId, page) {
  const { feeds, claimed } = await layout(type, !!requestContext.guest());
  const feed = feeds.get(rowId);
  if (!feed) return [];

  // Une seule extension a la fois par rangee: deux pages demandees ensemble ne doivent
  // pas puiser deux fois dans la meme page source.
  feed.pending = feed.pending.then(() => extend(feed, claimed, page * PAGE_SIZE)).catch(() => {});
  await feed.pending;
  return feed.items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
}

/** Oublie les mises en page (apres un changement de profil, ou pour les tests). */
function reset() {
  layouts.clear();
}

module.exports = { rowPage, warm, reset, PAGE_SIZE, _internals: { rank, take, seeded, sagaKey } };
