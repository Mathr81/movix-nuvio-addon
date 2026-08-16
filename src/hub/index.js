const config = require('../core/config');
const journal = require('../core/journal');
const movixSync = require('../integrations/movixSync');
const nuvio = require('../integrations/nuvioCloud');
const nuvioMerge = require('../integrations/nuvioMerge');
const simkl = require('../integrations/simklCloud');

const { readMovix } = require('./readers/movix');
const { readNuvio } = require('./readers/nuvio');
const { readSimkl } = require('./readers/simkl');
const { applyToMovix, applyRemovalsToMovix } = require('./writers/movix');
const { applyToNuvio } = require('./writers/nuvio');
const { applyToSimkl, applyRemovalsToSimkl, scrobbleToSimkl } = require('./writers/simkl');
const { STATE_FILE, loadState, saveState, clearState, snapshot } = require('./state');
const {
  changesSince,
  notYetIn,
  deltaSize,
  removalsSince,
  guardRemovals,
  withoutContested,
  valuesFor,
  mergeRemovals,
  union,
} = require('./diff');

/**
 * Hub de synchronisation bidirectionnel Movix <-> Nuvio Sync -> Simkl.
 *
 * Le probleme: le protocole d'addon ne notifie jamais la lecture, donc ce qui est
 * regarde DANS Nuvio est invisible de ce cote. La parade est de ne pas passer par
 * l'addon du tout mais par l'API cloud Nuvio, qui expose en lecture ce que l'app y
 * ecrit. Le hub interroge les deux cotes en boucle et propage les nouveautes.
 *
 * Simkl ne recoit que l'historique et les listes: son API n'a pas d'endpoint de
 * position, et sa progression n'est de toute facon conservee qu'une semaine.
 *
 * Ce fichier n'orchestre que le cycle; lire, comparer et ecrire vivent dans
 * `readers/`, `diff.js` et `writers/`.
 */

let running = false;
let lastRun = null;

/** Profil Nuvio cible: celui configure, sinon le premier du compte. */
async function resolveProfileId() {
  const profiles = await nuvio.pullProfiles();
  return config.NUVIO_PROFILE_INDEX || Number(profiles[0]?.profile_index) || 1;
}

