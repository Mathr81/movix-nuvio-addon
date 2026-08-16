const config = require('../core/config');
const { libKey, watchedKey, progressKey } = require('./model');

/**
 * Comparaison des modeles: ce qui a bouge, ce qui a disparu, et ce qu'il est prudent de
 * propager. Aucune de ces fonctions n'ecrit -- elles ne font que decider.
 */

/** Ce qui est apparu (ou a bouge) dans `model` depuis l'instantane `previous`. */
function changesSince(model, previous) {
  const prevLibrary = new Set(previous?.library || []);
  const prevWatched = new Set(previous?.watched || []);
  const prevProgress = previous?.progress || {};

  return {
    library: [...model.library].filter(([k]) => !prevLibrary.has(k)).map(([, v]) => v),
    watched: [...model.watched].filter(([k]) => !prevWatched.has(k)).map(([, v]) => v),
    progress: [...model.progress]
      .filter(([k, v]) => Math.round(v.position) !== prevProgress[k])
      .map(([, v]) => v),
  };
}

/** Retire d'un delta ce que la cible possede deja a l'identique. */
function notYetIn(delta, target) {
  return {
    library: delta.library.filter((e) => !target.library.has(libKey(e.type, e.id))),
    watched: delta.watched.filter((e) => !target.watched.has(watchedKey(e.type, e.id, e.season, e.episode))),
    progress: delta.progress.filter((e) => {
      const existing = target.progress.get(progressKey(e.type, e.id, e.season, e.episode));
      // Conflit reel (les deux cotes ont bouge): la position la plus avancee gagne.
      // A defaut d'horodatage fiable cote Movix, c'est la regle qui perd le moins.
      return !existing || Math.round(existing.position) < Math.round(e.position);
    }),
  };
}

const deltaSize = (d) => d.library.length + d.watched.length + d.progress.length;

/**
 * Ce qui a DISPARU d'une source depuis l'instantane precedent.
 *
 * Sans cette detection, retirer un titre de sa watchlist ne sert a rien: le tour suivant
 * le voit encore chez les deux autres et le reajoute. Une suppression doit donc voyager
 * comme un ajout.
 *
 * Les cles suffisent (le contenu supprime n'existe plus nulle part), d'ou la relecture
 * depuis l'instantane plutot que depuis un modele.
 */
function removalsSince(model, previous) {
  if (!previous) return { library: [], watched: [], progress: [] }; // premier tour: rien n'a disparu

  const gone = (keys, present) => (keys || []).filter((k) => !present.has(k));
  return {
    library: gone(previous.library, model.library),
    watched: gone(previous.watched, model.watched),
    progress: gone(Object.keys(previous.progress || {}), model.progress),
  };
}

/**
 * Coupe-circuit sur les suppressions.
 *
 * Une suppression detectee n'est qu'une absence: elle ne distingue pas "l'utilisateur a
 * retire ce titre" de "la lecture de cette source a echoue ou repondu partiellement".
 * Confondre les deux propagerait un effacement massif chez les deux autres systemes --
 * la seule faute vraiment irrattrapable de tout le hub.
 *
 * Deux garde-fous: une source qui parait entierement vide alors qu'elle ne l'etait pas
 * est tenue pour muette, et un volume anormal de disparitions en un seul cycle est
 * refuse. Dans les deux cas on ne perd rien: un vrai retrait se represente au tour
 * suivant, ou dans un cycle ou il sera minoritaire.
 */
function guardRemovals(source, removals, model, previous) {
  const count = removals.library.length + removals.watched.length + removals.progress.length;
  if (count === 0) return removals;

  const previousSize = (previous?.library?.length || 0) + (previous?.watched?.length || 0);
  const currentSize = model.library.size + model.watched.size;
  if (previousSize > 0 && currentSize === 0) {
    console.warn(`[hub] ${source} parait vide alors qu'il contenait ${previousSize} entree(s): suppressions ignorees`);
    return { library: [], watched: [], progress: [] };
  }

  if (count > config.HUB_MAX_REMOVALS_PER_CYCLE) {
    console.warn(
      `[hub] ${count} disparitions detectees dans ${source} en un cycle (plafond ${config.HUB_MAX_REMOVALS_PER_CYCLE}): ` +
        'suppressions ignorees. Releve HUB_MAX_REMOVALS_PER_CYCLE si le menage est volontaire.',
    );
    return { library: [], watched: [], progress: [] };
  }

  return removals;
}

/**
 * Une suppression ne l'emporte que si personne n'a (re)ajoute l'element ailleurs pendant
 * le meme cycle. Sinon on effacerait un ajout tout frais, ce qui est la faute la plus
 * couteuse a rattraper -- alors qu'une suppression ignoree revient au tour suivant.
 */
function withoutContested(removals, additions) {
  const added = new Set([
    ...additions.library.map((e) => libKey(e.type, e.id)),
    ...additions.watched.map((e) => watchedKey(e.type, e.id, e.season, e.episode)),
    ...additions.progress.map((e) => progressKey(e.type, e.id, e.season, e.episode)),
  ]);
  const keep = (keys) => keys.filter((k) => !added.has(k));
  return { library: keep(removals.library), watched: keep(removals.watched), progress: keep(removals.progress) };
}

/**
 * Etat des elements sur le point d'etre supprimes, releve dans la source AVANT l'ecriture.
 * C'est ce qui rend une restauration possible: sans lui, le journal ne conserverait
 * qu'une cle, et remettre le titre exigerait de retrouver ses metadonnees et sa position.
 */
function valuesFor(model, removals) {
  const before = {};
  for (const kind of ['library', 'watched', 'progress']) {
    for (const key of removals[kind] || []) {
      const item = model[kind].get(key);
      if (item) before[key] = item;
    }
  }
  return before;
}

function mergeRemovals(a, b) {
  return {
    library: [...new Set([...a.library, ...b.library])],
    watched: [...new Set([...a.watched, ...b.watched])],
    progress: [...new Set([...a.progress, ...b.progress])],
  };
}

/** Fusion de deux deltas, dedupliquee par cle canonique. */
function union(a, b) {
  const dedupe = (items, keyOf) => {
    const map = new Map();
    for (const item of [...items]) map.set(keyOf(item), item);
    return [...map.values()];
  };
  return {
    library: dedupe([...a.library, ...b.library], (e) => libKey(e.type, e.id)),
    watched: dedupe([...a.watched, ...b.watched], (e) => watchedKey(e.type, e.id, e.season, e.episode)),
    progress: dedupe([...a.progress, ...b.progress], (e) => progressKey(e.type, e.id, e.season, e.episode)),
  };
}

module.exports = {
  changesSince,
  notYetIn,
  deltaSize,
  removalsSince,
  guardRemovals,
  withoutContested,
  valuesFor,
  mergeRemovals,
  union,
};
