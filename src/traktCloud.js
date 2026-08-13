const fs = require('fs');
const path = require('path');
const axios = require('axios');
const config = require('./config');

/**
 * Client de l'API Trakt.
 *
 * Trakt est le hub d'historique de l'ecosysteme Stremio/Nuvio: Nuvio s'y connecte
 * nativement (scrobble automatique de ce qu'on regarde) et la plupart des addons de
 * recommandation/catalogue le lisent. Y importer l'historique Movix rend donc les
 * donnees exploitables bien au-dela de Nuvio, contrairement au sync cloud Nuvio qui
 * reste un silo ferme.
 *
 * Authentification par "device code" (pensee pour les TV et les scripts sans navigateur):
 * on affiche un code, l'utilisateur le saisit sur trakt.tv/activate, on recupere un jeton
 * valable 3 mois, renouvelable.
 */
const TOKEN_FILE = config.TRAKT_TOKEN_FILE || path.join(__dirname, '..', '.trakt-token.json');

const client = axios.create({ baseURL: config.TRAKT_BASE_URL, timeout: 20000 });

function baseHeaders() {
  return {
    'Content-Type': 'application/json',
    'trakt-api-version': '2',
    'trakt-api-key': config.TRAKT_CLIENT_ID,
  };
}

// --- Persistance du jeton --------------------------------------------------
// Le device code est une action interactive: sans persistance sur disque, chaque
// redemarrage du process (pm2 restart, reboot) obligerait a re-autoriser a la main.

let tokens = null;

function loadTokens() {
  if (tokens) return tokens;
  try {
    tokens = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  } catch {
    tokens = null;
  }
  return tokens;
}

function saveTokens(data) {
  tokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    // created_at est en secondes cote Trakt.
    expiresAt: (Number(data.created_at) || Math.floor(Date.now() / 1000)) * 1000 + (Number(data.expires_in) || 7776000) * 1000,
  };
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  return tokens;
}

function isAuthenticated() {
  return !!loadTokens()?.access_token;
}

// --- Device OAuth ----------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Lance l'autorisation par device code et attend que l'utilisateur valide.
 * `onCode` recoit {user_code, verification_url} pour affichage (console ou HTTP).
 */
async function deviceAuth({ onCode } = {}) {
  if (!config.TRAKT_CLIENT_ID || !config.TRAKT_CLIENT_SECRET) {
    throw new Error('TRAKT_CLIENT_ID / TRAKT_CLIENT_SECRET non renseignes (cree une app sur trakt.tv/oauth/applications)');
  }

  const { data: device } = await client.post(
    '/oauth/device/code',
    { client_id: config.TRAKT_CLIENT_ID },
    { headers: baseHeaders() },
  );

  if (onCode) onCode(device);
  console.log(`[trakt] ouvre ${device.verification_url} et saisis le code ${device.user_code}`);

  let intervalMs = (Number(device.interval) || 5) * 1000;
  const deadline = Date.now() + (Number(device.expires_in) || 600) * 1000;

  while (Date.now() < deadline) {
    await sleep(intervalMs);

    const res = await client.post(
      '/oauth/device/token',
      { code: device.device_code, client_id: config.TRAKT_CLIENT_ID, client_secret: config.TRAKT_CLIENT_SECRET },
      { headers: baseHeaders(), validateStatus: () => true },
    );

    // 400 = en attente de validation, c'est le cas nominal tant que l'utilisateur n'a pas saisi le code.
    if (res.status === 400) continue;
    if (res.status === 200) {
      saveTokens(res.data);
      console.log('[trakt] autorise, jeton enregistre');
      return { ok: true };
    }
    // 429: on interroge trop vite, Trakt demande d'espacer.
    if (res.status === 429) {
      intervalMs *= 2;
      continue;
    }

    const reasons = {
      404: 'code invalide',
      409: 'ce code a deja ete approuve',
      410: 'code expire, relance la commande',
      418: 'autorisation refusee',
    };
    throw new Error(`[trakt] autorisation echouee (${res.status}): ${reasons[res.status] || 'erreur inconnue'}`);
  }

  throw new Error('[trakt] delai depasse, le code n\'a pas ete valide a temps');
}

