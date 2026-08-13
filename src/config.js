require('dotenv').config();

function readEnv(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function readBool(name, fallback) {
  const value = readEnv(name);
  if (value === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

function readList(name, fallback) {
  const value = readEnv(name);
  if (value === undefined) return fallback;
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

const config = {
  PORT: Number(readEnv('PORT', 8787)),

  // URL publique de l'addon (utilisee pour construire les liens de sous-titres proxifies).
  // Doit etre joignable par l'appareil qui lit (iPad, TV...), pas juste par le serveur.
  PUBLIC_URL: readEnv('PUBLIC_URL', ''),

  MAIN_API_BASE_URL: readEnv('MAIN_API_BASE_URL'),
  PROXIES_EMBED_BASE_URL: readEnv('PROXIES_EMBED_BASE_URL'),
  SPOOFED_ORIGIN: readEnv('SPOOFED_ORIGIN', 'https://movix.cash'),
  VIP_ACCESS_KEY: readEnv('VIP_ACCESS_KEY', ''),

  TMDB_API_KEY: readEnv('TMDB_API_KEY'),
  TMDB_LANGUAGE: readEnv('TMDB_LANGUAGE', 'fr-FR'),

  // Sources activees (noms tels qu'exportes par src/sources/*.js).
  ENABLED_SOURCES: readList('ENABLED_SOURCES', null), // null = toutes

  // Langues de sous-titres proposees (codes OpenSubtitles ISO 639-2, ex: fre,eng).
  SUBTITLE_LANGS: readList('SUBTITLE_LANGS', ['fre', 'eng']),
  SUBTITLES_ENABLED: readBool('SUBTITLES_ENABLED', true),

  // Quand un embed n'a pas d'extracteur (vidara.to, lecteurvideo.com...), proposer quand meme
  // le lien en "ouvrir dans le navigateur" au lieu de le jeter. Bruyant -> desactive par defaut.
  SHOW_UNPLAYABLE_EMBEDS: readBool('SHOW_UNPLAYABLE_EMBEDS', false),

  CACHE_TTL_MS: Number(readEnv('CACHE_TTL_MS', 30 * 60 * 1000)),
  CACHE_EMPTY_TTL_MS: Number(readEnv('CACHE_EMPTY_TTL_MS', 2 * 60 * 1000)),

  // Langues privilegiees dans le tri des streams (prefixes matches sur le libelle).
  PREFERRED_LANGS: readList('PREFERRED_LANGS', ['MULTI', 'VFF', 'VFQ', 'VF', 'TRUEFRENCH', 'FRENCH']),
};

if (!config.MAIN_API_BASE_URL) console.warn('[config] MAIN_API_BASE_URL manquant -- voir .env.example');
if (!config.PROXIES_EMBED_BASE_URL) console.warn('[config] PROXIES_EMBED_BASE_URL manquant -- voir .env.example');
if (!config.VIP_ACCESS_KEY) console.warn('[config] VIP_ACCESS_KEY manquant -- les extractions VIP-gated echoueront');
if (!config.TMDB_API_KEY) console.warn('[config] TMDB_API_KEY manquant -- catalogue/meta ne fonctionneront pas');
if (config.SUBTITLES_ENABLED && !config.PUBLIC_URL) {
  console.warn(
    '[config] PUBLIC_URL manquant -- les sous-titres seront servis via une URL deduite de la requete, ' +
      'ce qui casse si l\'appareil de lecture n\'atteint pas ce host. Renseigne PUBLIC_URL (ex: http://100.x.x.x:8787).',
  );
}

module.exports = config;
