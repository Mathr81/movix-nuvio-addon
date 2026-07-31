const axios = require('axios');
const config = require('./config');

// Origin/Referer spoofes: domainRestriction (Mainapi/middleware/security.js) ne verifie que ces
// headers cote client, pas une vraie CORS -- un serveur Node les controle entierement.
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function spoofedHeaders() {
  return {
    Origin: config.SPOOFED_ORIGIN,
    Referer: `${config.SPOOFED_ORIGIN}/`,
    'User-Agent': DEFAULT_UA,
    ...(config.VIP_ACCESS_KEY ? { 'x-access-key': config.VIP_ACCESS_KEY } : {}),
  };
}

function createClient(baseURL) {
  const client = axios.create({ baseURL, timeout: 15000 });
  client.interceptors.request.use((requestConfig) => {
    requestConfig.headers = { ...requestConfig.headers, ...spoofedHeaders() };
    return requestConfig;
  });
  return client;
}

const mainApi = createClient(config.MAIN_API_BASE_URL);
const proxiesEmbed = createClient(config.PROXIES_EMBED_BASE_URL);

module.exports = { mainApi, proxiesEmbed };
