// Cache TTL en memoire. Les scrapers Movix sont lents (Wiflix peut repondre 202 pendant
// plusieurs secondes) et Stremio/Nuvio rappelle /stream a chaque ouverture de fiche --
// sans cache, chaque aller-retour repaye le prix complet du scraping.

const store = new Map();

function get(key) {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return undefined;
  }
  return entry.value;
}

function set(key, value, ttlMs) {
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
}

/** Memoise un appel async. Les resultats vides ont un TTL court (retry rapide). */
async function wrap(key, ttlMs, emptyTtlMs, fn) {
  const cached = get(key);
  if (cached !== undefined) return cached;

  const value = await fn();
  const isEmpty = Array.isArray(value) ? value.length === 0 : !value;
  set(key, value, isEmpty ? emptyTtlMs : ttlMs);
  return value;
}

// Purge periodique -- sans ca, une longue session accumule les entrees expirees.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (now > entry.expiresAt) store.delete(key);
  }
}, 10 * 60 * 1000).unref();

module.exports = { get, set, wrap };
