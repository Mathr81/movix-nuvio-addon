const fs = require('fs');
const axios = require('axios');
const config = require('../core/config');
const paths = require('../core/paths');
const { version: APP_VERSION } = require('../../package.json');

/**
 * Client de l'API Simkl, calque sur la documentation officielle (api.simkl.org).
 *
 * Pourquoi Simkl a cote de Trakt: depuis 2026 un compte Trakt gratuit n'autorise
 * qu'UNE seule application tierce connectee a la fois. Nuvio occupant ce slot, un
 * second client (cet addon) ne peut pas rester connecte en permanence sans VIP.
 * Simkl n'impose pas cette limite, est gratuit, et Nuvio l'integre nativement.
 *
 * Ce que la doc impose, et que ce module garantit pour tout appel:
 *   - `client_id`, `app-name`, `app-version` en query et un `User-Agent` nom/version,
 *     sur CHAQUE requete (conventions/headers);
 *   - une seule requete en vol a la fois, et au plus 1 POST par seconde
 *     (resources/rate-limits): au-dela, Simkl bloque le jeton ou le `client_id`, et une
 *     recidive allonge le blocage;
 *   - chaque refus traite selon SA cause, qui n'appelle pas la meme reponse:
 *       400 RATE_LIMIT      verrou d'ecriture de ~20 s par utilisateur: on reessaie vite
 *       429 rate_limit      debit par seconde depasse: une seconde suffit
 *       429 *_limit_exceeded quota quotidien epuise: pause jusqu'a `Retry-After`
 *       412                 client_id refuse ou blocage pour POST en rafale: pause longue
 *       403 "Blocked"       blocage par Simkl (IP ou app): pause longue, seul le support
 *                           Simkl peut le lever
 *
 * Une pause coupe TOUT appel sortant jusqu'a son terme: insister pendant un blocage est
 * precisement ce qui le prolonge.
 *
 * Authentification par PIN (AUTH V1). Le jeton vaut ~5 ans et n'a pas de refresh.
 */
const TOKEN_FILE = config.SIMKL_TOKEN_FILE || paths.inRoot('.simkl-token.json');
const APP_NAME = 'movix-nuvio-addon';
const USER_AGENT = `${APP_NAME}/${APP_VERSION}`;

const POST_SPACING_MS = 1100;
const GET_SPACING_MS = 150;
const WRITE_LOCK_RETRY_MS = 5000;
const MAX_ATTEMPTS = 4;
const LONG_PAUSE_MS = 6 * 60 * 60 * 1000;

const client = axios.create({ baseURL: config.SIMKL_BASE_URL, timeout: 30000 });

let token = null;

function loadToken() {
  if (token) return token;
  try {
    token = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')).access_token || null;
  } catch {
    token = null;
  }
  return token;
}

function saveToken(accessToken) {
  token = accessToken;
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({ access_token: accessToken }, null, 2), { mode: 0o600 });
  return token;
}

