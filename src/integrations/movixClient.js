const axios = require('axios');
const config = require('../core/config');

/**
 * Client HTTP de l'API Movix (Mainapi).
 *
 * Il n'y a plus qu'UN client. Celui qui visait proxiesembed a disparu avec les surfaces
 * qu'il appelait: `/api/extract-<hebergeur>` et `/api/voe/m3u8` exigent desormais
 * l'en-tete interne `x-internal-key`, partage entre Mainapi et proxiesembed seuls, et les
 * routes de proxy (`/proxy`, `/voe-proxy`...) n'acceptent plus qu'une URL signee en HMAC.
 * Tout passe donc par Mainapi, qui resout les flux lui-meme (cf. src/sources/resolved.js).
 *
 * Origin/Referer spoofes: `domainRestriction` (Mainapi/middleware/security.js) ne verifie
 * que ces en-tetes cote client, pas une vraie CORS -- un serveur Node les controle
 * entierement. La whitelist amont a change de domaines mais accepte toujours movix.fun,
 * et elle laisse desormais passer les requetes SANS Origin ni Referer (comportement CORS
 * standard: curl, appli mobile, serveur-a-serveur).
 *
 * `x-access-key` porte la cle VIP: c'est elle qui autorise la resolution serveur des
 * m3u8. Sans elle, les routes catalogue ne rendent que des liens d'embed.
 */
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

module.exports = { mainApi, createClient };
