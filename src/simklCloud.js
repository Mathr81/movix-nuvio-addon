const fs = require('fs');
const path = require('path');
const axios = require('axios');
const config = require('./config');

/**
 * Client de l'API Simkl.
 *
 * Pourquoi Simkl a cote de Trakt: depuis 2026 un compte Trakt gratuit n'autorise
 * qu'UNE seule application tierce connectee a la fois. Nuvio occupant ce slot, un
 * second client (cet addon) ne peut pas rester connecte en permanence sans VIP.
 * Simkl n'impose pas cette limite, est gratuit, et Nuvio l'integre nativement
 * (listes, historique, progression, scrobble) depuis aout 2026.
 *
 * Authentification par PIN, pensee pour les TV et les scripts sans navigateur.
 * Le jeton Simkl n'expire pas: aucune mecanique de refresh n'est necessaire.
 */
const TOKEN_FILE = config.SIMKL_TOKEN_FILE || path.join(__dirname, '..', '.simkl-token.json');

const client = axios.create({ baseURL: config.SIMKL_BASE_URL, timeout: 20000 });

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

function headers(withAuth = true) {
  const current = withAuth ? loadToken() : null;
  return {
    'Content-Type': 'application/json',
    'simkl-api-key': config.SIMKL_CLIENT_ID,
    ...(current ? { Authorization: `Bearer ${current}` } : {}),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Autorisation par PIN: on affiche un code, l'utilisateur le saisit sur simkl.com/pin. */
async function pinAuth({ onCode } = {}) {
  if (!config.SIMKL_CLIENT_ID) {
    throw new Error('SIMKL_CLIENT_ID non renseigne (cree une app sur simkl.com/settings/developer)');
  }

  const { data: device } = await client.get('/oauth/pin', {
    params: { client_id: config.SIMKL_CLIENT_ID },
    headers: headers(false),
  });
  if (device.result !== 'OK') throw new Error(`Simkl a refuse la demande de PIN: ${JSON.stringify(device)}`);

  if (onCode) onCode(device);
  console.log(`[simkl] ouvre ${device.verification_url} et saisis le code ${device.user_code}`);

  const intervalMs = (Number(device.interval) || 5) * 1000;
  const deadline = Date.now() + (Number(device.expires_in) || 900) * 1000;

  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const { data } = await client.get(`/oauth/pin/${device.user_code}`, {
      params: { client_id: config.SIMKL_CLIENT_ID },
      headers: headers(false),
    });
    // "KO" = en attente de saisie, c'est le cas nominal pendant toute la boucle.
    if (data.result === 'OK' && data.access_token) {
      saveToken(data.access_token);
      console.log('[simkl] autorise, jeton enregistre');
      return { ok: true };
    }
  }

  throw new Error('[simkl] delai depasse, le code n\'a pas ete valide a temps');
}

async function post(url, body) {
  if (!loadToken()) throw new Error('Simkl non autorise -- lance `npm run simkl:auth` une fois');
  try {
    const { data } = await client.post(url, body, { headers: headers() });
    return data;
  } catch (err) {
    const status = err.response?.status;
    const payload = err.response?.data;
    const detail = payload ? JSON.stringify(payload).slice(0, 300) : err.message;
    const error = new Error(`Simkl POST ${url} a echoue (status ${status ?? 'n/a'}): ${detail}`);
    error.status = status;
    error.body = payload;
    throw error;
  }
}

const addToHistory = (payload) => post('/sync/history', payload);
const addToList = (payload) => post('/sync/add-to-list', payload);

module.exports = { isAuthenticated, pinAuth, addToHistory, addToList, TOKEN_FILE };
