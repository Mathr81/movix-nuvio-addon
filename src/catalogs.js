const fs = require('fs');
const path = require('path');
const config = require('./config');
const { genreNames } = require('./genres');

/**
 * Definition des rangees du catalogue.
 *
 * Trois niveaux, du plus simple au plus libre:
 *  1. `CATALOGS` dans .env choisit les rangees integrees et leur ORDRE d'affichage;
 *  2. `catalogs.json` (a cote du .env) permet de les renommer, d'en retirer, ou d'en
 *     ajouter de nouvelles adossees a TMDB Discover -- sans toucher au code;
 *  3. tout ce qui n'est pas declare n'apparait pas.
 *
 * L'ordre du tableau est celui que Stremio/Nuvio respectent dans l'interface.
 */
const CONFIG_FILE = config.CATALOGS_FILE || path.join(__dirname, '..', 'catalogs.json');

// Rangees integrees. `personal` = necessite le sync compte Movix, `trakt` = necessite
// une connexion Trakt active.
const BUILTIN = {
  continue: { name: 'Movix · Reprendre', requires: 'personal' },
  watchlist: { name: 'Movix · Ma liste', requires: 'personal' },
  favorites: { name: 'Movix · Favoris', requires: 'personal' },
  reco: { name: 'Movix · Parce que tu as regardé', requires: 'personal' },
  'trakt-reco': { name: 'Movix · Recommandé pour vous', requires: 'trakt' },
  trending: { name: 'Movix · Tendances' },
  popular: { name: 'Movix · Populaires', search: true, genres: true },
  toprated: { name: 'Movix · Les mieux notés', genres: true },
  new: { name: { movie: 'Movix · Au cinéma', series: 'Movix · En cours de diffusion' } },
};

const DEFAULT_ORDER = ['continue', 'watchlist', 'favorites', 'reco', 'trakt-reco', 'trending', 'popular', 'toprated', 'new'];

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
 * Chaque entree: {id, name, types[], builtin?, discover?, search?, genres?}
 */
function definitions() {
  const custom = loadFile();
  if (custom) {
    return custom
      .filter((row) => row && row.id && !row.disabled)
      .map((row) => ({
        id: row.id,
        name: row.name,
        types: Array.isArray(row.types) && row.types.length > 0 ? row.types : ['movie', 'series'],
        builtin: BUILTIN[row.id] ? row.id : undefined,
        // Une rangee personnalisee est un jeu de parametres TMDB Discover: n'importe
        // quel filtre supporte par l'API (with_genres, with_original_language,
        // primary_release_date.gte, sort_by, ...) est transmis tel quel.
        discover: row.discover,
        search: row.search,
        genres: row.genres,
      }))
      .filter((row) => row.builtin || row.discover);
  }

  const order = config.CATALOGS || DEFAULT_ORDER;
  return order
    .filter((id) => BUILTIN[id])
    .map((id) => ({ id, types: ['movie', 'series'], builtin: id, search: BUILTIN[id].search, genres: BUILTIN[id].genres }));
}

function nameFor(def, type) {
  const fromFile = def.name;
  if (typeof fromFile === 'string') return fromFile;
  if (fromFile && typeof fromFile === 'object' && fromFile[type]) return fromFile[type];

  const builtin = BUILTIN[def.builtin]?.name;
  if (typeof builtin === 'string') return builtin;
  if (builtin && builtin[type]) return builtin[type];
  return def.id;
}

/** Rangees exposees dans le manifest, filtrees selon ce qui est reellement configure. */
function manifestCatalogs({ personalEnabled, traktEnabled }) {
  const out = [];
  for (const def of definitions()) {
    const requires = BUILTIN[def.builtin]?.requires;
    if (requires === 'personal' && !personalEnabled) continue;
    if (requires === 'trakt' && !traktEnabled) continue;

    for (const type of def.types) {
      if (type !== 'movie' && type !== 'series') continue;
      const extra = [{ name: 'skip' }];
      if (def.search) extra.unshift({ name: 'search' });
      if (def.genres) extra.push({ name: 'genre', options: genreNames(type), isRequired: false });
      out.push({ type, id: `movix-${def.id}`, name: nameFor(def, type), extra });
    }
  }
  return out;
}

/** Retrouve la definition derriere un id de catalogue recu dans une requete. */
function find(catalogId) {
  const id = catalogId.replace(/^movix-/, '');
  return definitions().find((def) => def.id === id) || null;
}

module.exports = { manifestCatalogs, find, BUILTIN, DEFAULT_ORDER, CONFIG_FILE };