async function runCycle({ dryRun = false } = {}) {
  if (running) return { ok: false, skipped: 'un cycle est deja en cours' };
  running = true;
  const cycleId = journal.begin();

  try {
    // Le hub veut l'etat courant, pas la version en cache du catalogue.
    movixSync.invalidate();

    const profileId = await resolveProfileId();

    // Fusion des entrees Nuvio encore identifiees en IMDb AVANT de lire: sinon le meme
    // titre est lu sous deux cles et le cycle propage la moins avancee des deux.
    let mergeSummary = null;
    if (config.NUVIO_MERGE_LEGACY_IDS && !dryRun) {
      try {
        const merged = await nuvioMerge.mergeLegacyIds(profileId);
        const touched = ['library', 'progress', 'watched'].reduce((n, k) => n + (merged[k]?.fusionnees || 0), 0);
        if (touched > 0) {
          mergeSummary = merged;
          console.log('[hub] entrees Nuvio en IMDb fusionnees vers tmdb:', JSON.stringify(merged));
        }
      } catch (err) {
        console.warn(`[hub] fusion des identifiants Nuvio ignoree: ${err.message}`);
      }
    }

    const [movix, nuvioModel, simklModel] = await Promise.all([readMovix(), readNuvio(profileId), readSimkl()]);
    const previous = loadState();

    const changes = {
      movix: changesSince(movix, previous?.movix),
      nuvio: changesSince(nuvioModel, previous?.nuvio),
      simkl: changesSince(simklModel, previous?.simkl),
    };

    // Chaque cible recoit ce qui a bouge chez les deux autres, moins ce qu'elle a deja.
    const toNuvio = notYetIn(union(changes.movix, changes.simkl), nuvioModel);
    const toMovix = notYetIn(union(changes.nuvio, changes.simkl), movix);
    const toSimkl = notYetIn(union(changes.movix, changes.nuvio), simklModel);

    // Suppressions: memes chemins que les ajouts, mais on ecarte tout element (re)ajoute
    // ailleurs pendant le meme cycle -- effacer un ajout frais est irrattrapable, alors
    // qu'une suppression ignoree se represente au tour suivant.
    const allAdditions = union(union(changes.movix, changes.nuvio), changes.simkl);
    const gone = config.HUB_PROPAGATE_DELETIONS
      ? {
          movix: guardRemovals('Movix', removalsSince(movix, previous?.movix), movix, previous?.movix),
          nuvio: guardRemovals('Nuvio', removalsSince(nuvioModel, previous?.nuvio), nuvioModel, previous?.nuvio),
          simkl: guardRemovals('Simkl', removalsSince(simklModel, previous?.simkl), simklModel, previous?.simkl),
        }
      : { movix: null, nuvio: null, simkl: null };

    const removeFrom = (a, b) =>
      config.HUB_PROPAGATE_DELETIONS
        ? withoutContested(mergeRemovals(a, b), allAdditions)
        : { library: [], watched: [], progress: [] };

    const removeInNuvio = removeFrom(gone.movix, gone.simkl);
    const removeInMovix = removeFrom(gone.nuvio, gone.simkl);
    const removeInSimkl = removeFrom(gone.movix, gone.nuvio);

    const count = (d) => ({ library: d.library.length, watched: d.watched.length, progress: d.progress.length });
    const summary = {
      ok: true,
      dryRun,
      profileId,
      premierTour: !previous,
      movix: { library: movix.library.size, watched: movix.watched.size, progress: movix.progress.size },
      nuvio: { library: nuvioModel.library.size, watched: nuvioModel.watched.size, progress: nuvioModel.progress.size },
      simkl: { library: simklModel.library.size, watched: simklModel.watched.size },
      versNuvio: count(toNuvio),
      versMovix: count(toMovix),
      versSimkl: count(toSimkl),
      retraits: config.HUB_PROPAGATE_DELETIONS
        ? { nuvio: count(removeInNuvio), movix: count(removeInMovix), simkl: count(removeInSimkl) }
        : 'desactive (HUB_PROPAGATE_DELETIONS)',
    };
    if (mergeSummary) summary.fusionNuvio = mergeSummary;

    if (dryRun) {
      summary.samples = { versNuvio: toNuvio.progress.slice(0, 2), versMovix: toMovix.progress.slice(0, 2) };
      running = false;
      return summary;
    }

    summary.errors = {};
    const step = async (name, fn) => {
      try {
        const value = await fn();
        if (value) summary[name] = value;
      } catch (err) {
        summary.ok = false;
        summary.errors[name] = err.message;
        console.error(`[hub] ${name}: ${err.message}`);
      }
    };

    // Le journal est ecrit AVANT l'operation: si l'ecriture echoue a mi-parcours, on
    // veut la trace de ce qui a ete tente, pas seulement de ce qui a reussi.
    if (deltaSize(toNuvio) > 0 || removeInNuvio.library.length > 0) {
      journal.logAdditions('nuvio', toNuvio);
      journal.logRemovals('nuvio', removeInNuvio, valuesFor(nuvioModel, removeInNuvio));
      await step('pousseVersNuvio', () => applyToNuvio(profileId, toNuvio, removeInNuvio));
    }
    if (deltaSize(toMovix) > 0) {
      journal.logAdditions('movix', toMovix);
      await step('pousseVersMovix', () => applyToMovix(toMovix));
    }
    if (deltaSize(toSimkl) > 0) {
      journal.logAdditions('simkl', toSimkl);
      await step('pousseVersSimkl', () => applyToSimkl(toSimkl));
    }

    if (deltaSize(removeInMovix) > 0) {
      journal.logRemovals('movix', removeInMovix, valuesFor(movix, removeInMovix));
      await step('retireDeMovix', () => applyRemovalsToMovix(removeInMovix));
    }
    if (deltaSize(removeInSimkl) > 0) {
      journal.logRemovals('simkl', removeInSimkl, valuesFor(simklModel, removeInSimkl));
      await step('retireDeSimkl', () => applyRemovalsToSimkl(removeInSimkl));
    }

    // Les positions partent vers Simkl a chaque cycle, sans filtrage par delta: il ne les
    // conserve qu'une semaine, donc les repousser est justement ce qui les maintient.
    if (config.SIMKL_SCROBBLE && simkl.isAuthenticated()) {
      const positions = [...movix.progress.values()];
      if (positions.length > 0) await step('scrobbleSimkl', () => scrobbleToSimkl(positions));
    }

    // L'instantane n'est enregistre qu'en cas de succes complet: un echec partiel doit
    // etre rejoue au tour suivant, pas oublie.
    if (summary.ok) {
      saveState({
        movix: snapshot(movix, toMovix, removeInMovix),
        nuvio: snapshot(nuvioModel, toNuvio, removeInNuvio),
        // Simkl n'expose pas les positions en lecture: elles partent en scrobble et ne
        // reviennent jamais. Les inscrire dans son instantane serait une fausse promesse.
        simkl: snapshot(simklModel, toSimkl, removeInSimkl, ['library', 'watched']),
      });
    }

    summary.cycle = cycleId;
    journal.logCycle(summary);
    lastRun = { at: new Date().toISOString(), summary };
    if (deltaSize(toNuvio) + deltaSize(toMovix) + deltaSize(toSimkl) > 0 || !summary.ok) {
      console.log('[hub] cycle:', JSON.stringify(summary));
    }
    return summary;
  } finally {
    running = false;
  }
}

