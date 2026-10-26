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
  SPOOFED_ORIGIN: readEnv('SPOOFED_ORIGIN', 'https://movix.fun'),
  VIP_ACCESS_KEY: readEnv('VIP_ACCESS_KEY', ''),

  // --- Resolution serveur des flux (`?resolve=1`) ---------------------------
  // C'est DESORMAIS LA SEULE facon d'obtenir une URL de flux pour la plupart des
  // hebergeurs. Movix a ferme ses endpoints d'extraction publics: `/api/extract-*` sur
  // proxiesembed exige une cle interne que seul son backend detient, et il n'existe plus
  // aucune route "extrais-moi cette URL". A la place, les routes catalogue resolvent
  // elles-memes quand on leur passe `resolve=1` ET une cle VIP valide, et rendent des
  // m3u8 deja proxifiees et signees, jouables telles quelles.
  //
  // Sans VIP_ACCESS_KEY, l'addon ne peut extraire que voe, veev, darkibox, oneupload et sharecloudy, qu'il
  // sait lire seul. Ce reglage n'existe que pour desactiver la demande (diagnostic,
  // comparaison): il n'y a aucune raison de le couper en usage normal.
  MOVIX_RESOLVE: readBool('MOVIX_RESOLVE', true),

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
  // Rangee "Recommandé par Trakt" alimentee par l'algorithme Trakt.
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
  // Au-dela, les lignes sont effacees (au demarrage, puis une fois par jour). 0 = tout garder.
  // Un retrait plus vieux que ca ne peut plus etre annule par `hub:undo`.
  HUB_JOURNAL_RETENTION_DAYS: Number(readEnv('HUB_JOURNAL_RETENTION_DAYS', 30)),

  // --- Simkl (tracker sans limite d'app connectee, integre nativement par Nuvio) ---
  SIMKL_BASE_URL: readEnv('SIMKL_BASE_URL', 'https://api.simkl.com'),
  SIMKL_CLIENT_ID: readEnv('SIMKL_CLIENT_ID', ''),
  // Sortie des appels Simkl (et d'eux seuls) par un proxy, typiquement le SOCKS5 du
  // conteneur nas-tunnel: `socks5h://nas-tunnel:1080`. Le `h` fait resoudre le DNS par le
  // proxy. Utile quand Simkl bloque l'IP du serveur; aucun repli en direct si le proxy
  // tombe, sans quoi on retaperait sur le blocage.
  SIMKL_PROXY_URL: readEnv('SIMKL_PROXY_URL', ''),
  // Le jeton Simkl n'expire pas: pas de client secret ni de refresh a gerer.
  SIMKL_TOKEN_FILE: readEnv('SIMKL_TOKEN_FILE', ''),
  SIMKL_PUSH_INTERVAL_MS: Number(readEnv('SIMKL_PUSH_INTERVAL_MS', 0)),
  // Delai minimal entre deux lectures de Simkl par le hub. Chaque lecture commence par
  // `/sync/activities` et ne telecharge rien si rien n'a bouge; la doc Simkl demande
  // 15-30 min entre deux verifications pour une app qui tourne en fond, et suspend sans
  // preavis les `client_id` qui interrogent `/sync/all-items` en boucle. Plancher a 5 min.
  // Les ECRITURES vers Simkl, elles, partent a chaque cycle du hub.
  SIMKL_POLL_INTERVAL_MS: Math.max(Number(readEnv('SIMKL_POLL_INTERVAL_MS', 15 * 60 * 1000)), 5 * 60 * 1000),
  // Envoi des positions de lecture vers Simkl (`/scrobble/pause`), uniquement quand elles
  // different de ce que Simkl a deja enregistre.
  SIMKL_SCROBBLE: readBool('SIMKL_SCROBBLE', true),
  // Positions envoyees au plus par cycle: Simkl accepte 1 POST/s et verrouille chaque
  // utilisateur le temps d'une ecriture. Le reste part aux cycles suivants.
  SIMKL_SCROBBLE_MAX_PER_CYCLE: Math.max(Number(readEnv('SIMKL_SCROBBLE_MAX_PER_CYCLE', 5)), 1),
  // Simkl ne cree une session de reprise que sous ce pourcentage: au-dela il tient le
  // titre pour termine et n'affiche rien, meme si l'appel est accepte.
  SIMKL_RESUME_MAX_PERCENT: Number(readEnv('SIMKL_RESUME_MAX_PERCENT', 80)),

  // Rangee de recommandations calculees localement depuis l'historique Movix (sans compte tiers).
  LOCAL_RECOMMENDATIONS: readBool('LOCAL_RECOMMENDATIONS', true),

  // --- TV en direct --------------------------------------------------------
  // Movix expose depuis peu un triplet manifest/catalog/stream deja au format Stremio
  // (`/api/livetv/...`), alimente par Vavoo (HLS gratuit), une playlist M3U locale, du
  // Xtream reserve aux VIP, et des lecteurs en iframe (NorthLive, rencontres sportives)
  // qu'aucun lecteur video ne sait ouvrir. L'addon relaie les premiers et ecarte les
  // seconds. Ajoute le type `tv` au manifest: le desactiver le retire entierement.
  LIVETV_ENABLED: readBool('LIVETV_ENABLED', false),
  // Catalogues retenus, tels que Movix les nomme (`vavoo_france`, `northlive_sport`...).
  // Vide = tous ceux qu'il annonce -- ce qui fait beaucoup de rangees, une par pays.
  LIVETV_CATALOGS: readList('LIVETV_CATALOGS', null),

  // --- Playlist IPTV ---------------------------------------------------------
  // Les memes chaines, mais pour un LECTEUR IPTV plutot que pour Nuvio: tous les flux
  // d'une chaine (Vavoo, IPTV VIP, playlists tierces) fusionnes en une entree, servis en
  // M3U et en API Xtream, avec le guide des programmes. Independant de LIVETV_ENABLED.
  IPTV_ENABLED: readBool('IPTV_ENABLED', false),
  // Jeton d'acces, porte par l'URL (M3U) ou en mot de passe (Xtream). Obligatoire: ces
  // routes donnent acces aux flux VIP du compte. `openssl rand -hex 16`.
  IPTV_TOKEN: readEnv('IPTV_TOKEN', ''),
  // Groupes Vavoo lus, tels que Movix les nomme sans le prefixe `vavoo_`. `none` = aucun.
  IPTV_VAVOO_GROUPS: readList('IPTV_VAVOO_GROUPS', ['france', 'france-sport']).filter((g) => g !== 'none'),
  // Categories du bouquet IPTV (VIP) retenues, par prefixe (`FR | KIDS TV`). `*` = toutes
  // (167 categories, surtout arabophones), `none` = aucune.
  IPTV_XTREAM_PREFIXES: readList('IPTV_XTREAM_PREFIXES', ['FR']).filter((p) => p !== 'none'),
  // Playlists M3U tierces a fusionner: `Nom|https://.../liste.m3u|PREFIXE`, separees par
  // des virgules. Le prefixe (optionnel) filtre sur `group-title` ou sur le nom.
  IPTV_EXTRA_M3U: readList('IPTV_EXTRA_M3U', []),
  // Ordre de preference des sources.
  IPTV_SOURCE_ORDER: readList('IPTV_SOURCE_ORDER', ['xtream', 'vavoo', 'm3u']),
  // Ce qui classe les flux d'une chaine: `source` = la source preferee d'abord (l'IPTV
  // VIP, plus stable, passe devant un Vavoo mieux defini), `quality` = la meilleure
  // definition d'abord, la source ne departageant que les ex aequo.
  IPTV_RANK_BY: /^quality$/i.test(readEnv('IPTV_RANK_BY', 'source')) ? 'quality' : 'source',
  // Sert un master HLS a plusieurs variantes (une par definition disponible) au lieu
  // d'une redirection: le lecteur affiche alors un choix de qualite. Contrepartie: un
  // lecteur a debit adaptatif peut changer de variante -- donc de fournisseur -- seul.
  IPTV_VARIANTS: readBool('IPTV_VARIANTS', false),
  // Ronde de sante: teste tous les flux en tache de fond et mesure leur definition reelle
  // (ffprobe). 0 = pas de ronde, les flux ne sont testes qu'au zap.
  IPTV_SWEEP_MS: Number(readEnv('IPTV_SWEEP_MS', 6 * 60 * 60 * 1000)),
  IPTV_SWEEP_CONCURRENCY: Number(readEnv('IPTV_SWEEP_CONCURRENCY', 3)),
  // Retire de la playlist une chaine dont aucun flux ne repond depuis deux rondes (hors
  // sport et canaux evenementiels, eteints par nature hors antenne).
  IPTV_HIDE_DEAD: readBool('IPTV_HIDE_DEAD', true),
  // Definition maximale preferee (hauteur: 2160, 1080, 720). Les flux au-dessus passent
  // en dernier recours -- utile quand l'appareil peine sur la 4K HEVC. 0 = pas de plafond.
  IPTV_MAX_QUALITY: Number(readEnv('IPTV_MAX_QUALITY', 0)),
  // Guide des programmes (XMLTV, .xml ou .xml.gz). Vide = pas de guide.
  IPTV_EPG_URL: readEnv('IPTV_EPG_URL', 'https://xmltvfr.fr/xmltv/xmltv_fr.xml.gz'),
  IPTV_EPG_REFRESH_MS: Number(readEnv('IPTV_EPG_REFRESH_MS', 12 * 60 * 60 * 1000)),
  // Relecture des sources (nouvelles chaines, flux retires).
  IPTV_REFRESH_MS: Number(readEnv('IPTV_REFRESH_MS', 60 * 60 * 1000)),
  // Teste les flux au moment de zapper et bascule sur le suivant si le meilleur est mort.
  // Desactive, la chaine redirige toujours vers son premier flux, sans verification.
  IPTV_CHECK_STREAMS: readBool('IPTV_CHECK_STREAMS', true),
  IPTV_CHECK_TIMEOUT_MS: Number(readEnv('IPTV_CHECK_TIMEOUT_MS', 4000)),
  // Patience au zap pour un flux IPTV: le bouquet demarre ses chaines a la demande, et une
  // chaine froide met 3 a 11 s a repondre. Passe ce delai, on bascule sur le flux suivant.
  IPTV_XTREAM_WAIT_MS: Number(readEnv('IPTV_XTREAM_WAIT_MS', 6000)),
  // Journalise le flux retenu a chaque zap.
  IPTV_LOG: readBool('IPTV_LOG', false),

  // --- Catalogues ---
  // Rangees integrees affichees, dans l'ordre. Vide = l'ordre par defaut.
  // Pour renommer une rangee ou en creer de nouvelles, utiliser catalogs.json.
  CATALOGS: readList('CATALOGS', null),
  CATALOGS_FILE: readEnv('CATALOGS_FILE', ''),
  // Mise en page de l'accueil (dedoublonnage entre rangees, ordre du profil) refaite au
  // plus tard tous les combien. Un titre regarde entre-temps peut y rester jusque-la.
  CATALOG_REFRESH_MS: Number(readEnv('CATALOG_REFRESH_MS', 6 * 60 * 60 * 1000)),

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
  // Proxy utilise en repli quand un CDN de hoster refuse l'acces direct a la SONDE.
  // Attention: le `/proxy` de Movix n'est plus utilisable ici (il exige une signature
  // HMAC), et le micro-service bypass403 a ete supprime de l'amont. Ne reste donc qu'un
  // proxy generique a soi, exposant /proxy/<url>. Vide = pas de repli.
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
  // Definition minimale proposee (hauteur du palier: 720 ecarte 480p et moins). Un lien
  // dont la definition est inconnue reste propose. 0 = aucun plancher.
  MIN_STREAM_QUALITY: Number(readEnv('MIN_STREAM_QUALITY', 720)),
  // Sous-addons par langue (/vf, /vostfr, /vo): l'addon principal ne rend alors plus de
  // streams, pour ne pas doubler la liste. A n'activer qu'une fois les trois installes.
  STREAM_SPLIT_BY_LANG: readBool('STREAM_SPLIT_BY_LANG', false),

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

  // --- Aether (aether.ist -- serveurs aurora/love/lul/link/gallic) ---------
  // Domaines tournants: les a-jour sont listes sur https://rentry.co/aetherdomains.
  AETHER_SITE_ORIGIN: readEnv('AETHER_SITE_ORIGIN', 'https://aether.ist'),
  AETHER_API_DOMAIN: readEnv('AETHER_API_DOMAIN', 'raccoonunbutteredbagel.zip'),
  AETHER_SERVERS: readList('AETHER_SERVERS', ['aurora', 'love', 'lul', 'link', 'gallic']),
  // Origin/Referer exiges par le CDN tiers du serveur "link".
  AETHER_LINK_ORIGIN: readEnv('AETHER_LINK_ORIGIN', 'https://nextgencloudfabric.com'),
  // Gallic n'est pas sur le domaine d'API des autres serveurs: il a sa propre base.
  AETHER_GALLIC_API: readEnv('AETHER_GALLIC_API', 'https://api.subl2cw8mg.workers.dev'),
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

  // --- Obrigoz (domaine tournant) -------------------------------------------
  // URL de la page d'accueil, telle que le navigateur l'affiche: domaine, prefixe et nom du
  // site en changent, tout se deduit d'elle (cf. src/addons/obrigoz.js).
  OBRIGOZ_URL: readEnv('OBRIGOZ_URL', 'https://dokimov.com/174e409/home/dokimov'),
  OBRIGOZ_LANG: readEnv('OBRIGOZ_LANG', 'VF'),

  // --- Cinejoy (cinejoy.to -- canal scelle lumen-gate-v2 pilote via crush.wasm) ---
  // Aucune cle : la crypto est dans le wasm (src/addons/vendor/crush.wasm). Depuis un
  // serveur, le POST passe en fetch natif, sans curl-impersonate.
  CINEJOY_ENDPOINT: readEnv('CINEJOY_ENDPOINT', 'https://api.wing.st/g'),
  CINEJOY_ORIGIN: readEnv('CINEJOY_ORIGIN', 'https://cinejoy.pk'),
  // Serveurs interroges (`Lisbon,Nebula,...`). Vide = ceux que `/servers` annonce `ok`.
  CINEJOY_SERVERS: readList('CINEJOY_SERVERS', null),
  CINEJOY_TIMEOUT_MS: Number(readEnv('CINEJOY_TIMEOUT_MS', '10000')),
  CINEJOY_LANG: readEnv('CINEJOY_LANG', 'VO'),

  // --- Movy (movy.sx -- API api.wecollege.net, reponses chiffrees enc=2) ---------
  MOVY_API: readEnv('MOVY_API', 'https://api.wecollege.net'),
  MOVY_ORIGIN: readEnv('MOVY_ORIGIN', 'https://www.movy.sx'),
  // Serveurs du site interroges en parallele; miami et boise sont ceux qui montent au 4K.
  MOVY_SERVERS: readList('MOVY_SERVERS', ['miami', 'boise']),
  // Cloudflare refuse l'IP du VPS sur l'API: SOCKS5 du tunnel NAS (seed + sources seulement).
  MOVY_PROXY_URL: readEnv('MOVY_PROXY_URL', ''),
  MOVY_TIMEOUT_MS: Number(readEnv('MOVY_TIMEOUT_MS', '10000')),
  MOVY_LANG: readEnv('MOVY_LANG', 'VO'),

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
  VDRK_ORIGIN: readEnv('VDRK_ORIGIN', 'https://aether.ist'),
  // Pistes proposees par langue (les plus telechargees d'abord). Au-dela de 1, elles
  // portent toutes le meme nom de langue -- le protocole ne les distingue que par leur id.
  SUBTITLES_PER_LANG: Number(readEnv('SUBTITLES_PER_LANG', 1)),
  // Afficher "· OpenSubtitles" a cote de la langue. La specification prevoit qu'un libelle
  // libre soit affiche tel quel, mais Nuvio normalise ce champ et rend "inconnu" tout ce
  // qui n'est pas un code ISO 639-2. A n'activer que si ton lecteur suit la specification.
  SUBTITLE_PROVIDER_LABEL: readBool('SUBTITLE_PROVIDER_LABEL', false),

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

  // --- WebUI (/ui) ------------------------------------------------------------
  // Tableau de bord: sante, testeur de titre, synchro/trackers, logs en direct. Elle peut
  // DECLENCHER des ecritures (push, restauration du hub, autorisations): si l'addon est
  // expose, la proteger -- par WEBUI_PASSWORD, ou au reverse proxy sur le prefixe /ui.
  WEBUI_ENABLED: readBool('WEBUI_ENABLED', true),
  // Vide = pas d'authentification integree. Sinon, HTTP Basic (utilisateur au choix).
  WEBUI_PASSWORD: readEnv('WEBUI_PASSWORD', ''),
  // Lignes de console gardees en memoire pour la page Logs.
  WEBUI_LOG_LINES: Number(readEnv('WEBUI_LOG_LINES', 2000)),
};

