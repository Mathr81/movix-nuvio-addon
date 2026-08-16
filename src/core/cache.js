// Cache TTL en memoire. Les scrapers Movix sont lents (Wiflix peut repondre 202 pendant
// plusieurs secondes) et Stremio/Nuvio rappelle /stream a chaque ouverture de fiche --
// sans cache, chaque aller-retour repaye le prix complet du scraping.
//
// Il SURVIT au redemarrage: un `npm start` repartait de zero, et la premiere ouverture de
// chaque fiche repayait tout (scraping, extraction, mesure de debit). Les entrees portent
// leur date d'expiration, celles qui l'ont depassee ne sont pas relues.

const fs = require('fs');
const path = require('path');
const config = require('./config');
const paths = require('./paths');

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
  dirty = true;
}

// Appels en cours, pour qu'une rafale de demandes simultanees sur la meme cle ne
// declenche qu'un seul appel reseau (sans ca, un push Nuvio refait 8 fois la meme
// requete de sync, toutes parties avant que la premiere ait rempli le cache).
const inFlight = new Map();

/** Memoise un appel async. Les resultats vides ont un TTL court (retry rapide). */
async function wrap(key, ttlMs, emptyTtlMs, fn) {
  const cached = get(key);
  if (cached !== undefined) return cached;

  const pending = inFlight.get(key);
  if (pending) return pending;

  const promise = (async () => {
    const value = await fn();
    const isEmpty = Array.isArray(value) ? value.length === 0 : !value;
    set(key, value, isEmpty ? emptyTtlMs : ttlMs);
    return value;
  })().finally(() => inFlight.delete(key));

  inFlight.set(key, promise);
  return promise;
}

// Purge periodique -- sans ca, une longue session accumule les entrees expirees.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (now > entry.expiresAt) store.delete(key);
  }
}, 10 * 60 * 1000).unref();

function del(key) {
  store.delete(key);
  dirty = true;
}

// --- Persistance sur disque -------------------------------------------------

let dirty = false;

function cacheFile() {
  return config.CACHE_FILE || paths.inData('cache.json');
}

/**
 * Ecriture ATOMIQUE: fichier temporaire puis rename. Une coupure au milieu d'un write
 * laisserait sinon un JSON tronque, et le cache serait perdu au demarrage suivant --
 * exactement ce qu'on cherche a eviter.
 *
 * Seules les entrees encore valides sont ecrites, et celles qui ne se serialisent pas sont
 * ignorees plutot que de faire echouer la sauvegarde entiere.
 */
function save() {
  if (!config.CACHE_PERSIST || !dirty) return;
  dirty = false;

  const now = Date.now();
  const entries = [];
  for (const [key, entry] of store) {
    if (entry.expiresAt <= now) continue;
    try {
      JSON.stringify(entry.value);
      entries.push([key, entry]);
    } catch {
      // Valeur non serialisable (rare): elle reste en memoire, simplement pas sur disque.
    }
  }

  const file = cacheFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ savedAt: now, entries }));
    fs.renameSync(`${file}.tmp`, file);
  } catch (err) {
    console.warn(`[cache] sauvegarde impossible (${file}): ${err.message}`);
  }
}

function load() {
  if (!config.CACHE_PERSIST) return;

  const file = cacheFile();
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    // Absent au premier demarrage, ou illisible: on repart d'un cache vide, sans bruit.
    if (err.code !== 'ENOENT') console.warn(`[cache] fichier ignore (${file}): ${err.message}`);
    return;
  }

  const now = Date.now();
  let kept = 0;
  for (const [key, entry] of parsed.entries || []) {
    if (!entry || entry.expiresAt <= now) continue;
    store.set(key, entry);
    kept += 1;
  }
  if (kept > 0) console.log(`[cache] ${kept} entree(s) reprises du disque`);
}

load();

if (config.CACHE_PERSIST) {
  setInterval(save, config.CACHE_SAVE_INTERVAL_MS).unref();
  // Un arret propre ne doit pas perdre les mesures de la session. `exit` ne tolere que du
  // synchrone, d'ou l'ecriture synchrone plus haut.
  process.on('exit', save);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      save();
      process.exit(0);
    });
  }
}

module.exports = { get, set, del, wrap, save };