function start() {
  if (!config.HUB_ENABLED) return;
  if (!config.MOVIX_JWT || !config.NUVIO_EMAIL) {
    console.warn('[hub] desactive: MOVIX_JWT et NUVIO_EMAIL sont tous deux requis');
    return;
  }

  const seconds = Math.round(config.HUB_INTERVAL_MS / 1000);
  console.log(`Hub de synchronisation actif (cycle toutes les ${seconds}s)`);
  const tick = () => runCycle().catch((err) => console.error(`[hub] cycle echoue: ${err.message}`));
  tick();
  setInterval(tick, config.HUB_INTERVAL_MS).unref();
}

function status() {
  return { enabled: config.HUB_ENABLED, intervalMs: config.HUB_INTERVAL_MS, running, lastRun };
}

/**
 * Restauration: rejoue a l'envers les suppressions d'un cycle. Les elements sont remis
 * la ou ils ont ete retires, avec les valeurs relevees avant l'operation.
 *
 * L'instantane est efface au passage: il decrit un monde ou ces elements n'existaient
 * plus, et le laisser en place ferait re-supprimer au cycle suivant.
 */
async function undoRemovals(cycle = null) {
  const { cycle: target, entries } = journal.removalsOf(cycle);
  if (entries.length === 0) return { ok: true, restaures: 0, message: 'aucune suppression a annuler' };

  const byTarget = new Map();
  for (const entry of entries) {
    if (!entry.before) continue; // rien a remettre sans l'etat d'origine
    if (!byTarget.has(entry.target)) byTarget.set(entry.target, { library: [], watched: [], progress: [] });
    byTarget.get(entry.target)[entry.kind].push(entry.before);
  }

  const result = { ok: true, cycle: target, restaures: {} };
  for (const [name, delta] of byTarget) {
    try {
      if (name === 'movix') await applyToMovix(delta);
      else if (name === 'simkl') await applyToSimkl(delta);
      else if (name === 'nuvio') await applyToNuvio(await resolveProfileId(), delta);
      result.restaures[name] = deltaSize(delta);
    } catch (err) {
      result.ok = false;
      result.restaures[name] = `echec: ${err.message}`;
    }
  }

  if (clearState()) result.instantaneEfface = true;

  console.log('[hub] restauration:', JSON.stringify(result));
  return result;
}

/** Fusion manuelle des entrees Nuvio en IMDb (aussi lancee au debut de chaque cycle). */
async function mergeNuvioIds({ dryRun = false } = {}) {
  return nuvioMerge.mergeLegacyIds(await resolveProfileId(), { dryRun });
}

module.exports = { runCycle, start, status, undoRemovals, mergeNuvioIds, resolveProfileId, STATE_FILE };
