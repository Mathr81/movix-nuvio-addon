const simkl = require('./simklCloud');

/**
 * Reconnaissance de l'API Simkl sur ton compte.
 *
 * La documentation publique de Simkl est incomplete: le fichier apiary fige sur GitHub
 * ne contient ni /scrobble ni les formes de reponse de /sync/all-items, et le site de
 * doc n'est pas toujours joignable. Plutot que de coder sur des suppositions, ce script
 * interroge l'API reelle et affiche la forme exacte de ce qu'elle renvoie -- de quoi
 * ecrire la synchronisation Simkl -> hub sans deviner.
 *
 * Lecture seule: aucune de ces requetes ne modifie le compte.
 */
function shapeOf(value, depth = 0) {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[${shapeOf(value[0], depth + 1)} x${value.length}]`;
  }
  if (typeof value !== 'object') return typeof value;
  if (depth > 2) return '{...}';
  const keys = Object.keys(value).slice(0, 12);
  return `{${keys.map((k) => `${k}: ${shapeOf(value[k], depth + 1)}`).join(', ')}}`;
}

function preview(value) {
  const text = JSON.stringify(value);
  return text && text.length > 600 ? `${text.slice(0, 600)}…` : text;
}

async function probeSimkl() {
  if (!simkl.isAuthenticated()) {
    console.error('Simkl non autorise -- lance `npm run simkl:auth` une fois');
    process.exitCode = 1;
    return;
  }

  const calls = [
    ['activites (detection de changement)', () => simkl.activities()],
    ['reglages du compte', () => simkl.settings()],
    ['films -> plantowatch', () => simkl.allItems('movies', 'plantowatch')],
    ['films -> completed', () => simkl.allItems('movies', 'completed')],
    ['series -> watching', () => simkl.allItems('shows', 'watching')],
    ['series -> completed', () => simkl.allItems('shows', 'completed')],
    // Endpoints non documentes publiquement: on regarde simplement s'ils repondent.
    ['progression en cours (/sync/playback)', () => simkl.get('/sync/playback')],
  ];

  for (const [label, run] of calls) {
    try {
      const data = await run();
      console.log(`\n=== ${label} ===`);
      console.log(`forme  : ${shapeOf(data)}`);
      console.log(`extrait: ${preview(data)}`);
    } catch (err) {
      console.log(`\n=== ${label} ===`);
      console.log(`ECHEC  : ${err.message}`);
    }
  }
}

module.exports = { probeSimkl };
