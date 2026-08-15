/**
 * Disjoncteur.
 *
 * Quand un service tombe, il tombe pour TOUS ses liens: reessayer le suivant n'apprend
 * rien, ca ne fait qu'ajouter un aller-retour et un delai d'attente a l'ouverture de la
 * fiche. Apres N pannes d'affilee, on le met de cote pour un temps.
 *
 * Ce qui compte comme "panne" est la decision de l'appelant, et c'est la seule subtilite:
 * un 5xx ou un timeout parlent du SERVICE, un 404 parle d'UNE ressource. Compter le second
 * reviendrait a couper un service en bon etat parce que trois videos ont ete supprimees.
 */
function create({ streak, cooldownMs, label }) {
  const states = new Map();

  function isOpen(key) {
    const state = states.get(key);
    return !!state && state.until > Date.now();
  }

  function noteOutage(key) {
    const state = states.get(key) || { failures: 0, until: 0 };
    state.failures += 1;
    if (state.failures >= streak()) {
      state.until = Date.now() + cooldownMs();
      state.failures = 0;
      console.warn(`[${label}:${key}] ${streak()} pannes d'affilee -- mis de cote ${Math.round(cooldownMs() / 1000)}s`);
    }
    states.set(key, state);
  }

  /** Une reussite efface l'ardoise: la panne precedente etait passagere. */
  function noteRecovery(key) {
    states.delete(key);
  }

  /** Ce qui est ecarte a l'instant, pour les routes de diagnostic. */
  function state() {
    const now = Date.now();
    return Object.fromEntries(
      [...states]
        .filter(([, value]) => value.until > now)
        .map(([key, value]) => [key, `ecarte encore ${Math.round((value.until - now) / 1000)}s`]),
    );
  }

  return { isOpen, noteOutage, noteRecovery, state };
}

module.exports = { create };
