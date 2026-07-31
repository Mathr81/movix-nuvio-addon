require('dotenv').config();

function readEnv(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

const config = {
  PORT: Number(readEnv('PORT', 8787)),
  MAIN_API_BASE_URL: readEnv('MAIN_API_BASE_URL'),
  PROXIES_EMBED_BASE_URL: readEnv('PROXIES_EMBED_BASE_URL'),
  SPOOFED_ORIGIN: readEnv('SPOOFED_ORIGIN', 'https://movix.cash'),
  VIP_ACCESS_KEY: readEnv('VIP_ACCESS_KEY', ''),
  TMDB_API_KEY: readEnv('TMDB_API_KEY'),
  TMDB_LANGUAGE: readEnv('TMDB_LANGUAGE', 'fr-FR'),
};

if (!config.MAIN_API_BASE_URL) console.warn('[config] MAIN_API_BASE_URL manquant -- voir .env.example');
if (!config.PROXIES_EMBED_BASE_URL) console.warn('[config] PROXIES_EMBED_BASE_URL manquant -- voir .env.example');
if (!config.VIP_ACCESS_KEY) console.warn('[config] VIP_ACCESS_KEY manquant -- les extractions VIP-gated echoueront');
if (!config.TMDB_API_KEY) console.warn('[config] TMDB_API_KEY manquant -- catalogue/meta ne fonctionneront pas');

module.exports = config;
