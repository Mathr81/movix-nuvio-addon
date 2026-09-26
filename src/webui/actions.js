const hub = require('../hub');
const { pushToNuvio } = require('../integrations/nuvioPush');
const { pushToTrakt } = require('../integrations/traktPush');
const { pushToSimkl } = require('../integrations/simklPush');
const trakt = require('../integrations/traktCloud');
const simkl = require('../integrations/simklCloud');
const simklLibrary = require('../integrations/simklLibrary');

/**
 * Autorisation par code (Trakt, Simkl): on rend le code des qu'il est connu, l'attente de
 * validation se poursuit cote serveur (elle peut durer plusieurs minutes).
 */
async function startCodeAuth(label, begin) {
  const started = await new Promise((resolve, reject) => {
    const done = begin({ onCode: (device) => resolve(device) });
    done.catch(reject);
    done.then(() => console.log(`[${label}] autorisation terminee`), () => {});
  });
  return {
    ok: true,
    code: started.user_code,
    url: started.verification_url,
    expiresInSeconds: started.expires_in,
  };
}

/**
 * Ce que la WebUI peut declencher. Chaque entree reprend EXACTEMENT la fonction de la
 * route POST ou du script npm equivalent: l'interface n'a pas de logique propre.
 *
 * `writes`: l'action ecrit dans un compte distant. L'interface demande confirmation, et
 * propose d'abord la simulation quand `dryRun` est accepte.
 */
const ACTIONS = {
  'hub-sync': { label: 'Cycle du hub', writes: true, dryRun: true, run: ({ dryRun }) => hub.runCycle({ dryRun }) },
  'hub-undo': {
    label: 'Annuler les suppressions',
    writes: true,
    run: ({ cycle }) => hub.undoRemovals(cycle || null),
  },
  'nuvio-push': { label: 'Push Nuvio', writes: true, dryRun: true, run: ({ dryRun }) => pushToNuvio({ dryRun }) },
  'nuvio-merge': {
    label: 'Fusion des ids Nuvio',
    writes: true,
    dryRun: true,
    run: ({ dryRun }) => hub.mergeNuvioIds({ dryRun }),
  },
  'trakt-push': { label: 'Push Trakt', writes: true, dryRun: true, run: ({ dryRun }) => pushToTrakt({ dryRun }) },
  'trakt-auth': { label: 'Connexion Trakt', run: () => startCodeAuth('trakt', trakt.deviceAuth) },
  'simkl-push': { label: 'Push Simkl', writes: true, dryRun: true, run: ({ dryRun }) => pushToSimkl({ dryRun }) },
  'simkl-auth': { label: 'Connexion Simkl', run: () => startCodeAuth('simkl', simkl.pinAuth) },
  'simkl-resync': {
    label: 'Relecture complete Simkl',
    run: async () => {
      // Oublie la copie locale de Simkl, puis la relit en entier (cf. POST /simkl/resync).
      simklLibrary.reset();
      const ok = await simklLibrary.sync({ force: true });
      return { ok, simkl: simkl.status() };
    },
  },
};

/** Liste publique, sans les fonctions: l'interface s'en sert pour dessiner ses boutons. */
function describe() {
  return Object.entries(ACTIONS).map(([name, a]) => ({
    name,
    label: a.label,
    writes: !!a.writes,
    dryRun: !!a.dryRun,
  }));
}

async function run(name, params = {}) {
  const action = ACTIONS[name];
  if (!action) {
    const error = new Error(`action inconnue: ${name}`);
    error.status = 404;
    throw error;
  }
  const dryRun = !!(action.dryRun && params.dryRun);
  console.log(`[webui] action ${name}${dryRun ? ' (simulation)' : ''}`);
  return action.run({ ...params, dryRun });
}

module.exports = { run, describe, startCodeAuth };
