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

  // --- Forme des identifiants de contenu -----------------------------------
  // Gouverne A LA FOIS les ids servis par l'addon (catalogues, metas, episodes) et les
  // `content_id` ecrits dans Nuvio. Les deux DOIVENT s'accorder: Nuvio enregistre la
  // progression sous l'id de la fiche qu'il lit, donc servir une forme et en pousser une
  // autre cree deux entrees pour le meme titre.
  //   imdb  tt0903747   aligne sur Cinemeta et les autres addons, au prix d'une
  //                     resolution TMDB -> IMDb par titre (cache 24 h)
  //   tmdb  tmdb:1396   aucun appel de plus, mais isole des addons indexes par IMDb
  ID_FORMAT: readEnv('ID_FORMAT', 'imdb').trim().toLowerCase(),

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
  // Fusionner les entrees Nuvio qui ne sont pas dans la forme ID_FORMAT vers celle-ci.
  // Sans frais quand il n'y a rien a fusionner; `npm run nuvio:merge:dry` le montre.
  NUVIO_MERGE_LEGACY_IDS: readBool('NUVIO_MERGE_LEGACY_IDS', true),
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
  // Journal JSONL de toutes les ecritures du hub. Les retraits y sont consignes avec
  // l'element retire, ce qui rend `npm run hub:undo` possible.
  HUB_JOURNAL: readBool('HUB_JOURNAL', true),
  HUB_JOURNAL_FILE: readEnv('HUB_JOURNAL_FILE', ''),

  // --- Simkl (tracker sans limite d'app connectee, integre nativement par Nuvio) ---
  SIMKL_BASE_URL: readEnv('SIMKL_BASE_URL', 'https://api.simkl.com'),
  SIMKL_CLIENT_ID: readEnv('SIMKL_CLIENT_ID', ''),
  // Le jeton Simkl n'expire pas: pas de client secret ni de refresh a gerer.
  SIMKL_TOKEN_FILE: readEnv('SIMKL_TOKEN_FILE', ''),
  SIMKL_PUSH_INTERVAL_MS: Number(readEnv('SIMKL_PUSH_INTERVAL_MS', 0)),
  // Renvoi des positions de lecture vers Simkl a chaque cycle du hub (il ne les garde
  // qu'une semaine, donc les repousser est ce qui les maintient en vie).
  SIMKL_SCROBBLE: readBool('SIMKL_SCROBBLE', true),
  // Simkl ne cree une session de reprise que sous ce pourcentage: au-dela il tient le
  // titre pour termine et n'affiche rien, meme si l'appel est accepte.
  SIMKL_RESUME_MAX_PERCENT: Number(readEnv('SIMKL_RESUME_MAX_PERCENT', 80)),

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
  // Nombre de segments peses pour estimer le debit d'une playlist, repartis sur toute sa
  // duree. Un encodage a debit variable rend un prelevement unique tres peu fiable (sur un
  // profil VBR simule: 26% d'erreur moyenne et 93% au 90e centile a 1 prelevement, contre
  // 13% et 21% a 5). Au-dela de 5-6 le gain devient marginal.
  PROBE_SEGMENT_SAMPLES: Number(readEnv('PROBE_SEGMENT_SAMPLES', 5)),
  // Proxy utilise en repli quand un CDN de hoster refuse l'acces direct. Meme valeur que
  // VITE_PROXY_BASE_URL cote site (ou l'URL du service bypass403): tous deux exposent
  // /proxy/<url> et posent les Origin/Referer attendus par domaine.
  PROBE_PROXY_BASE_URL: readEnv('PROBE_PROXY_BASE_URL', ''),
  // Budget global de la phase de mesure, pour UNE ouverture de fiche. Une sonde lente n'est
  // pas genante en soi: ce qui l'est, c'est qu'elle retarde la liste entiere. Passe ce
  // delai, les liens restants sont rendus sans debit (et remesures au prochain passage).
  // 0 = aucune limite.
  PROBE_PHASE_BUDGET_MS: Number(readEnv('PROBE_PHASE_BUDGET_MS', 9000)),
  // Mesures menees de front. Elles attendent surtout le reseau: plus large que l'extraction,
  // qui tape un service unique et n'a rien a gagner a etre bousculee.
  PROBE_CONCURRENCY: Number(readEnv('PROBE_CONCURRENCY', 10)),
  // Definition lue dans le flux par ffprobe, en DERNIER recours: beaucoup de playlists
  // n'annoncent aucune RESOLUTION (les flux KissKH, par exemple, s'affichaient donc avec
  // leur debit mais sans definition). ffprobe ne lit que l'entete du premier segment.
  // Ne se declenche que si ni la playlist ni le libelle du lien n'ont rien appris.
  PROBE_RESOLUTION: readBool('PROBE_RESOLUTION', true),
  PROBE_RESOLUTION_TIMEOUT_MS: Number(readEnv('PROBE_RESOLUTION_TIMEOUT_MS', 8000)),
  FFPROBE_PATH: readEnv('FFPROBE_PATH', 'ffprobe'),
  // Reponse en deux temps: delai au-dela duquel la liste part avec les debits deja mesures,
  // les sondes restantes continuant seules pour l'ouverture suivante. C'est ce qui separe
  // "la fiche s'ouvre" de "la fiche s'ouvre completement renseignee". 0 = tout attendre.
  STREAM_FIRST_ANSWER_MS: Number(readEnv('STREAM_FIRST_ANSWER_MS', 2500)),
  // Duree de vie d'une liste de streams. C'est elle qui decide au bout de combien de temps
  // un lien apparu depuis sera vu tout seul; la baisser rafraichit plus souvent, au prix
  // d'un scan complet a chaque fois.
  STREAM_TTL_MS: Number(readEnv('STREAM_TTL_MS', 30 * 60 * 1000)),
  // Rouvrir la meme fiche N fois en peu de temps vaut demande de nouveau scan: le
  // protocole Stremio n'a pas de bouton "recharger", ce geste est le seul signal
  // disponible. 0 desactive la detection.
  STREAM_REFRESH_HITS: Number(readEnv('STREAM_REFRESH_HITS', 3)),
  STREAM_REFRESH_WINDOW_MS: Number(readEnv('STREAM_REFRESH_WINDOW_MS', 25000)),
  // Prepare l'episode SUIVANT pendant qu'on regarde celui-ci: c'est la seule suite
  // previsible d'une ouverture de fiche, et elle ne coute qu'une resolution de plus.
  // Le delai laisse d'abord la fiche en cours finir ses propres mesures.
  PREFETCH_NEXT_EPISODE: readBool('PREFETCH_NEXT_EPISODE', true),
  PREFETCH_DELAY_MS: Number(readEnv('PREFETCH_DELAY_MS', 15000)),
  EXTRACT_CONCURRENCY: Number(readEnv('EXTRACT_CONCURRENCY', 6)),
  // Disjoncteur: apres N PANNES d'affilee (5xx, timeout), un hebergeur est mis de cote
  // pendant ce delai. Les refus portant sur une video precise (4xx) ne comptent pas.
  HOSTER_FAILURE_STREAK: Number(readEnv('HOSTER_FAILURE_STREAK', 3)),
  HOSTER_COOLDOWN_MS: Number(readEnv('HOSTER_COOLDOWN_MS', 120000)),

  // --- Lisibilite de la liste de streams -----------------------------------
  // "compact" (defaut) ecarte les liens redondants: ceux qu'un autre de la MEME source
  // surclasse a la fois en resolution et en debit, puis au-dela de MAX_STREAMS_PER_SOURCE.
  // "complet" propose TOUT ce qui a ete resolu, sans rien masquer.
  STREAM_LIST: readEnv('STREAM_LIST', 'compact').trim().toLowerCase(),
  // En mode compact: au plus N liens par source. Garder plus d'un preserve un repli quand
  // un hebergeur est en panne. 0 = pas de limite (l'elagage des redondants s'applique quand meme).
  MAX_STREAMS_PER_SOURCE: Number(readEnv('MAX_STREAMS_PER_SOURCE', 2)),

  // Sources activees (noms tels qu'exportes par src/sources/*.js).
  ENABLED_SOURCES: readList('ENABLED_SOURCES', null), // null = toutes

  // --- Addons (sources autonomes, hors Movix) ------------------------------
  // Ids tels qu'exportes par src/addons/*.js. null = tous ceux qui sont installes.
  ENABLED_ADDONS: readList('ENABLED_ADDONS', null),

  // Proxy de flux interne: c'est lui qui rejoue les en-tetes (Origin/Referer/UA...) que
  // les CDN de ces sources exigent et que Nuvio/Stremio ne savent pas poser eux-memes.
  // Le desactiver rend injouables tous les addons qui en dependent.
  STREAM_PROXY_ENABLED: readBool('STREAM_PROXY_ENABLED', true),
  // Secret de signature des URLs proxifiees. Sans lui, la route serait un relais HTTP
  // ouvert. Vide = secret aleatoire au demarrage: les liens deja distribues a Nuvio
  // cessent alors de fonctionner a chaque redemarrage.
  STREAM_PROXY_SECRET: readEnv('STREAM_PROXY_SECRET', ''),
  STREAM_PROXY_TIMEOUT_MS: Number(readEnv('STREAM_PROXY_TIMEOUT_MS', 20000)),
  // Journal de ce que le lecteur demande reellement (methode, Range, issue). Indispensable
  // quand un flux marche sur un appareil et pas sur un autre: les lecteurs ne sondent pas
  // de la meme facon. Verbeux -- a n'activer que le temps d'un diagnostic.
  STREAM_PROXY_LOG: readBool('STREAM_PROXY_LOG', false),

  // --- Aether (aether.bar -- serveurs aurora/lul/link/gallic) --------------
  AETHER_SITE_ORIGIN: readEnv('AETHER_SITE_ORIGIN', 'https://aether.bar'),
  AETHER_API_DOMAIN: readEnv('AETHER_API_DOMAIN', 'aether.cx'),
  AETHER_SERVERS: readList('AETHER_SERVERS', ['aurora', 'lul', 'link', 'gallic']),
  // Origin/Referer exiges par le CDN tiers du serveur "link".
  AETHER_LINK_ORIGIN: readEnv('AETHER_LINK_ORIGIN', 'https://nextgencloudfabric.com'),
  // Gallic n'est pas sur le domaine d'API des autres serveurs: il a sa propre base.
  AETHER_GALLIC_API: readEnv('AETHER_GALLIC_API', 'https://api.pope-walrus-spiffy.workers.dev'),
  // Aucune des API n'annonce la langue de la piste: on l'etiquette a la main pour que le
  // tri par PREFERRED_LANGS reste coherent. Gallic est la source VF du site, les autres
  // servent la version originale.
  AETHER_LANG: readEnv('AETHER_LANG', 'VO'),
  AETHER_GALLIC_LANG: readEnv('AETHER_GALLIC_LANG', 'VF'),

  // --- KissKH (dramas et films asiatiques) ----------------------------------
  // La piste audio est la version originale. Le libelle passe a VOSTFR quand la reponse
  // porte effectivement une piste de sous-titres francaise, VO sinon.
  KISSKH_LANG: readEnv('KISSKH_LANG', 'VO'),
  KISSKH_LANG_VOSTFR: readEnv('KISSKH_LANG_VOSTFR', 'VOSTFR'),

  // --- Obrigoz (obrigoz.com) ------------------------------------------------
  OBRIGOZ_BASE_URL: readEnv('OBRIGOZ_BASE_URL', 'https://obrigoz.com'),
  // Segment de chemin volatil du site (https://obrigoz.com/<prefix>/home/obrigoz).
  // A mettre a jour ici quand le site le fait tourner, sans toucher au code.
  OBRIGOZ_PATH_PREFIX: readEnv('OBRIGOZ_PATH_PREFIX', '2662df1'),
  OBRIGOZ_LANG: readEnv('OBRIGOZ_LANG', 'VF'),

  // --- Cinejoy (cinejoy.to -- canal scelle lumen-gate-v2 pilote via crush.wasm) ---
  // Aucune cle : la crypto est dans le wasm (src/addons/vendor/crush.wasm). Depuis un
  // serveur, le POST passe en fetch natif, sans curl-impersonate.
  CINEJOY_ENDPOINT: readEnv('CINEJOY_ENDPOINT', 'https://api.shegu.st/g'),
  CINEJOY_ORIGIN: readEnv('CINEJOY_ORIGIN', 'https://cinejoy.to'),
  CINEJOY_TIMEOUT_MS: Number(readEnv('CINEJOY_TIMEOUT_MS', '10000')),
  CINEJOY_LANG: readEnv('CINEJOY_LANG', 'VO'),

  // Langues de sous-titres proposees (codes ISO 639-2/B, ex: fre,eng).
  SUBTITLE_LANGS: readList('SUBTITLE_LANGS', ['fre', 'eng']),
  SUBTITLES_ENABLED: readBool('SUBTITLES_ENABLED', true),
  // Fournisseurs interroges, DANS L'ORDRE. La cascade se fait par langue: le second
  // n'est appele que pour les langues que le premier n'a pas fournies.
  //   vdrk           deja en WebVTT, indexe par id TMDB, sans cle
  //   opensubtitles  plus fourni sur les titres anciens, mais .gz + SRT + encodage devine
  SUBTITLE_PROVIDERS: readList('SUBTITLE_PROVIDERS', ['vdrk', 'opensubtitles']),
  VDRK_BASE_URL: readEnv('VDRK_BASE_URL', 'https://sub.vdrk.site'),
  // Origin/Referer attendus par l'index vdrk (le site qui l'utilise).
  VDRK_ORIGIN: readEnv('VDRK_ORIGIN', 'https://aether.bar'),
  // Pistes proposees par langue (les plus telechargees d'abord). Au-dela de 1, elles
  // portent toutes le meme nom de langue -- le protocole ne les distingue que par leur id.
  SUBTITLES_PER_LANG: Number(readEnv('SUBTITLES_PER_LANG', 1)),
  // Afficher "· OpenSubtitles" a cote de la langue. La specification prevoit qu'un libelle
  // libre soit affiche tel quel, mais Nuvio normalise ce champ et rend "inconnu" tout ce
  // qui n'est pas un code ISO 639-2. A n'activer que si ton lecteur suit la specification.
  SUBTITLE_PROVIDER_LABEL: readBool('SUBTITLE_PROVIDER_LABEL', false),

  // --- Calage automatique des sous-titres ----------------------------------
  // Les flux viennent de sources diverses, les sous-titres d'un index qui ne les connait
  // pas: rien ne garantit qu'ils decrivent le meme montage ni la meme cadence. L'addon
  // ecoute quelques fenetres du flux avec ffmpeg, compare les instants de parole a ceux
  // des repliques, et en deduit le decalage -- et la derive, quand la piste vient d'une
  // conversion PAL (25 im/s au lieu de 23,976: cinq minutes d'ecart en fin de film, que
  // le reglage de delai d'un lecteur ne rattrape pas).
  //
  // Sans ffmpeg installe, tout ceci se desactive tout seul et les pistes sont servies
  // telles quelles: aucune autre partie de l'addon n'en depend.
  SUBTITLE_AUTOSYNC: readBool('SUBTITLE_AUTOSYNC', true),
  FFMPEG_PATH: readEnv('FFMPEG_PATH', 'ffmpeg'),
  // Fenetres d'ecoute reparties dans le film, et leur duree. Il en faut aux DEUX bouts:
  // c'est l'ecart entre elles qui revele une derive. Moins de 3 rend le calage possible
  // mais peu sur; au-dela de 5 on paye du telechargement pour une precision deja atteinte.
  SUBTITLE_AUTOSYNC_WINDOWS: Number(readEnv('SUBTITLE_AUTOSYNC_WINDOWS', 6)),
  SUBTITLE_AUTOSYNC_WINDOW_SECONDS: Number(readEnv('SUBTITLE_AUTOSYNC_WINDOW_SECONDS', 90)),
  // Nombre MINIMAL de fenetres qui doivent s'accorder pour qu'un calage soit applique.
  // Deux ne demontrent rien: sur une recherche large, il existe toujours des paires de faux
  // sommets qui tombent d'accord par hasard. Mesure sur des films reels: un calage juste
  // rassemble 4 a 6 fenetres sur 6, un faux n'en rassemble jamais plus de deux.
  SUBTITLE_AUTOSYNC_MIN_WINDOWS: Number(readEnv('SUBTITLE_AUTOSYNC_MIN_WINDOWS', 3)),
  // Etendue minimale, en fraction du film, entre la premiere et la derniere fenetre qui
  // s'accordent. Un calage verifie sur les deux premiers tiers seulement n'est pas "un peu
  // moins sur": il est faux dans le tiers restant. C'est la signature d'un montage
  // different (version longue, coupure), qu'aucune correction affine ne peut decrire.
  SUBTITLE_AUTOSYNC_MIN_REACH: Number(readEnv('SUBTITLE_AUTOSYNC_MIN_REACH', 0.6)),
  // Fenetres ecoutees en parallele. Chacune ouvre un ffmpeg et tire des segments: monter
  // ce nombre accelere le calage et charge d'autant le CDN (et le disjoncteur des hosters).
  SUBTITLE_AUTOSYNC_CONCURRENCY: Number(readEnv('SUBTITLE_AUTOSYNC_CONCURRENCY', 2)),
  SUBTITLE_AUTOSYNC_WINDOW_TIMEOUT_MS: Number(readEnv('SUBTITLE_AUTOSYNC_WINDOW_TIMEOUT_MS', 60000)),
  // Decalage maximal cherche. Au-dela, ce n'est plus un decalage: c'est une autre piste.
  SUBTITLE_AUTOSYNC_MAX_SHIFT: Number(readEnv('SUBTITLE_AUTOSYNC_MAX_SHIFT', 120)),
  // Chercher aussi une DERIVE de cadence (conversion PAL), en plus du decalage constant.
  // A laisser actif: cela ne coute que du calcul, et une derive non corrigee est le seul
  // defaut qu'un reglage de delai ne rattrape pas. A couper si l'on ne rencontre jamais que
  // des decalages constants et qu'on prefere ecarter tout risque de derive inventee.
  SUBTITLE_AUTOSYNC_DRIFT: readBool('SUBTITLE_AUTOSYNC_DRIFT', true),
  // De combien une derive doit l'emporter sur "aucune derive" pour etre retenue. Une derive
  // est une affirmation forte -- elle deplace la fin du film de plusieurs minutes -- donc a
  // qualite comparable le modele qui n'affirme rien gagne.
  SUBTITLE_AUTOSYNC_DRIFT_MARGIN: Number(readEnv('SUBTITLE_AUTOSYNC_DRIFT_MARGIN', 0.25)),
  // Combien de fois la dispersion des mesures une derive doit representer pour etre affirmee.
  // Une derive de 0,1 % sur un episode de 45 min vaut 2,7 s en tout: si les fenetres se
  // dispersent deja de 3 s, ce n'est pas une mesure mais du bruit ajuste. Une vraie
  // conversion PAL deplace la fin du film de plusieurs minutes et passe sans difficulte.
  SUBTITLE_AUTOSYNC_DRIFT_EVIDENCE: Number(readEnv('SUBTITLE_AUTOSYNC_DRIFT_EVIDENCE', 3)),
  // Seuil de confiance. EN DESSOUS, LA PISTE EST SERVIE TELLE QUELLE -- c'est voulu: un
  // calage approximatif est pire que pas de calage, il est faux partout au lieu d'etre faux
  // d'une quantite constante, que l'oeil corrige tout seul.
  //
  // Calibre sur de l'audio de FILM, pas sur un signal de laboratoire: la musique et les
  // ambiances y sont continues, une correlation juste y vaut 0,3-0,5 la ou un signal propre
  // donne 0,8. Sur deux longs-metrages de reference, un calage juste sort a 0,40-0,42, et
  // les faux calages fabriques pour l'occasion (sous-titres d'un autre film) plafonnent a
  // 0,16 -- d'ou ce seuil, place entre les deux.
  SUBTITLE_AUTOSYNC_MIN_CONFIDENCE: Number(readEnv('SUBTITLE_AUTOSYNC_MIN_CONFIDENCE', 0.2)),
  // Seuil abaisse quand DEUX pistes du meme titre (le francais et l'anglais, par exemple),
  // calees separement sur le meme flux, tombent sur la MEME correspondance a une demi-
  // seconde pres d'un bout a l'autre du film. Ce sont deux fichiers differents, traduits
  // differemment: qu'ils se trompent tous les deux au meme endroit ne s'explique pas. Sur
  // le banc d'essai, cet accord ne s'est jamais produit entre pistes d'un AUTRE titre.
  SUBTITLE_AUTOSYNC_MIN_CONFIDENCE_PAIR: Number(readEnv('SUBTITLE_AUTOSYNC_MIN_CONFIDENCE_PAIR', 0.08)),
  // Ecart tolere entre les deux correspondances pour parler d'accord, aux deux bouts du film.
  SUBTITLE_AUTOSYNC_PAIR_TOLERANCE: Number(readEnv('SUBTITLE_AUTOSYNC_PAIR_TOLERANCE', 0.5)),
  // Part maximale de repliques dont les deux pistes partagent le minutage pour qu'on les
  // considere INDEPENDANTES. Au-dela, ce sont deux traductions du meme fichier de temps:
  // elles donnent la meme mesure, et leur accord ne demontre rien. Mesure sur douze paires
  // reelles: pistes ecrites separement 0-26 %, pistes issues du meme minutage 79-92 %.
  SUBTITLE_AUTOSYNC_PAIR_MAX_SHARED: Number(readEnv('SUBTITLE_AUTOSYNC_PAIR_MAX_SHARED', 0.4)),
  // Pistes trop courtes pour porter une correlation (chansons, pancartes).
  SUBTITLE_AUTOSYNC_MIN_CUES: Number(readEnv('SUBTITLE_AUTOSYNC_MIN_CUES', 60)),
  // Un calage trouve reste valable tant que la source sert le meme release: on le garde
  // une semaine, pour que reprendre une serie demain ne le repaye pas.
  SUBTITLE_AUTOSYNC_TTL_MS: Number(readEnv('SUBTITLE_AUTOSYNC_TTL_MS', 7 * 24 * 60 * 60 * 1000)),
  // Delai que la route /subtitle accepte d'attendre quand le calage n'est pas encore pret.
  // Au-dela elle sert la piste brute: un lecteur qui attend une minute abandonne.
  SUBTITLE_AUTOSYNC_WAIT_MS: Number(readEnv('SUBTITLE_AUTOSYNC_WAIT_MS', 20000)),
  // Lancer le calage en arriere-plan des l'affichage de la liste des flux, pour les N
  // premiers. Quand on ouvre le menu des sous-titres, le travail est deja fait.
  SUBTITLE_AUTOSYNC_PREFETCH: Number(readEnv('SUBTITLE_AUTOSYNC_PREFETCH', 1)),
  // Comment l'addon identifie le flux a caler:
  //   playback  observe: le proxy de flux vient de servir la playlist du flux choisi, donc
  //             on sait lequel c'est. Sans risque, mais aveugle aux liens qui ne passent
  //             pas par le proxy (extraction directe) -- ceux-la ne sont pas cales.
  //   stream    les pistes sont rattachees a CHAQUE flux (`stream.subtitles`): identification
  //             exacte, y compris hors proxy. Suppose que le lecteur lise ces pistes-la, et
  //             elles peuvent apparaitre EN DOUBLE avec celles de la ressource `subtitles`.
  //   both      les deux, pour les lecteurs qui ignorent l'une ou l'autre.
  SUBTITLE_AUTOSYNC_BIND: readEnv('SUBTITLE_AUTOSYNC_BIND', 'playback').trim().toLowerCase(),
  // Delai au-dela duquel un flux servi par le proxy n'est plus considere comme "en cours".
  SUBTITLE_AUTOSYNC_PLAYBACK_WINDOW_MS: Number(readEnv('SUBTITLE_AUTOSYNC_PLAYBACK_WINDOW_MS', 30 * 60 * 1000)),
  // Caler d'apres le flux le MIEUX CLASSE quand aucun n'a ete observe (lien hors proxy).
  // Desactive par defaut: se tromper de release applique un decalage faux partout, ce qui
  // est plus penible a rattraper que l'absence de calage.
  SUBTITLE_AUTOSYNC_GUESS_STREAM: readBool('SUBTITLE_AUTOSYNC_GUESS_STREAM', false),

  // Motifs de detection supplementaires, au format "hebergeur:motif" (regex, insensible a
  // la casse). Voe renouvelle ses domaines de sortie environ tous les mois, avec des noms
  // qui ne contiennent pas "voe": un domaine plus recent que la liste integree passe pour
  // "sans extracteur" alors qu'il est parfaitement extractible. C'est le pendant des
  // "hosters custom & regex" du site.
  //   HOSTER_PATTERNS_EXTRA=voe:bysebuho,voe:playmogo
  HOSTER_PATTERNS_EXTRA: readList('HOSTER_PATTERNS_EXTRA', []),

  // Quand un embed n'a pas d'extracteur (vidara.to, lecteurvideo.com...), proposer quand meme
  // le lien en "ouvrir dans le navigateur" au lieu de le jeter. Bruyant -> desactive par defaut.
  SHOW_UNPLAYABLE_EMBEDS: readBool('SHOW_UNPLAYABLE_EMBEDS', false),

  CACHE_TTL_MS: Number(readEnv('CACHE_TTL_MS', 30 * 60 * 1000)),
  // Le cache survit au redemarrage: sans ca, un `npm start` fait repayer a la premiere
  // ouverture de chaque fiche le scraping, l'extraction et la mesure de debit.
  CACHE_PERSIST: readBool('CACHE_PERSIST', true),
  CACHE_FILE: readEnv('CACHE_FILE', ''),
  CACHE_SAVE_INTERVAL_MS: Number(readEnv('CACHE_SAVE_INTERVAL_MS', 60000)),
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