// Icone de l'addon. Derivee de SPOOFED_ORIGIN par defaut pour suivre automatiquement
// les changements de domaine du site (.cash -> .fun -> ...) sans edition de code.
config.LOGO_URL = readEnv('LOGO_URL', `${config.SPOOFED_ORIGIN.replace(/\/+$/, '')}/favicon.ico`);

if (!config.MAIN_API_BASE_URL) console.warn('[config] MAIN_API_BASE_URL manquant -- voir .env.example');
if (!config.VIP_ACCESS_KEY) {
  console.warn(
    '[config] VIP_ACCESS_KEY manquant -- Movix ne resoudra AUCUN flux. Seuls voe, veev, darkibox, ' +
      "oneupload et sharecloudy restent extractibles (l'addon les lit lui-meme); toutes les autres sources " +
      'ne rendront que des liens injouables.',
  );
} else if (!config.MOVIX_RESOLVE) {
  console.warn('[config] MOVIX_RESOLVE=false -- la resolution serveur est desactivee malgre une cle VIP presente');
}
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

// PROXIES_EMBED_BASE_URL ne sert plus a rien: les routes d'extraction de proxiesembed
// exigent une cle interne reservee au backend Movix, et ses routes de proxy n'acceptent
// plus qu'une URL signee en HMAC. L'addon ne l'appelle donc plus jamais en direct -- il
// ne fait que SUIVRE les URLs signees que Mainapi lui rend.
if (process.env.PROXIES_EMBED_BASE_URL !== undefined) {
  console.warn(
    "[config] PROXIES_EMBED_BASE_URL n'est plus utilise -- proxiesembed n'accepte plus " +
      "d'appel direct (cle interne + signature HMAC). Retire-le du .env.",
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
