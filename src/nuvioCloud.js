const axios = require('axios');
const config = require('./config');

/**
 * Client de l'API cloud Nuvio (Supabase).
 *
 * Auth: grant password -> access_token (+ refresh_token), puis appels RPC
 * POST /rest/v1/rpc/<nom> avec les en-tetes `apikey` et `Authorization: Bearer`.
 *
 * NUVIO_API_KEY est une cle "publishable" Supabase: elle est concue pour etre
 * distribuee dans les clients et ne donne aucun acces sans jeton utilisateur.
 */
const client = axios.create({ baseURL: config.NUVIO_BASE_URL, timeout: 20000 });

let session = null; // { access_token, refresh_token, expiresAt }

function authHeaders(token) {
  return {
    apikey: config.NUVIO_API_KEY,
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function storeSession(data) {
  session = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    // Marge de 60 s pour ne pas utiliser un jeton qui expire pendant la requete.
    expiresAt: Date.now() + Math.max((Number(data.expires_in) || 3600) - 60, 60) * 1000,
  };
  return session;
}

async function login() {
  if (!config.NUVIO_EMAIL || !config.NUVIO_PASSWORD) {
    throw new Error('NUVIO_EMAIL / NUVIO_PASSWORD non renseignes');
  }
  const { data } = await client.post(
    '/auth/v1/token?grant_type=password',
    { email: config.NUVIO_EMAIL, password: config.NUVIO_PASSWORD },
    { headers: authHeaders() },
  );
  console.log('[nuvio] authentifie');
  return storeSession(data);
}

async function refresh() {
  const { data } = await client.post(
    '/auth/v1/token?grant_type=refresh_token',
    { refresh_token: session.refresh_token },
    { headers: authHeaders() },
  );
  return storeSession(data);
}

async function accessToken() {
  if (!session) return (await login()).access_token;
  if (Date.now() < session.expiresAt) return session.access_token;

  try {
    return (await refresh()).access_token;
  } catch {
    // Refresh expire/revoque: on repart d'une authentification complete.
    return (await login()).access_token;
  }
}

async function rpc(name, body = {}) {
  const token = await accessToken();
  try {
    const { data } = await client.post(`/rest/v1/rpc/${name}`, body, { headers: authHeaders(token) });
    return data;
  } catch (err) {
    // PostgREST renvoie un corps JSON explicite (message/details/hint/code); sans lui,
    // un echec se resume a "Request failed with status code 400" et n'aide en rien.
    const status = err.response?.status;
    const payload = err.response?.data;
    const detail = payload ? JSON.stringify(payload) : err.message;
    const error = new Error(`RPC ${name} a echoue (status ${status ?? 'n/a'}): ${detail}`);
    error.status = status;
    error.body = payload;
    error.rpc = name;
    throw error;
  }
}

async function pullProfiles() {
  const rows = await rpc('sync_pull_profiles', {});
  return Array.isArray(rows) ? rows : [];
}

/** La bibliotheque peut etre volumineuse: l'API pagine par lots. */
async function pullLibrary(profileId) {
  const limit = 500;
  const all = [];
  for (let offset = 0; offset < 100000; offset += limit) {
    const batch = await rpc('sync_pull_library', { p_profile_id: profileId, p_limit: limit, p_offset: offset });
    const rows = Array.isArray(batch) ? batch : [];
    all.push(...rows);
    if (rows.length < limit) break;
  }
  return all;
}

/**
 * Lectures symetriques des push. Elles alimentent le hub: c'est par la que remonte ce
 * qui a ete regarde DANS Nuvio, invisible autrement (le protocole d'addon ne notifie
 * jamais la lecture).
 */
async function pullPaginated(name, profileId) {
  const limit = 500;
  const all = [];
  for (let offset = 0; offset < 100000; offset += limit) {
    const batch = await rpc(name, { p_profile_id: profileId, p_limit: limit, p_offset: offset });
    const rows = Array.isArray(batch) ? batch : [];
    all.push(...rows);
    if (rows.length < limit) break;
  }
  return all;
}

const pullWatchedItems = (profileId) => pullPaginated('sync_pull_watched_items', profileId);
const pullWatchProgress = (profileId) => pullPaginated('sync_pull_watch_progress', profileId);

async function pushLibrary(profileId, items) {
  return rpc('sync_push_library', { p_profile_id: profileId, p_items: items });
}

async function pushWatchedItems(profileId, items) {
  return rpc('sync_push_watched_items', { p_profile_id: profileId, p_items: items });
}

async function pushWatchProgress(profileId, entries) {
  return rpc('sync_push_watch_progress', { p_profile_id: profileId, p_entries: entries });
}

module.exports = {
  rpc,
  pullProfiles,
  pullLibrary,
  pullWatchedItems,
  pullWatchProgress,
  pushLibrary,
  pushWatchedItems,
  pushWatchProgress,
};
