const axios = require('axios');
const config = require('../core/config');

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

/**
 * Spec OpenAPI de PostgREST (`GET /rest/v1/`): la liste de ce que l'API expose
 * REELLEMENT -- tables et fonctions RPC. Sert a supprimer sans deviner: les endpoints
 * `sync_push_*` sont additifs, donc retirer une ligne heritee demande soit une RPC de
 * suppression, soit un DELETE direct sur la table, et rien ne dit d'avance laquelle
 * existe sur ce compte.
 */
let apiSpec;
async function describeApi() {
  if (apiSpec !== undefined) return apiSpec;
  try {
    const token = await accessToken();
    const { data } = await client.get('/rest/v1/', { headers: authHeaders(token) });
    apiSpec = data && typeof data === 'object' ? data : null;
  } catch {
    apiSpec = null;
  }
  return apiSpec;
}

/** Noms des chemins exposes par PostgREST: `/rpc/xxx` pour les fonctions, `/xxx` pour les tables. */
async function listEndpoints() {
  const spec = await describeApi();
  const paths = Object.keys(spec?.paths || {});
  return {
    rpcs: paths.filter((p) => p.startsWith('/rpc/')).map((p) => p.slice(5)),
    tables: paths.filter((p) => p !== '/' && !p.startsWith('/rpc/')).map((p) => p.replace(/^\//, '')),
  };
}

/**
 * Noms des parametres d'une RPC, lus dans la spec.
 *
 * Une RPC Postgres se resout par son nom ET sa liste d'arguments: appeler
 * `sync_delete_watch_progress(p_id, p_profile_id)` quand elle est declaree
 * `(p_keys, p_profile_id)` renvoie un 404 PGRST202 -- la fonction est introuvable, pas
 * la ligne. On lit donc la signature au lieu de la supposer.
 */
async function rpcParameters(name) {
  const spec = await describeApi();
  const post = spec?.paths?.[`/rpc/${name}`]?.post;
  if (!post) return null;

  // PostgREST decrit le corps soit en ligne, soit par $ref vers `definitions`.
  const schema = (post.parameters || []).find((p) => p.in === 'body')?.schema || post.requestBody?.content?.['application/json']?.schema;
  const resolved = schema?.$ref
    ? spec.definitions?.[decodeURIComponent(schema.$ref.replace(/^#\/definitions\//, ''))]
    : schema;

  const properties = resolved?.properties;
  return properties ? Object.keys(properties) : null;
}

/**
 * Signature annoncee par PostgREST dans le `hint` d'une erreur PGRST202
 * ("Perhaps you meant to call the function public.foo(p_keys, p_profile_id)").
 * C'est la source la plus fiable quand la spec est muette: elle vient du serveur lui-meme.
 */
function paramsFromHint(err, name) {
  const hint = err?.body?.hint;
  if (typeof hint !== 'string') return null;
  const match = hint.match(new RegExp(`${name}\\(([^)]*)\\)`));
  if (!match) return null;
  const params = match[1].split(',').map((s) => s.trim()).filter(Boolean);
  return params.length > 0 ? params : null;
}

/**
 * Lecture directe d'une table PostgREST.
 *
 * Les `sync_pull_*` ne renvoient que les colonnes que la fonction a choisi de projeter:
 * `watch_progress` expose ainsi un `progress_key` que la lecture montre, mais rien ne dit
 * si `watched_items` a son equivalent. Lire la table repond a la question au lieu de la
 * deviner -- quand la RLS l'autorise.
 */
async function readRows(table, params = {}) {
  const token = await accessToken();
  const query = new URLSearchParams({ select: '*', limit: '1', ...params }).toString();
  const { data } = await client.get(`/rest/v1/${table}?${query}`, { headers: authHeaders(token) });
  return Array.isArray(data) ? data : [];
}

/** DELETE PostgREST filtre (`?id=eq.<valeur>`). Renvoie le nombre de lignes supprimees. */
async function removeRows(table, filters) {
  const token = await accessToken();
  const params = new URLSearchParams(filters).toString();
  const { headers } = await client.delete(`/rest/v1/${table}?${params}`, {
    headers: { ...authHeaders(token), Prefer: 'return=representation,count=exact' },
  });
  // PostgREST renvoie le total dans Content-Range (`0-2/3`); absent = suppression muette.
  const range = headers?.['content-range'];
  const total = range ? Number(String(range).split('/')[1]) : NaN;
  return Number.isFinite(total) ? total : null;
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
/**
 * Chaque fonction a sa propre signature cote Postgres -- il n'y a pas de convention
 * commune, et un mauvais jeu de parametres part en 404 PGRST202 (la fonction est
 * introuvable, pas la ligne). Les signatures ci-dessous sont celles que l'API annonce
 * elle-meme dans le champ `hint` de ses erreurs.
 */

/** sync_pull_watched_items(p_page, p_page_size, p_profile_id) -- pagination par page. */
async function pullWatchedItems(profileId) {
  const pageSize = 500;
  const all = [];
  for (let page = 1; page <= 200; page += 1) {
    const batch = await rpc('sync_pull_watched_items', {
      p_profile_id: profileId,
      p_page: page,
      p_page_size: pageSize,
    });
    const rows = Array.isArray(batch) ? batch : [];
    all.push(...rows);
    if (rows.length < pageSize) break;
  }
  return all;
}

/**
 * sync_pull_watch_progress(p_limit, p_profile_id, p_since_last_watched) -- pas de
 * pagination par offset: le curseur est temporel. `null` = tout depuis le debut.
 */
async function pullWatchProgress(profileId, sinceLastWatched = null) {
  const rows = await rpc('sync_pull_watch_progress', {
    p_profile_id: profileId,
    p_limit: 1000,
    p_since_last_watched: sinceLastWatched,
  });
  return Array.isArray(rows) ? rows : [];
}

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
  describeApi,
  listEndpoints,
  rpcParameters,
  paramsFromHint,
  readRows,
  removeRows,
  pullProfiles,
  pullLibrary,
  pullWatchedItems,
  pullWatchProgress,
  pushLibrary,
  pushWatchedItems,
  pushWatchProgress,
};