// Un mode inconnu retomberait silencieusement sur "compact" et donnerait l'impression que
// le reglage ne sert a rien: mieux vaut le dire.
const STREAM_LIST_MODES = ['compact', 'complet'];
if (!STREAM_LIST_MODES.includes(config.STREAM_LIST)) {
  console.warn(
    `[config] STREAM_LIST="${config.STREAM_LIST}" inconnu (attendu: ${STREAM_LIST_MODES.join(' ou ')}) -- "compact" applique`,
  );
  config.STREAM_LIST = 'compact';
}

// Un fournisseur de sous-titres inconnu serait ignore en silence, et la liste paraitrait
// simplement vide sur les titres que l'autre ne couvre pas.
const SUBTITLE_PROVIDER_IDS = ['vdrk', 'opensubtitles'];
const unknownProviders = config.SUBTITLE_PROVIDERS.filter(
  (id) => !SUBTITLE_PROVIDER_IDS.includes(String(id).toLowerCase()),
);
if (unknownProviders.length > 0) {
  console.warn(
    `[config] SUBTITLE_PROVIDERS: "${unknownProviders.join(', ')}" inconnu(s) ` +
      `(attendu: ${SUBTITLE_PROVIDER_IDS.join(', ')}) -- ignore(s)`,
  );
}
if (config.SUBTITLES_ENABLED && config.SUBTITLE_PROVIDERS.length === unknownProviders.length) {
  console.warn('[config] aucun fournisseur de sous-titres valide -- la liste sera vide');
}