function isAuthenticated() {
  return !!loadToken();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Pause (disjoncteur) --------------------------------------------------------

let pausedUntil = 0;
let pauseReason = null;

function pause(ms, reason) {
  const until = Date.now() + ms;
  if (until <= pausedUntil) return;
  pausedUntil = until;
  pauseReason = reason;
  console.warn(`[simkl] appels suspendus jusqu'a ${new Date(until).toISOString()}: ${reason}`);
}

/** Simkl est-il joignable en ce moment, du point de vue de ce client? */
function available() {
  return isAuthenticated() && Date.now() >= pausedUntil;
}

function status() {
  const paused = Date.now() < pausedUntil;
  return {
    authenticated: isAuthenticated(),
    paused,
    pausedUntil: paused ? new Date(pausedUntil).toISOString() : null,
    reason: paused ? pauseReason : null,
  };
}

// --- File d'attente: une requete a la fois, POST espaces d'au moins 1,1 s ---------

let queue = Promise.resolve();
let lastGetAt = 0;
let lastPostAt = 0;

function serialize(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

function simklError(method, url, err, extra = {}) {
  const status = err.response?.status;
  const payload = err.response?.data;
  const detail = payload ? (typeof payload === 'string' ? payload : JSON.stringify(payload)).slice(0, 300) : err.message;
  const error = new Error(`Simkl ${method} ${url} a echoue (status ${status ?? 'n/a'}): ${detail}`);
  Object.assign(error, { status, body: payload }, extra);
  return error;
}

function errorCode(body) {
  return typeof body === 'object' && body ? String(body.error || '').toLowerCase() : '';
}

async function send(method, url, { params = {}, body, auth = true } = {}) {
  if (!config.SIMKL_CLIENT_ID) throw new Error('SIMKL_CLIENT_ID non renseigne');
  if (auth && !loadToken()) throw new Error('Simkl non autorise -- lance `npm run simkl:auth` une fois');

  return serialize(async () => {
    for (let attempt = 1; ; attempt += 1) {
      if (Date.now() < pausedUntil) {
        throw Object.assign(new Error(`Simkl en pause (${pauseReason})`), { paused: true });
      }

      const isPost = method === 'POST';
      const wait = isPost ? lastPostAt + POST_SPACING_MS - Date.now() : lastGetAt + GET_SPACING_MS - Date.now();
      if (wait > 0) await sleep(wait);

      const headers = { 'User-Agent': USER_AGENT };
      if (isPost) headers['Content-Type'] = 'application/json';
      if (auth) headers.Authorization = `Bearer ${loadToken()}`;

      try {
        const { data } = await client.request({
          method,
          url,
          data: body,
          headers,
          params: { client_id: config.SIMKL_CLIENT_ID, 'app-name': APP_NAME, 'app-version': APP_VERSION, ...params },
        });
        return data;
      } catch (err) {
        const status = err.response?.status;
        const payload = err.response?.data;
        const code = errorCode(payload);
        const text = typeof payload === 'string' ? payload : '';

        // Verrou d'ecriture par utilisateur ("une autre synchro est en cours"): il tombe
        // des que l'ecriture en vol se termine. Surtout pas de recul exponentiel ici.
        if (status === 400 && code === 'rate_limit' && attempt < MAX_ATTEMPTS) {
          await sleep(WRITE_LOCK_RETRY_MS);
          continue;
        }
        if (status === 429) {
          if (code === 'user_limit_exceeded' || code === 'app_limit_exceeded') {
            const retryAfter = Number(err.response.headers?.['retry-after']) || 3600;
            pause(retryAfter * 1000, `quota quotidien Simkl epuise (${code})`);
            throw simklError(method, url, err);
          }
          if (attempt < MAX_ATTEMPTS) {
            await sleep(1500 * attempt);
            continue;
          }
        }
        if (status === 412) {
          pause(LONG_PAUSE_MS, 'client_id refuse par Simkl (412): client_id invalide, suspendu, ou blocage pour ecritures en rafale');
          throw simklError(method, url, err);
        }
        if (status === 403 && /blocked/i.test(text)) {
          pause(LONG_PAUSE_MS, 'Simkl bloque ce serveur ("Blocked. Please contact support@simkl.com")');
          throw simklError(method, url, err);
        }
        if (status === 401 && auth) {
          pause(LONG_PAUSE_MS, 'jeton Simkl refuse (401): relance `npm run simkl:auth`');
          throw simklError(method, url, err);
        }
        if ((!status || status >= 500) && attempt < MAX_ATTEMPTS) {
          await sleep(2000 * 2 ** (attempt - 1));
          continue;
        }
        throw simklError(method, url, err);
      } finally {
        if (method === 'POST') lastPostAt = Date.now();
        else lastGetAt = Date.now();
      }
    }
  });
}

const get = (url, params = {}) => send('GET', url, { params });
const post = (url, body) => send('POST', url, { body });

// --- Authentification par PIN (AUTH V1) --------------------------------------------

/** Un code s'affiche; l'utilisateur le saisit sur simkl.com/pin pendant qu'on attend. */
async function pinAuth({ onCode } = {}) {
  if (!config.SIMKL_CLIENT_ID) {
    throw new Error('SIMKL_CLIENT_ID non renseigne (cree une app sur simkl.com/settings/developer)');
  }

  const device = await send('GET', '/oauth/pin', { auth: false });
  if (device.result !== 'OK' || !device.user_code) {
    throw new Error(`Simkl a refuse la demande de PIN: ${JSON.stringify(device)}`);
  }

  const verificationUri = device.verification_uri || device.verification_url;
  if (onCode) onCode({ ...device, verification_url: verificationUri });
  console.log(`[simkl] ouvre ${verificationUri} et saisis le code ${device.user_code}`);

  const intervalMs = (Number(device.interval) || 5) * 1000;
  const deadline = Date.now() + (Number(device.expires_in) || 900) * 1000;

  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const data = await send('GET', `/oauth/pin/${encodeURIComponent(device.user_code)}`, { auth: false });
    if (data.result === 'OK' && data.access_token) {
      saveToken(data.access_token);
      pausedUntil = 0;
      console.log('[simkl] autorise, jeton enregistre');
      return { ok: true };
    }
    // Un code inconnu ou deja consomme fait repondre Simkl par un NOUVEAU code (forme de
    // `/oauth/pin`, reconnaissable a `device_code`): l'original n'existe plus.
    if (data.device_code) throw new Error('[simkl] code PIN expire ou deja utilise -- relance l\'autorisation');
  }

  throw new Error('[simkl] delai depasse, le code n\'a pas ete valide a temps');
}

// --- Endpoints -------------------------------------------------------------------

/** Horodatages de derniere modification par categorie: la porte d'entree de toute lecture. */
const activities = () => get('/sync/activities');

/**
 * Bibliotheque. `type` (movies|shows|anime) et `status` sont facultatifs; sans eux, tout
 * vient d'un coup. A n'appeler qu'apres `activities`, jamais sur un simple minuteur.
 */
function allItems({ type, status: listStatus, ...params } = {}) {
  const path = ['/sync/all-items', type, type && listStatus].filter(Boolean).join('/');
  return get(path, params);
}

const addToHistory = (payload) => post('/sync/history', payload);
const removeFromHistory = (payload) => post('/sync/history/remove', payload);
/** `to` est porte par CHAQUE element; un `to` global est refuse (400 empty_field). */
const addToList = (payload) => post('/sync/add-to-list', payload);
const playback = () => get('/sync/playback');
const settings = () => post('/users/settings', {});

/** `start` / `pause` / `stop`, avec un pourcentage. */
const scrobble = (action, payload) => post(`/scrobble/${action}`, payload);

module.exports = {
  isAuthenticated,
  available,
  status,
  pinAuth,
  activities,
  allItems,
  addToHistory,
  removeFromHistory,
  addToList,
  playback,
  settings,
  scrobble,
  get,
  post,
  TOKEN_FILE,
  USER_AGENT,
};
