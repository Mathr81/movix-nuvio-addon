const fs = require('fs');
const journal = require('../core/journal');

/**
 * Index des cycles du journal du hub, pour la page Synchro.
 *
 * Le journal grossit sans fin (des dizaines de Mo: un cycle de suppressions en ecrit des
 * centaines de milliers de lignes), et `journal.read` le relit en entier, de facon
 * synchrone. Acceptable pour un script npm, pas pour une page qui se rafraichit seule:
 * chaque appel figerait l'addon le temps de la lecture.
 *
 * On le lit donc UNE fois, en flux, puis seulement la partie ajoutee depuis. Pour chaque
 * cycle on ne garde que des compteurs et la plage d'octets qu'il occupe -- les lignes d'un
 * cycle sont contigues, le hub n'en fait jamais tourner deux a la fois --, ce qui permet
 * d'en relire le detail a la demande sans tout garder en memoire.
 */
const cycles = new Map();
let scanned = 0;
let scanning = null;

function cycleOf(id) {
  if (!cycles.has(id)) {
    cycles.set(id, { id, start: null, end: null, firstAt: null, lastAt: null, summary: null, counts: {} });
  }
  return cycles.get(id);
}

function note(entry, start, end) {
  if (!entry.cycle) return;
  const cycle = cycleOf(entry.cycle);
  if (cycle.start === null) cycle.start = start;
  cycle.end = end;
  cycle.firstAt = cycle.firstAt || entry.at;
  cycle.lastAt = entry.at;
  if (entry.action === 'cycle') {
    cycle.summary = entry.summary;
    return;
  }
  // "remove.simkl.watched" -> 12
  const key = `${entry.action}.${entry.target}.${entry.kind}`;
  cycle.counts[key] = (cycle.counts[key] || 0) + 1;
}

async function readRange(start, end) {
  if (end <= start) return Buffer.alloc(0);
  const handle = await fs.promises.open(journal.JOURNAL_FILE, 'r');
  try {
    const buffer = Buffer.alloc(end - start);
    await handle.read(buffer, 0, buffer.length, start);
    return buffer;
  } finally {
    await handle.close();
  }
}

// Lit par blocs depuis `scanned`, en s'arretant a la derniere fin de ligne: une ligne en
// cours d'ecriture sera reprise au passage suivant.
async function scan() {
  let size;
  try {
    size = (await fs.promises.stat(journal.JOURNAL_FILE)).size;
  } catch {
    cycles.clear();
    scanned = 0;
    return;
  }
  if (size < scanned) {
    // Journal tronque ou remplace: on repart de zero.
    cycles.clear();
    scanned = 0;
  }

  const CHUNK = 4 * 1024 * 1024;
  while (scanned < size) {
    const buffer = await readRange(scanned, Math.min(size, scanned + CHUNK));
    const lastNewline = buffer.lastIndexOf(0x0a);
    if (lastNewline < 0) break;
    let offset = 0;
    while (offset <= lastNewline) {
      const next = buffer.indexOf(0x0a, offset);
      const line = buffer.toString('utf8', offset, next);
      if (line) {
        try {
          note(JSON.parse(line), scanned + offset, scanned + next + 1);
        } catch {
          // Ligne tronquee par un arret brutal: ignoree, comme dans journal.read.
        }
      }
      offset = next + 1;
    }
    scanned += lastNewline + 1;
  }
}

function refresh() {
  if (!scanning) scanning = scan().finally(() => (scanning = null));
  return scanning;
}

/** Les cycles, du plus recent au plus ancien, sans leurs lignes. */
async function list({ limit = 40 } = {}) {
  await refresh();
  return [...cycles.values()]
    .sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)))
    .slice(0, limit)
    .map(({ start, end, ...rest }) => ({ ...rest, bytes: end - start }));
}

/** Les lignes d'un cycle, bornees: un cycle de suppressions massives en compte des milliers. */
async function entries(id, { limit = 500 } = {}) {
  await refresh();
  const cycle = cycles.get(id);
  if (!cycle) return { cycle: id, total: 0, entries: [] };

  const buffer = await readRange(cycle.start, cycle.end);
  const all = [];
  for (const line of buffer.toString('utf8').split('\n')) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.cycle === id && entry.action !== 'cycle') all.push(entry);
    } catch {
      // idem
    }
  }
  return { cycle: id, total: all.length, entries: all.slice(0, limit) };
}

module.exports = { list, entries };