const ID_FORMATS = ['imdb', 'tmdb'];
if (!ID_FORMATS.includes(config.ID_FORMAT)) {
  console.warn(`[config] ID_FORMAT="${config.ID_FORMAT}" inconnu (attendu: imdb ou tmdb) -- "imdb" applique`);
  config.ID_FORMAT = 'imdb';
}

// NUVIO_ID_PREFERENCE ne pilotait que le push direct, pas le hub ni les ids servis:
// trois endroits, deux formats, d'ou les doublons. ID_FORMAT gouverne les trois.
if (process.env.NUVIO_ID_PREFERENCE !== undefined) {
  console.warn(
    `[config] NUVIO_ID_PREFERENCE est remplace par ID_FORMAT (=${config.ID_FORMAT}), qui vaut aussi ` +
      "pour les ids servis par l'addon. Retire-le du .env; `npm run nuvio:merge:dry` montre ce qu'il reste a aligner.",
  );
}

// PRUNE_DOMINATED a ete remplace par STREAM_LIST. Le signaler plutot que de l'ignorer: un
// .env qui contredit le code sans rien dire est exactement ce qui coute des heures.
if (process.env.PRUNE_DOMINATED !== undefined) {
  const equivalent = /^(1|true|yes|on)$/i.test(process.env.PRUNE_DOMINATED) ? 'compact' : 'complet';
  console.warn(
    `[config] PRUNE_DOMINATED n'existe plus -- remplace-le par STREAM_LIST=${equivalent} dans ton .env`,
  );
}

/** Tous les liens resolus sont proposes, sans elagage. */
config.keepAllStreams = () => config.STREAM_LIST === 'complet';

module.exports = config;
