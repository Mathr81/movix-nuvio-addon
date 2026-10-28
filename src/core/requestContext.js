const { AsyncLocalStorage } = require('node:async_hooks');

/**
 * Qui fait la requete d'addon en cours. Pose par le middleware des liens "proches"
 * (server.js) et suivi a travers les await: les handlers n'ont rien a se transmettre.
 * Hors de ce middleware (routes sans prefixe, taches de fond), c'est le proprietaire.
 */
const store = new AsyncLocalStorage();

// Routes d'addon seulement (sous-addons par langue compris): ni /ui, ni /debug, ni le hub.
const GUEST_ROUTE = /^\/p\/([^/]+)(\/(?:[a-z]+\/)?(?:manifest\.json|(?:catalog|meta|stream|subtitles)\/.+))$/;

/** `/p/<jeton>/<route d'addon>` -> { guest, url sans prefixe }, ou null. */
function guestRoute(url, guests) {
  const match = GUEST_ROUTE.exec(url);
  const guest = match && guests.get(match[1]);
  return guest ? { guest, url: match[2] } : null;
}

module.exports = {
  run: (ctx, fn) => store.run(ctx, fn),
  /** Nom du proche a l'origine de la requete, ou null pour le proprietaire. */
  guest: () => store.getStore()?.guest || null,
  guestRoute,
};
