const movixSync = require('./movixSync');
const tmdbClient = require('./tmdb');

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
const MAX_SEEDS = 12;

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

async function personalRecommendations(type, { limit = 60 } = {}) {
  const seedIds = await seeds(type);
  if (seedIds.length === 0) return [];

  const results = await Promise.allSettled(seedIds.map((id) => tmdbClient.recommendations(type, id)));
  const skip = await excluded(type);

  const scored = new Map();
  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    // Seules les premieres suggestions de chaque graine sont retenues: au-dela, TMDB
    // part vers des titres nettement moins proches et le classement se dilue.
    for (const item of result.value.slice(0, 12)) {
      if (!item?.id || skip.has(Number(item.id))) continue;
      const current = scored.get(item.id);
      if (current) current.score += 1;
      else scored.set(item.id, { item, score: 1 });
    }
  }

  return [...scored.values()]
    .sort((a, b) => b.score - a.score || (b.item.popularity || 0) - (a.item.popularity || 0))
    .slice(0, limit)
    .map((entry) => entry.item);
}

module.exports = { personalRecommendations };
