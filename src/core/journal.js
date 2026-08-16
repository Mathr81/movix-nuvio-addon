const fs = require('fs');
const path = require('path');
const config = require('./config');

/**
 * Journal des ecritures du hub, au format JSONL (une operation par ligne).
 *
 * Raison d'etre: le hub ecrit dans trois comptes sans supervision, et une suppression
 * propagee a tort est la seule faute qu'on ne peut pas rattraper de memoire. Chaque
 * retrait est donc consigne AVEC l'element retire, ce qui permet de le remettre --
 * `npm run hub:undo` rejoue les suppressions d'un cycle a l'envers.
 *
 * JSONL plutot que JSON: un fichier append-only ne se corrompt pas si le process meurt
 * en plein cycle, et se lit a la main (`tail -f`, `grep remove`).
 */
const JOURNAL_FILE = config.HUB_JOURNAL_FILE || path.join(__dirname, '..', 'data', 'hub-journal.jsonl');

let cycleId = null;

function begin() {
  cycleId = `${new Date().toISOString()}-${Math.random().toString(36).slice(2, 8)}`;
  return cycleId;
}

function write(entry) {
  if (!config.HUB_JOURNAL) return;
  try {
    fs.mkdirSync(path.dirname(JOURNAL_FILE), { recursive: true });
    fs.appendFileSync(JOURNAL_FILE, `${JSON.stringify({ cycle: cycleId, at: new Date().toISOString(), ...entry })}\n`);
  } catch (err) {
    console.warn(`[journal] ecriture impossible: ${err.message}`);
  }
}

/** Ajouts: on note ce qui part, sans le detail (il est reconstituable depuis la source). */
function logAdditions(target, delta) {
  const record = (kind, items, keyOf) => {
    for (const item of items) write({ action: 'add', target, kind, key: keyOf(item), item });
  };
  record('library', delta.library, (e) => `${e.type}:${e.id}`);
  record('watched', delta.watched, (e) => `${e.type}:${e.id}${e.season ? `:${e.season}:${e.episode}` : ''}`);
  record('progress', delta.progress, (e) => `${e.type}:${e.id}${e.season ? `:${e.season}:${e.episode}` : ''}`);
}

/**
 * Retraits: on note l'element TEL QU'IL ETAIT avant suppression. `before` porte ce qui a
 * ete lu dans la source juste avant l'ecriture -- sans lui, une restauration devrait
 * deviner le titre, l'affiche et la position.
 */
function logRemovals(target, removals, before = {}) {
  for (const kind of ['library', 'watched', 'progress']) {
    for (const key of removals[kind] || []) {
      write({ action: 'remove', target, kind, key, before: before[key] ?? null });
    }
  }
}

function logCycle(summary) {
  write({ action: 'cycle', summary });
}

/** Lit le journal, du plus recent au plus ancien. */
function read({ limit = 200, action = null } = {}) {
  let lines;
  try {
    lines = fs.readFileSync(JOURNAL_FILE, 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }

  const entries = [];
  for (let i = lines.length - 1; i >= 0 && entries.length < limit; i -= 1) {
    try {
      const entry = JSON.parse(lines[i]);
      if (!action || entry.action === action) entries.push(entry);
    } catch {
      // Ligne tronquee (arret brutal en cours d'ecriture): on l'ignore.
    }
  }
  return entries;
}

/** Toutes les suppressions d'un cycle donne, ou du dernier cycle qui en contient. */
function removalsOf(cycle = null) {
  const all = read({ limit: 5000, action: 'remove' });
  if (all.length === 0) return { cycle: null, entries: [] };
  const target = cycle || all[0].cycle;
  return { cycle: target, entries: all.filter((e) => e.cycle === target) };
}

module.exports = { begin, write, logAdditions, logRemovals, logCycle, read, removalsOf, JOURNAL_FILE };
