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
 * Simkl est lu et ecrit pour l'historique et les listes; les positions ne font que
 * partir vers lui (`/scrobble/pause`). Il n'est lu qu'a son rythme (SIMKL_POLL_INTERVAL_MS,
 * voir integrations/simklLibrary.js) et peut manquer un tour: il est alors simplement
 * laisse de cote, sans rien en deduire. Ce qui doit lui parvenir se mesure depuis le
 * dernier cycle ou il a ete servi (`simklBase`), pour qu'une indisponibilite ne perde rien.
 *
 * Ce fichier n'orchestre que le cycle; lire, comparer et ecrire vivent dans
 * `readers/`, `diff.js` et `writers/`.
 */

let running = false;
let lastRun = null;

const emptyDelta = () => ({ library: [], watched: [], progress: [] });

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

    const [movix, nuvioModel, simklView] = await Promise.all([readMovix(), readNuvio(profileId), readSimkl()]);
    const previous = loadState();
    // `confirmed`: ce que Simkl a reellement montre; seule base pour en deduire quoi que ce soit.
    const simklModel = simklView?.confirmed || null;
    // Etat Movix/Nuvio lors du dernier cycle ou Simkl a ete servi.
    const simklBase = previous?.simklBase || { movix: previous?.movix, nuvio: previous?.nuvio };

    const changes = {
      movix: changesSince(movix, previous?.movix),
      nuvio: changesSince(nuvioModel, previous?.nuvio),
      simkl: simklModel ? changesSince(simklModel, previous?.simkl) : emptyDelta(),
    };

    // Chaque cible recoit ce qui a bouge chez les deux autres, moins ce qu'elle a deja.
    const toNuvio = notYetIn(union(changes.movix, changes.simkl), nuvioModel);
    const toMovix = notYetIn(union(changes.nuvio, changes.simkl), movix);
    const toSimkl = simklView
      ? {
          ...notYetIn(
            union(changesSince(movix, simklBase.movix), changesSince(nuvioModel, simklBase.nuvio)),
            simklView.known,
          ),
          // Les positions partent en scrobble, plus bas, selon leurs propres regles.
          progress: [],
        }
      : emptyDelta();

    // Suppressions: memes chemins que les ajouts, mais on ecarte tout element (re)ajoute
    // ailleurs pendant le meme cycle -- effacer un ajout frais est irrattrapable, alors
    // qu'une suppression ignoree se represente au tour suivant.
    const allAdditions = union(union(changes.movix, changes.nuvio), changes.simkl);
    const gone = config.HUB_PROPAGATE_DELETIONS
      ? {
          movix: guardRemovals('Movix', removalsSince(movix, previous?.movix), movix, previous?.movix),
          nuvio: guardRemovals('Nuvio', removalsSince(nuvioModel, previous?.nuvio), nuvioModel, previous?.nuvio),
          simkl: simklModel ? guardRemovals('Simkl', simklRemovals(), simklModel, previous?.simkl) : emptyDelta(),
        }
      : { movix: null, nuvio: null, simkl: null };

    // Un titre passe de "a voir" a "termine" quitte la liste `plantowatch` sans quitter
    // Simkl: ce n'est pas un retrait. Seul compte un titre absent de TOUTE liste Simkl.
    function simklRemovals() {
      const removed = removalsSince(simklModel, previous?.simkl);
      return { ...removed, library: removed.library.filter((k) => !simklView.known.library.has(k)) };
    }

    const removeFrom = (a, b) =>
      config.HUB_PROPAGATE_DELETIONS
        ? withoutContested(mergeRemovals(a || emptyDelta(), b || emptyDelta()), allAdditions)
        : emptyDelta();

    const removeInNuvio = removeFrom(gone.movix, gone.simkl);
    const removeInMovix = removeFrom(gone.nuvio, gone.simkl);
    // Vers Simkl, les disparitions se mesurent elles aussi depuis `simklBase`, et ne
    // visent que ce que Simkl possede.
    const removeInSimkl = (() => {
      if (!simklView || !config.HUB_PROPAGATE_DELETIONS) return emptyDelta();
      const merged = removeFrom(
        guardRemovals('Movix', removalsSince(movix, simklBase.movix), movix, simklBase.movix),
        guardRemovals('Nuvio', removalsSince(nuvioModel, simklBase.nuvio), nuvioModel, simklBase.nuvio),
      );
      return {
        library: merged.library.filter((k) => simklView.known.library.has(k)),
        watched: merged.watched.filter((k) => simklView.known.watched.has(k)),
        progress: [],
      };
    })();

    const count = (d) => ({ library: d.library.length, watched: d.watched.length, progress: d.progress.length });
    const summary = {
      ok: true,
      dryRun,
      profileId,
      premierTour: !previous,
      movix: { library: movix.library.size, watched: movix.watched.size, progress: movix.progress.size },
      nuvio: { library: nuvioModel.library.size, watched: nuvioModel.watched.size, progress: nuvioModel.progress.size },
      simkl: simklModel
        ? {
            library: simklModel.library.size,
            watched: simklModel.watched.size,
            // Titres de la liste Movix que Simkl range en "termine": une liste Simkl est
            // exclusive, un titre vu n'y est plus "a voir". Ils manquent donc a `library`
            // sans rien avoir de perdu -- ce compte explique l'ecart.
            listeDejaVus: [...movix.library.keys()].filter(
              (k) => !simklModel.library.has(k) && simklView.known.library.has(k),
            ).length,
          }
        : `indisponible ce tour-ci${simkl.status().reason ? ` (${simkl.status().reason})` : ''}`,
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

    // Positions: seulement celles qui different de ce que Simkl a deja (voir le writer).
    if (config.SIMKL_SCROBBLE && simklView) {
      const positions = [...movix.progress.values()];
      if (positions.length > 0) await step('scrobbleSimkl', () => scrobbleToSimkl(positions));
    }

    // L'instantane n'est enregistre que si Movix et Nuvio ont ete servis sans erreur: un
    // echec partiel doit etre rejoue au tour suivant, pas oublie. Un echec cote Simkl ne
    // bloque pas les deux autres: il laisse seulement `simklBase` en place, de sorte que
    // ce qui devait partir vers Simkl reparte au prochain tour.
    const simklFailed = Object.keys(summary.errors).some((name) => /Simkl$/.test(name));
    const coreOk = Object.keys(summary.errors).every((name) => /Simkl$/.test(name));
    if (coreOk) {
      const movixSnap = snapshot(movix, toMovix, removeInMovix);
      const nuvioSnap = snapshot(nuvioModel, toNuvio, removeInNuvio);
      const simklServed = simklView && !simklFailed;
      saveState({
        movix: movixSnap,
        nuvio: nuvioSnap,
        // Seul le confirme y entre: une ecriture pas encore relue ne doit pas pouvoir
        // "disparaitre" de Simkl au tour suivant.
        simkl: simklModel ? snapshot(simklModel, null, removeInSimkl, ['library', 'watched']) : previous?.simkl || null,
        simklBase: simklServed ? { movix: movixSnap, nuvio: nuvioSnap } : simklBase,
      });
    }

    summary.cycle = cycleId;
    // Un cycle qui n'a rien fait n'a rien a raconter: a raison d'un tour toutes les 20 s,
    // ces resumes faisaient l'essentiel du journal (des dizaines de Mo).
    if (!journal.isIdle(summary)) journal.logCycle(summary);
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

  // Menage du journal au demarrage, puis une fois par jour (cf. HUB_JOURNAL_RETENTION_DAYS).
  const prune = () => {
    try {
      journal.prune();
    } catch (err) {
      console.warn(`[journal] menage impossible: ${err.message}`);
    }
  };
  prune();
  setInterval(prune, 24 * 3600 * 1000).unref();
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
