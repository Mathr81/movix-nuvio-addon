const path = require('path');

/**
 * Chemins du depot, ancres a la RACINE et non au fichier appelant.
 *
 * Ces emplacements etaient auparavant calcules dans chaque module avec
 * `path.join(__dirname, '..', ...)`, ce qui les rendait dependants de la profondeur du
 * fichier: deplacer `cache.js` de `src/` vers `src/core/` suffisait a faire glisser le
 * cache de `data/` vers `src/data/`, et les jetons Trakt/Simkl a la racine de `src/`.
 * Silencieux, et vecu comme "mes jetons ont disparu, il faut se reconnecter".
 *
 * Un seul module connait donc la racine; tout le reste demande un chemin par son nom.
 */
const ROOT = path.join(__dirname, '..', '..');
const DATA_DIR = path.join(ROOT, 'data');

module.exports = {
  ROOT,
  DATA_DIR,
  /** Etat/cache regeneres automatiquement: tout ce qui vit dans `data/`. */
  inData: (...segments) => path.join(DATA_DIR, ...segments),
  /** Jetons d'authentification, historiquement a la racine du depot. */
  inRoot: (...segments) => path.join(ROOT, ...segments),
};
