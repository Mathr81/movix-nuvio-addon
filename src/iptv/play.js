const axios = require('axios');
const config = require('../core/config');
const { resolve } = require('./sources');

/**
 * Lecture d'une chaine: choisir, parmi ses flux, le meilleur qui REPOND.
 *
 * Une playlist IPTV n'a qu'une URL par chaine, et un lecteur qui tombe sur un flux mort
 * affiche une erreur sans rien essayer d'autre. Or une part des flux Vavoo est morte a
 * tout instant (connexion acceptee, puis plus rien). La bascule se fait donc ICI: on
 * resout les premiers flux du classement en parallele, on demande a chacun le debut de sa
 * playlist, et on redirige vers le mieux classe de ceux qui ont repondu.
 *
 * Le lecteur recoit une redirection, pas le flux: la video ne transite pas par l'addon.
 */

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Flux essayes de front pour une chaine. Au-dela, on multiplie les resolutions amont pour
// un gain nul: si les quatre premiers sont morts, la chaine l'est presque toujours.
const MAX_CANDIDATES = 4;
// Un lecteur relit l'URL de la chaine a chaque reprise et parfois deux fois a l'ouverture:
// lui rendre la meme reponse evite de tout re-tester.
const CHOICE_TTL_MS = 30 * 1000;
// Un flux qui vient d'echouer est relegue le temps que sa source se retablisse.
const FAILURE_TTL_MS = 10 * 60 * 1000;

const failures = new Map(); // sid -> expiration
const choices = new Map(); // cle de chaine -> { at, result }

function recentlyFailed(sid) {
  const until = failures.get(sid);
  if (!until) return false;
  if (Date.now() > until) {
    failures.delete(sid);
    return false;
  }
  return true;
}

/**
 * Le flux repond-il ? On lit le PREMIER morceau de la reponse puis on coupe: assez pour
 * distinguer une playlist HLS d'une page d'erreur, sans telecharger un flux continu quand
 * la source sert du MPEG-TS brut.
 */
async function responds(url) {
  let res;
  try {
    res = await axios.get(url, {
      responseType: 'stream',
      timeout: config.IPTV_CHECK_TIMEOUT_MS,
      headers: { 'User-Agent': USER_AGENT },
      validateStatus: () => true,
    });
  } catch {
    return false;
  }

  try {
    if (res.status < 200 || res.status >= 300) return false;
    const first = await new Promise((done) => {
      const timer = setTimeout(() => done(null), config.IPTV_CHECK_TIMEOUT_MS);
      const finish = (value) => {
        clearTimeout(timer);
        done(value);
      };
      res.data.once('data', (chunk) => finish(chunk));
      res.data.once('end', () => finish(null));
      res.data.once('error', () => finish(null));
    });
    if (!first || first.length === 0) return false;
    const hls = /mpegurl/i.test(res.headers['content-type'] || '') || /\.m3u8(?:$|\?)/i.test(url);
    return hls ? first.toString('utf8', 0, 64).includes('#EXTM3U') : true;
  } finally {
    res.data.destroy();
  }
}

async function attempt(stream) {
  try {
    const url = await resolve(stream);
    if (!url) return null;
    if (config.IPTV_CHECK_STREAMS && !(await responds(url))) return null;
    return url;
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
async function pick(channel) {
  const cached = choices.get(channel.key);
  if (cached && Date.now() - cached.at < CHOICE_TTL_MS) return cached.result;

  // Les flux recemment en echec passent derriere, sans etre ecartes: si tout le reste est
  // mort aussi, autant les retenter.
  const ranked = [
    ...channel.streams.filter((stream) => !recentlyFailed(stream.sid)),
    ...channel.streams.filter((stream) => recentlyFailed(stream.sid)),
  ];

  const tried = [];
  for (let offset = 0; offset < ranked.length; offset += MAX_CANDIDATES) {
    const batch = ranked.slice(offset, offset + MAX_CANDIDATES).map((stream) => ({ stream, url: attempt(stream) }));
    for (const candidate of batch) {
      const url = await candidate.url;
      tried.push({ sid: candidate.stream.sid, label: candidate.stream.label, ok: !!url });
      if (!url) {
        failures.set(candidate.stream.sid, Date.now() + FAILURE_TTL_MS);
        continue;
      }
      failures.delete(candidate.stream.sid);
      const result = { url, stream: candidate.stream, tried };
      choices.set(channel.key, { at: Date.now(), result });
      return result;
    }
    // Deux lots au plus: au-dela, le lecteur a deja abandonne.
    if (offset >= MAX_CANDIDATES) break;
  }

  console.warn(`[iptv] ${channel.name}: aucun flux ne repond (${tried.length} essaye(s))`);
  return { url: null, stream: null, tried };
}

/** Un flux precis, choisi par l'utilisateur: resolu sans test, c'est lui qui decide. */
async function direct(stream) {
  try {
    return await resolve(stream);
  } catch (err) {
    console.warn(`[iptv] flux ${stream.sid} non resolu: ${err.response?.status || err.message}`);
    return null;
  }
}

function health() {
  const now = Date.now();
  return [...failures].filter(([, until]) => until > now).map(([sid]) => sid);
}

// Purge: les deux tables ne grossissent qu'au fil des chaines regardees, mais sans fin.
setInterval(() => {
  const now = Date.now();
  for (const [sid, until] of failures) if (until <= now) failures.delete(sid);
  for (const [key, choice] of choices) if (now - choice.at > CHOICE_TTL_MS) choices.delete(key);
}, 5 * 60 * 1000).unref();

module.exports = { pick, direct, health };
