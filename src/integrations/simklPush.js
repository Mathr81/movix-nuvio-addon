const simkl = require('./simklCloud');
const simklLibrary = require('./simklLibrary');
const { readMovix } = require('../hub/readers/movix');
const { notYetIn, deltaSize } = require('../hub/diff');
const { applyToSimkl } = require('../hub/writers/simkl');

/**
 * Import de la bibliotheque et de l'historique Movix vers Simkl, hors hub.
 *
 * Passe par les memes ecritures que le hub (lots de 50, titre + annee + ids, `not_found`
 * retenu), et n'envoie que ce que Simkl n'a pas deja: relancer l'import est donc sans
 * effet quand tout est a jour. Les series "vues" sans detail d'episodes sont ignorees,
 * comme partout dans le hub.
 */
async function pushToSimkl({ dryRun = false } = {}) {
  if (!simkl.isAuthenticated()) {
    return { ok: false, error: 'Simkl non autorise -- lance `npm run simkl:auth` une fois' };
  }

  const view = await simklLibrary.read();
  if (!view) {
    const { reason } = simkl.status();
    return { ok: false, error: `Simkl illisible pour l'instant${reason ? `: ${reason}` : ''}` };
  }

  const movix = await readMovix();
  const delta = notYetIn(
    { library: [...movix.library.values()], watched: [...movix.watched.values()], progress: [] },
    view.known,
  );

  const summary = {
    ok: true,
    dryRun,
    aEnvoyer: {
      liste: delta.library.length,
      films: delta.watched.filter((e) => e.type === 'movie').length,
      episodes: delta.watched.filter((e) => e.type === 'series').length,
    },
  };

  if (dryRun || deltaSize(delta) === 0) {
    if (dryRun) summary.exemples = { liste: delta.library.slice(0, 2), historique: delta.watched.slice(0, 2) };
    return summary;
  }

  try {
    summary.envoye = await applyToSimkl(delta);
  } catch (err) {
    summary.ok = false;
    summary.error = err.message;
  }
  console.log('[simkl-push] termine:', JSON.stringify(summary));
  return summary;
}

module.exports = { pushToSimkl };
