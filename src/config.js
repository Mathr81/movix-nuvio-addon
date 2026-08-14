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
  SPOOFED_ORIGIN: readEnv('SPOOFED_ORIGIN', 'https://movix.fun'),
  VIP_ACCESS_KEY: readEnv('VIP_ACCESS_KEY', ''),

  TMDB_API_KEY: readEnv('TMDB_API_KEY'),
  TMDB_LANGUAGE: readEnv('TMDB_LANGUAGE', 'fr-FR'),
  TMDB_REGION: readEnv('TMDB_REGION', 'FR'),

  // --- Sync compte Movix (catalogues personnels) ---
  // Valeurs a recuperer dans le localStorage du site: auth_token, user_id, selected_profile_id.
  MOVIX_JWT: readEnv('MOVIX_JWT', ''),
  MOVIX_USER_ID: readEnv('MOVIX_USER_ID', ''),
  MOVIX_USER_TYPE: readEnv('MOVIX_USER_TYPE', 'bip39'),
  MOVIX_PROFILE_ID: readEnv('MOVIX_PROFILE_ID', ''),
  SYNC_TTL_MS: Number(readEnv('SYNC_TTL_MS', 5 * 60 * 1000)),

  // --- Push vers Nuvio Sync (API cloud officielle) ---
  NUVIO_BASE_URL: readEnv('NUVIO_BASE_URL', 'https://api.nuvio.tv'),
  // Cle "publishable" Supabase: publique par conception, sans acces sans jeton utilisateur.
  NUVIO_API_KEY: readEnv('NUVIO_API_KEY', 'sb_publishable_1Clq8rlTVACkdcZuqr6_AD__xUUC_EN'),
  NUVIO_EMAIL: readEnv('NUVIO_EMAIL', ''),
  NUVIO_PASSWORD: readEnv('NUVIO_PASSWORD', ''),
  NUVIO_PROFILE_INDEX: Number(readEnv('NUVIO_PROFILE_INDEX', 0)) || null,
  // imdb (recommande, aligne sur Cinemeta) ou tmdb
  NUVIO_ID_PREFERENCE: readEnv('NUVIO_ID_PREFERENCE', 'imdb'),
  // Push periodique automatique. 0 = desactive (push manuel via POST /nuvio/push).
  NUVIO_PUSH_INTERVAL_MS: Number(readEnv('NUVIO_PUSH_INTERVAL_MS', 0)),

  // --- Trakt (hub d'historique de l'ecosysteme Stremio/Nuvio) ---
  TRAKT_BASE_URL: readEnv('TRAKT_BASE_URL', 'https://api.trakt.tv'),
  TRAKT_CLIENT_ID: readEnv('TRAKT_CLIENT_ID', ''),
  TRAKT_CLIENT_SECRET: readEnv('TRAKT_CLIENT_SECRET', ''),
  // Jeton obtenu par device code, conserve sur disque pour survivre aux redemarrages.
  TRAKT_TOKEN_FILE: readEnv('TRAKT_TOKEN_FILE', ''),
  // Date attribuee aux visionnages Movix non horodates: "released" (date de sortie) ou "now".
  TRAKT_WATCHED_AT: readEnv('TRAKT_WATCHED_AT', 'released'),
  // Trakt limite les ecritures a ~1/s: delai minimal entre deux requetes d'ecriture.
  TRAKT_WRITE_DELAY_MS: Number(readEnv('TRAKT_WRITE_DELAY_MS', 1100)),
  TRAKT_PUSH_INTERVAL_MS: Number(readEnv('TRAKT_PUSH_INTERVAL_MS', 0)),
  // Rangees "Recommandé pour vous" alimentees par l'algorithme Trakt.
  TRAKT_RECOMMENDATIONS: readBool('TRAKT_RECOMMENDATIONS', true),

  // --- Hub de synchronisation bidirectionnel ---
  HUB_ENABLED: readBool('HUB_ENABLED', false),
  // Delai entre deux cycles. C'est ce qui determine la latence percue quand on regarde
  // quelque chose sur le site: plus bas = plus reactif, mais un cycle interroge Movix
  // et Nuvio a chaque fois. Plancher a 15 s.
  HUB_INTERVAL_MS: Math.max(Number(readEnv('HUB_INTERVAL_MS', 45000)), 15000),
  HUB_STATE_FILE: readEnv('HUB_STATE_FILE', ''),
  // Propager les SUPPRESSIONS (retirer un titre quelque part le retire partout).
  // Destructif par nature: opt-in, et a n'activer qu'une fois un cycle normal verifie.
  HUB_PROPAGATE_DELETIONS: readBool('HUB_PROPAGATE_DELETIONS', false),
  // Coupe-circuit: au-dela de ce nombre de disparitions en un cycle, on suppose une
  // lecture incomplete plutot qu'un menage volontaire, et on ne propage rien.
  HUB_MAX_REMOVALS_PER_CYCLE: Number(readEnv('HUB_MAX_REMOVALS_PER_CYCLE', 10)),

  // --- Simkl (tracker sans limite d'app connectee, integre nativement par Nuvio) ---
  SIMKL_BASE_URL: readEnv('SIMKL_BASE_URL', 'https://api.simkl.com'),
  SIMKL_CLIENT_ID: readEnv('SIMKL_CLIENT_ID', ''),
  // Le jeton Simkl n'expire pas: pas de client secret ni de refresh a gerer.
  SIMKL_TOKEN_FILE: readEnv('SIMKL_TOKEN_FILE', ''),
  SIMKL_PUSH_INTERVAL_MS: Number(readEnv('SIMKL_PUSH_INTERVAL_MS', 0)),
  // Renvoi des positions de lecture vers Simkl a chaque cycle du hub (il ne les garde
  // qu'une semaine, donc les repousser est ce qui les maintient en vie).
  SIMKL_SCROBBLE: readBool('SIMKL_SCROBBLE', true),

  // Rangee de recommandations calculees localement depuis l'historique Movix (sans compte tiers).
  LOCAL_RECOMMENDATIONS: readBool('LOCAL_RECOMMENDATIONS', true),

  // --- Catalogues ---
  // Rangees integrees affichees, dans l'ordre. Vide = l'ordre par defaut.
  // Pour renommer une rangee ou en creer de nouvelles, utiliser catalogs.json.
  CATALOGS: readList('CATALOGS', null),
  CATALOGS_FILE: readEnv('CATALOGS_FILE', ''),

  // --- Streams ---
  // Mesure du debit reel (BANDWIDTH d'un master HLS, ou taille/duree pour un fichier).
  // Ajoute un aller-retour par lien: desactivable si l'ouverture des fiches devient lente.
  PROBE_BITRATE: readBool('PROBE_BITRATE', true),
  PROBE_TIMEOUT_MS: Number(readEnv('PROBE_TIMEOUT_MS', 3500)),
  // Proxy utilise en repli quand un CDN de hoster refuse l'acces direct. Meme valeur que
  // VITE_PROXY_BASE_URL cote site (ou l'URL du service bypass403): tous deux exposent
  // /proxy/<url> et posent les Origin/Referer attendus par domaine.
  PROBE_PROXY_BASE_URL: readEnv('PROBE_PROXY_BASE_URL', ''),

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

// Icone de l'addon. Derivee de SPOOFED_ORIGIN par defaut pour suivre automatiquement
// les changements de domaine du site (.cash -> .fun -> ...) sans edition de code.
config.LOGO_URL = readEnv('LOGO_URL', `${config.SPOOFED_ORIGIN.replace(/\/+$/, '')}/favicon.ico`);

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
