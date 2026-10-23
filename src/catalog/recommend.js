const config = require('../core/config');
const cache = require('../core/cache');
const movixSync = require('../integrations/movixSync');
const tmdbClient = require('../integrations/tmdb');

/**
 * Recommandations calculees localement a partir de l'historique Movix.
 *
 * Interet par rapport a Trakt/Simkl: aucun compte tiers, aucune limite d'apps, et ca
 * marche des maintenant avec les donnees deja synchronisees. La contrepartie est que la
 * source reste l'historique du SITE: si tu bascules entierement sur Nuvio, il se fige --
 * c'est la que les trackers (Simkl notamment) prennent le relais.
 *
 * Methode: on prend les titres les plus recemment regardes comme graines, on demande a
 * TMDB les titres proches de chacune, et on classe par nombre de graines qui les
 * recommandent -- un titre suggere par trois films que tu as vus passe devant un titre
 * suggere par un seul.
 */
const MAX_SEEDS = 20;
// Titres les plus recents pris en compte pour le profil de genres.
const MAX_TASTE_TITLES = 40;

async function seeds(type) {
  const [continueWatching, watched] = await Promise.all([
    movixSync.getContinueWatching(type),
    movixSync.getWatched(type),
  ]);

  // "Reprendre" est deja trie du plus recent au plus ancien: ce sont les gouts actuels,
  // ils passent avant le reste de l'historique.
  const ordered = [...continueWatching, ...watched];
  const ids = [];
  const seen = new Set();
  for (const item of ordered) {
    const id = Number(item?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= MAX_SEEDS) break;
  }
  return ids;
}

/** Tout ce qui est deja vu, en cours, en liste ou en favori n'a rien a faire dans une reco. */
async function excluded(type) {
  const [watched, continueWatching, watchlist, favorites] = await Promise.all([
    movixSync.getWatched(type),
    movixSync.getContinueWatching(type),
    movixSync.getCollection('watchlist', type),
    movixSync.getCollection('favorites', type),
  ]);
  return new Set(
    [...watched, ...continueWatching, ...watchlist, ...favorites].map((item) => Number(item?.id)).filter(Boolean),
  );
}

async function personalRecommendations(type, { limit = 200 } = {}) {
  const seedIds = await seeds(type);
  if (seedIds.length === 0) return [];

  const results = await Promise.allSettled(seedIds.map((id) => tmdbClient.recommendations(type, id)));
  const skip = await excluded(type);

  const scored = new Map();
  const perSeed = [];
  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    // Seules les premieres suggestions de chaque graine sont retenues: au-dela, TMDB
    // part vers des titres nettement moins proches et le classement se dilue.
    const kept = result.value.slice(0, 20).filter((item) => item?.id && !skip.has(Number(item.id)));
    for (const item of kept) {
      const current = scored.get(item.id);
      if (current) current.score += 1;
      else scored.set(item.id, { item, score: 1 });
    }
    perSeed.push(kept.map((item) => item.id));
  }

  // Tour de role entre les graines, la plus recente d'abord, chacune donnant sa meilleure
  // suggestion pas encore prise. Un simple tri par score laissait la saga la plus vue
  // (dix films Marvel = dix graines d'accord entre elles) occuper toute la rangee.
  const byScore = (a, b) => scored.get(b).score - scored.get(a).score || (scored.get(b).item.popularity || 0) - (scored.get(a).item.popularity || 0);
  const queues = perSeed.map((list) => [...list].sort(byScore));
  const out = [];
  const taken = new Set();
  while (out.length < limit && queues.some((queue) => queue.length > 0)) {
    for (const queue of queues) {
      while (queue.length > 0 && taken.has(queue[0])) queue.shift();
      if (queue.length === 0) continue;
      const id = queue.shift();
      taken.add(id);
      out.push(scored.get(id).item);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/**
 * Gouts du profil: poids de chaque genre TMDB dans [0, 1], d'apres les titres vus,
 * en cours et favoris -- les plus recents comptent davantage. Sert a classer les
 * rangees thematiques (cf. feed.js), pas a les filtrer: un genre jamais regarde reste
 * visible, il passe simplement apres.
 */
async function genreAffinity(type) {
  const [continueWatching, favorites, watched] = await Promise.all([
    movixSync.getContinueWatching(type),
    movixSync.getCollection('favorites', type),
    movixSync.getWatched(type),
  ]);
  const ids = [...new Set([...continueWatching, ...favorites, ...watched].map((item) => Number(item?.id)).filter(Boolean))]
    .slice(0, MAX_TASTE_TITLES);

  // Meme cle que la fiche (addon.js): un titre deja ouvert ne coute rien.
  const details = await Promise.all(
    ids.map((id) =>
      cache
        .wrap(`meta:${type}:${id}`, config.CACHE_TTL_MS, config.CACHE_EMPTY_TTL_MS, () => tmdbClient.details(type, id))
        .catch(() => null),
    ),
  );

  const weights = new Map();
  details.forEach((d, index) => {
    const recency = 1 / (1 + index / 10);
    for (const genre of d?.genres || []) weights.set(genre.id, (weights.get(genre.id) || 0) + recency);
  });
  const max = Math.max(0, ...weights.values());
  for (const [genre, weight] of weights) weights.set(genre, weight / max);
  return weights;
}

module.exports = { personalRecommendations, excluded, genreAffinity };