async function refresh() {
  const current = loadTokens();
  const { data } = await client.post(
    '/oauth/token',
    {
      refresh_token: current.refresh_token,
      client_id: config.TRAKT_CLIENT_ID,
      client_secret: config.TRAKT_CLIENT_SECRET,
      redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
      grant_type: 'refresh_token',
    },
    { headers: baseHeaders() },
  );
  console.log('[trakt] jeton renouvele');
  return saveTokens(data);
}

async function accessToken() {
  const current = loadTokens();
  if (!current?.access_token) {
    throw new Error('Trakt non autorise -- lance `npm run trakt:auth` une fois');
  }
  // Marge d'un jour: un jeton qui expire pendant un push long ferait echouer la moitie des appels.
  if (Date.now() < current.expiresAt - 24 * 60 * 60 * 1000) return current.access_token;
  return (await refresh()).access_token;
}

// --- Appels API ------------------------------------------------------------

// Trakt limite les ecritures a environ 1 requete par seconde par utilisateur. Un import
// d'historique en fait des dizaines: sans file d'attente serialisee, la moitie repart en 429.
let writeChain = Promise.resolve();

function throttleWrite(task) {
  const result = writeChain.then(task);
  writeChain = result.then(() => sleep(config.TRAKT_WRITE_DELAY_MS), () => sleep(config.TRAKT_WRITE_DELAY_MS));
  return result;
}

async function request(method, url, body) {
  const token = await accessToken();
  const headers = { ...baseHeaders(), Authorization: `Bearer ${token}` };

  const run = async () => {
    try {
      const { data } = await client.request({ method, url, data: body, headers });
      return data;
    } catch (err) {
      const status = err.response?.status;

      // 429 avec Retry-After: on respecte le delai demande plutot que d'abandonner.
      if (status === 429) {
        const wait = (Number(err.response.headers?.['retry-after']) || 2) * 1000;
        console.warn(`[trakt] 429 sur ${url}, nouvel essai dans ${wait / 1000}s`);
        await sleep(wait);
        const { data } = await client.request({ method, url, data: body, headers });
        return data;
      }

      const payload = err.response?.data;
      const detail = payload ? JSON.stringify(payload).slice(0, 300) : err.message;
      const error = new Error(`Trakt ${method.toUpperCase()} ${url} a echoue (status ${status ?? 'n/a'}): ${detail}`);
      error.status = status;
      error.body = payload;
      throw error;
    }
  };

  return method === 'get' ? run() : throttleWrite(run);
}

const get = (url) => request('get', url);
const post = (url, body) => request('post', url, body);

// --- Endpoints utilises ----------------------------------------------------

const addToHistory = (payload) => post('/sync/history', payload);
const addToWatchlist = (payload) => post('/sync/watchlist', payload);

/**
 * Enregistre un point de reprise. Trakt n'a pas d'endpoint d'import de progression:
 * la seule facon d'alimenter "en cours de visionnage" est de simuler une pause de lecture.
 * Renvoie null sur 409 (Trakt considere qu'une session est deja en cours pour ce titre).
 */
async function scrobblePause(payload) {
  try {
    return await post('/scrobble/pause', { ...payload, app_version: '1.0', app_date: '2026-01-01' });
  } catch (err) {
    if (err.status === 409) return null;
    throw err;
  }
}

const listUserLists = () => get('/users/me/lists');
const createList = (name) => post('/users/me/lists', { name, privacy: 'private' });
const addToList = (listId, payload) => post(`/users/me/lists/${listId}/items`, payload);

/** Recommandations personnalisees, calculees par Trakt a partir de l'historique. */
async function recommendations(type, { limit = 40 } = {}) {
  const path_ = type === 'series' ? '/recommendations/shows' : '/recommendations/movies';
  const rows = await get(`${path_}?limit=${limit}&ignore_collected=true&ignore_watchlisted=true`);
  return Array.isArray(rows) ? rows : [];
}

module.exports = {
  isAuthenticated,
  deviceAuth,
  addToHistory,
  addToWatchlist,
  scrobblePause,
  listUserLists,
  createList,
  addToList,
  recommendations,
  TOKEN_FILE,
};
