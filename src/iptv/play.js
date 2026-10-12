const config = require('../core/config');
const { resolve } = require('./sources');
const health = require('./health');

/**
 * Lecture d'une chaine: choisir, parmi ses flux, le meilleur qui REPOND.
 *
 * Une playlist IPTV n'a qu'une URL par chaine, et un lecteur qui tombe sur un flux mort
 * affiche une erreur sans rien essayer d'autre. La bascule se fait donc ICI, et le lecteur
 * recoit une redirection: la video ne transite pas par l'addon.
 *
 * La grille arrive deja classee, flux morts en queue (cf. la ronde de health.js). Trois
 * cas, du plus rapide au plus lent:
 *   1. le lecteur relit l'URL d'une chaine qu'il joue deja -> meme reponse, revalidee une
 *      fois par minute;
 *   2. le premier flux (hors IPTV) a ete vu vivant il y a peu -> redirection sans test;
 *   3. sinon -> les premiers flux sont resolus et testes de front, le mieux classe qui
 *      repond l'emporte.
 */

// Flux essayes de front. Au-dela, on multiplie les resolutions amont pour un gain nul.
const MAX_CANDIDATES = 4;
// Un test de vie recent dispense de retester au zap.
const TRUST_MS = 20 * 60 * 1000;
// Un flux qui echoue AU ZAP est relegue jusque-la, sans attendre la prochaine ronde.
const FAILURE_TTL_MS = 10 * 60 * 1000;
// Un lecteur HLS relit la playlist toutes les quelques secondes. Tant qu'il le fait, on
// lui rend la MEME cible: en changer en cours de lecture (nouveau jeton, autre serveur)
// casse la continuite des segments. La cible est seulement revalidee de temps en temps.
const STICKY_IDLE_MS = 2 * 60 * 1000;
const STICKY_RECHECK_MS = 60 * 1000;

const failures = new Map(); // sid -> expiration
const sticky = new Map(); // cle (chaine ou flux) -> { url, stream, tried, usedAt, checkedAt }

function recentlyFailed(sid) {
  const until = failures.get(sid);
  if (!until) return false;
  if (Date.now() > until) {
    failures.delete(sid);
    return false;
  }
  return true;
}

function fail(stream) {
  failures.set(stream.sid, Date.now() + FAILURE_TTL_MS);
  health.record(stream.sid, false);
}

/** Cible deja servie pour `key`, si le lecteur est toujours dessus et qu'elle repond encore. */
async function reuse(key) {
  const held = sticky.get(key);
  const now = Date.now();
  if (!held || now - held.usedAt > STICKY_IDLE_MS) return null;
  if (config.IPTV_CHECK_STREAMS && now - held.checkedAt > STICKY_RECHECK_MS) {
    if (!(await health.responds(held.url))) {
      sticky.delete(key);
      return null;
    }
    held.checkedAt = now;
  }
  held.usedAt = now;
  return held;
}

function hold(key, result) {
  const now = Date.now();
  sticky.set(key, { ...result, usedAt: now, checkedAt: now });
  return result;
}

async function attempt(stream, { trust = false } = {}) {
  try {
    const url = await resolve(stream);
    if (!url) return null;
    if (trust || !config.IPTV_CHECK_STREAMS) return url;
    return (await health.responds(url, health.timeoutFor(stream, 'zap'))) ? url : null;
  } catch {
    return null;
  }
}

/**
 * Meilleur flux jouable d'une chaine: `{ url, stream, tried }`, ou `url: null` si aucun.
 *
 * Les candidats partent ensemble mais sont ATTENDUS dans l'ordre du classement: un flux
 * moins bon qui repond vite ne double pas un meilleur encore en cours de test.
 */
async function pick(channel, { fresh = false } = {}) {
  if (!fresh) {
    const held = await reuse(channel.key);
    if (held) return held;
  }

  // Les flux qui viennent d'echouer au zap passent derriere, sans etre ecartes: si tout
  // le reste est mort aussi, autant les retenter.
  const ranked = [
    ...channel.streams.filter((stream) => !recentlyFailed(stream.sid)),
    ...channel.streams.filter((stream) => recentlyFailed(stream.sid)),
  ];
  const tried = [];

  const first = ranked[0];
  // L'IPTV n'est jamais cru sur parole: vivant il y a dix minutes, il peut etre rendormi
  // (cf. health.timeoutFor) et faire attendre le lecteur plus qu'il ne le tolere.
  const trusted = first && first.source !== 'xtream' && first.ok === true && Date.now() - (first.checkedAt || 0) < TRUST_MS;
  if (!fresh && trusted) {
    const url = await attempt(first, { trust: true });
    if (url) {
      tried.push({ sid: first.sid, label: first.label, ok: true, trusted: true });
      return hold(channel.key, { url, stream: first, tried });
    }
  }

  for (let offset = 0; offset < ranked.length; offset += MAX_CANDIDATES) {
    const batch = ranked.slice(offset, offset + MAX_CANDIDATES).map((stream) => ({ stream, url: attempt(stream) }));
    for (const candidate of batch) {
      const url = await candidate.url;
      tried.push({ sid: candidate.stream.sid, label: candidate.stream.label, ok: !!url });
      if (!url) {
        fail(candidate.stream);
        continue;
      }
      failures.delete(candidate.stream.sid);
      health.record(candidate.stream.sid, true);
      return hold(channel.key, { url, stream: candidate.stream, tried });
    }
    // Deux lots au plus: au-dela, le lecteur a deja abandonne.
    if (offset >= MAX_CANDIDATES) break;
  }

  console.warn(`[iptv] ${channel.name}: aucun flux ne repond (${tried.length} essaye(s))`);
  return { url: null, stream: null, tried };
}

/**
 * Un flux precis (playlist detaillee, variante de qualite). S'il ne repond pas, on rend
 * `null` et l'appelant retombe sur le choix automatique: mieux vaut une autre definition
 * qu'un ecran noir.
 */
async function direct(stream) {
  const key = `sid:${stream.sid}`;
  const held = await reuse(key);
  if (held) return held.url;

  const url = await attempt(stream);
  if (!url) {
    fail(stream);
    return null;
  }
  health.record(stream.sid, true);
  hold(key, { url, stream, tried: [] });
  return url;
}

// Purge: les deux tables ne grossissent qu'au fil des chaines regardees, mais sans fin.
setInterval(() => {
  const now = Date.now();
  for (const [sid, until] of failures) if (until <= now) failures.delete(sid);
  for (const [key, held] of sticky) if (now - held.usedAt > STICKY_IDLE_MS) sticky.delete(key);
}, 5 * 60 * 1000).unref();

module.exports = { pick, direct };
