const simkl = require('./simklCloud');

/**
 * Reconnaissance de l'API Simkl sur ton compte: affiche la forme exacte des reponses.
 *
 * La reference est desormais la doc officielle (api.simkl.org, spec OpenAPI comprise);
 * cette sonde sert a verifier ce que renvoie TON compte (anime, episodes des series
 * terminees, positions de reprise). Lecture seule, une requete par compartiment.
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
    ['films', () => simkl.allItems({ type: 'movies', extended: 'full' })],
    ['series', () => simkl.allItems({ type: 'shows', extended: 'full', include_all_episodes: 'yes' })],
    ['anime', () => simkl.allItems({ type: 'anime', extended: 'full_anime_seasons', include_all_episodes: 'yes' })],
    ['positions de reprise (/sync/playback)', () => simkl.playback()],
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
