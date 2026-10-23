const fs = require('fs');
const config = require('../core/config');
const paths = require('../core/paths');
const { genreNames } = require('./genres');
const { ROWS, typesOf } = require('./rows');
const trakt = require('../integrations/traktCloud');

/**
 * Definition des rangees du catalogue.
 *
 * Trois niveaux, du plus simple au plus libre:
 *  1. `CATALOGS` dans .env choisit les rangees integrees (src/catalog/rows.js) et leur
 *     ORDRE d'affichage;
 *  2. `catalogs.json` (a cote du .env) permet de les renommer, d'en retirer, ou d'en
 *     ajouter de nouvelles adossees a TMDB Discover -- sans toucher au code;
 *  3. tout ce qui n'est pas declare n'apparait pas.
 *
 * L'ordre du tableau est celui que Stremio/Nuvio respectent dans l'interface, et celui
 * du dedoublonnage entre rangees (cf. rows.js).
 *
 * La rangee "Reprendre" n'existe pas: le hub synchronise les positions de lecture vers
 * Nuvio Sync et Simkl, qui affichent la reprise nativement et savent replacer le curseur,
 * ce que le protocole d'addon ne permet pas.
 */
const CONFIG_FILE = config.CATALOGS_FILE || paths.inRoot('catalogs.json');

// Etat lu au demarrage: apres un `npm run trakt:auth`, redemarre l'addon pour que la
// rangee de recommandations apparaisse (Stremio/Nuvio relisent alors le manifest).
const FLAGS = {
  personalEnabled: !!(config.MOVIX_JWT && config.MOVIX_USER_ID),
  traktEnabled: config.TRAKT_RECOMMENDATIONS && trakt.isAuthenticated(),
};

const BUILTIN = Object.fromEntries(ROWS.map((row) => [row.id, row]));
const DEFAULT_ORDER = ROWS.map((row) => row.id);

function loadFile() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : parsed.catalogs || [];
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[catalogs] ${CONFIG_FILE} illisible: ${err.message}`);
    return null;
  }
}

/**
 * Liste normalisee des rangees a exposer, avant filtrage par disponibilite.
 * Chaque entree reprend la rangee integree du meme id, surchargee par le fichier.
 */
function definitions() {
  const custom = loadFile();
  if (custom) {
    return custom
      .filter((row) => row && row.id && !row.disabled)
      .map((row) => {
        const base = BUILTIN[row.id] || {};
        // Une rangee personnalisee est un jeu de parametres TMDB Discover: n'importe
        // quel filtre supporte par l'API (with_genres, with_original_language,
        // primary_release_date.gte, sort_by, ...) est transmis tel quel.
        const def = { ...base, ...row, builtin: BUILTIN[row.id] ? row.id : undefined };
        const types = Array.isArray(row.types) && row.types.length > 0 ? row.types : typesOf(def);
        return { ...def, types };
      })
      .filter((row) => row.builtin || row.discover);
  }

  const order = config.CATALOGS || DEFAULT_ORDER;
  return order.filter((id) => BUILTIN[id]).map((id) => ({ ...BUILTIN[id], builtin: id, types: typesOf(BUILTIN[id]) }));
}

function nameFor(def, type) {
  if (typeof def.name === 'string') return def.name;
  if (def.name && typeof def.name === 'object' && def.name[type]) return def.name[type];
  return def.id;
}

/** Une rangee dont la source n'est pas configuree (compte Movix, Trakt) disparait. */
function available(def) {
  if (def.requires === 'personal') return FLAGS.personalEnabled;
  if (def.requires === 'reco') return FLAGS.personalEnabled && config.LOCAL_RECOMMENDATIONS;
  if (def.requires === 'trakt') return FLAGS.traktEnabled;
  return true;
}

/** Rangees exposees dans le manifest, filtrees selon ce qui est reellement configure. */
function manifestCatalogs() {
  const out = [];
  for (const def of definitions()) {
    if (!available(def)) continue;

    for (const type of def.types) {
      if (type !== 'movie' && type !== 'series') continue;
      const extra = [{ name: 'skip' }];
      if (def.search) extra.unshift({ name: 'search' });
      if (def.genres) extra.push({ name: 'genre', options: genreNames(type), isRequired: def.genres === 'required' });
      out.push({ type, id: `movix-${def.id}`, name: nameFor(def, type), extra });
    }
  }
  // Recherche a part: `isRequired` la tient hors de l'accueil, ou elle ferait doublon.
  for (const type of ['movie', 'series']) {
    out.push({ type, id: 'movix-search', name: 'Movix', extra: [{ name: 'search', isRequired: true }, { name: 'skip' }] });
  }
  return out;
}

/** Rangees d'un type passant par le moteur de dedoublonnage (tout sauf les listes perso). */
function feedRows(type) {
  return definitions().filter(
    (def) =>
      def.types.includes(type) &&
      available(def) &&
      !['watchlist', 'favorites', 'trakt'].includes(def.source) &&
      def.genres !== 'required',
  );
}

/** Retrouve la definition derriere un id de catalogue recu dans une requete. */
function find(catalogId) {
  const id = catalogId.replace(/^movix-/, '');
  return definitions().find((def) => def.id === id) || null;
}

module.exports = { manifestCatalogs, feedRows, find, BUILTIN, DEFAULT_ORDER, CONFIG_FILE };
