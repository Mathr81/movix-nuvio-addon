# Rapport — Publier l'addon pour que n'importe qui puisse l'utiliser avec ses propres identifiants

*Analyse du dépôt au commit `bd7305c` (26/09/2026). Aucun code n'a été modifié : ce document
est uniquement un état des lieux et une proposition de chemin.*

---

## 1. Verdict en bref

**Oui, c'est techniquement possible.** Mais il y a deux façons très différentes de le faire,
et leur coût n'a rien à voir :

| Option | Ce que fait l'utilisateur | Effort estimé | Risques |
|---|---|---|---|
| **A. Kit auto-hébergé** (chacun lance sa propre instance) | `docker compose up`, puis il remplit un formulaire web au premier démarrage | **Faible : 2 à 4 jours** | Faibles : chacun a son serveur, son IP, ses clés |
| **B. Service hébergé multi-comptes** (une instance, N utilisateurs) | Il va sur une page, entre ses identifiants, clique « Installer » | **Élevé : 4 à 7 semaines** pour une version fiable | Élevés : secrets de tiers stockés chez toi, IP unique face à Movix/Simkl, bande passante, juridique |
| C. Configuration encodée dans l'URL (sans état) | Il remplit un formulaire, l'URL du manifest contient ses clés | Moyen : 1 à 2 semaines | Secrets en clair dans l'URL, et **le hub de synchro est impossible** dans ce modèle |

**Recommandation : option A d'abord.** Elle couvre 90 % du besoin (« les gens n'ont qu'à entrer
leurs identifiants ») pour une fraction du travail et sans t'exposer. L'option B n'a de sens
que si tu veux vraiment opérer un service pour d'autres, ce qui pose des problèmes qui ne
sont pas techniques (voir §6).

Le point le plus limitant n'est pas le code : c'est la **clé VIP Movix**. Sans elle, presque
aucun flux n'est jouable (voir §3.1), et elle est personnelle. Chaque utilisateur doit donc
avoir **sa propre** clé VIP — sinon l'addon « public » reposerait sur la tienne.

---

## 2. Pourquoi ça ne marche aujourd'hui qu'avec ton compte

Tout le code lit ses identifiants dans un **objet `config` unique, chargé une fois au
démarrage depuis `.env`** (`src/core/config.js`). Chaque module s'en sert directement, et
plusieurs gardent en plus un état **au niveau du module** (variables `let` globales). Il n'y
a nulle part la notion de « l'utilisateur courant ».

### 2.1 Identifiants propres à un compte

| Identifiant | Rôle | Lu dans |
|---|---|---|
| `VIP_ACCESS_KEY` | Résolution serveur des m3u8 par Movix (`?resolve=1`), TV IPTV/Streamed | `integrations/movixClient.js:30` (en-tête injecté dans **toutes** les requêtes Mainapi), `sources/resolved.js:40`, `livetv/index.js:228` |
| `MOVIX_JWT`, `MOVIX_USER_ID`, `MOVIX_USER_TYPE`, `MOVIX_PROFILE_ID` | Lecture/écriture de ta liste, favoris, historique, progression Movix | `integrations/movixSync.js`, `server.js:211-240`, `manifest.js:5`, `hub/index.js:265` |
| `NUVIO_EMAIL`, `NUVIO_PASSWORD`, `NUVIO_PROFILE_INDEX` | Connexion à Nuvio Sync (Supabase) | `integrations/nuvioCloud.js:56`, `nuvioPush.js`, `hub/index.js:53` |
| Jeton Simkl (fichier `.simkl-token.json`) | Historique/listes Simkl | `integrations/simklCloud.js:34` — **un seul fichier jeton** |
| Jetons Trakt (fichier `.trakt-token.json`) | Push Trakt + recommandations | `integrations/traktCloud.js:19` — **un seul fichier jeton** |
| `SIMKL_CLIENT_ID`, `TRAKT_CLIENT_ID/SECRET`, `TMDB_API_KEY` | Clés **d'application** (pas d'utilisateur) | Partageables : c'est le cas normal d'une app OAuth |

### 2.2 État global en mémoire qui suppose un seul utilisateur

| Module | État global | Problème en multi-utilisateurs |
|---|---|---|
| `integrations/movixSync.js:50` | `resolvedProfileId` | Le profil Movix d'un utilisateur serait écrasé par celui du suivant → **écritures dans le mauvais compte** |
| `integrations/movixSync.js` | clé de cache `'sync:data'` | Tout le monde verrait **la liste du premier** qui a rempli le cache |
| `integrations/nuvioCloud.js:35` | `session` (jetons Supabase) | Une seule session Nuvio pour tout le process |
| `integrations/simklCloud.js:55-115` | `token`, `pausedUntil`, file d'attente, espacement des POST | Jeton unique ; une pause Simkl d'un utilisateur bloquerait tous les autres |
| `integrations/simklLibrary.js:48` | `store` (copie locale de la bibliothèque Simkl) | Unique |
| `integrations/traktCloud.js:35` | `tokens` | Unique |
| `hub/index.js:45` | `running`, `lastRun` | Un seul cycle à la fois pour tout le serveur |
| `hub/state.js:16` | `data/hub-state.json` | Un seul instantané (c'est lui qui décide ce qui a « changé ») |
| `core/journal.js` | un seul journal JSONL | Le `hub:undo` d'un utilisateur rejouerait les suppressions des autres |
| `manifest.js:5` | `personalEnabled`, `traktEnabled` figés au démarrage | Les rangées « Ma liste / Favoris / Reco Trakt » sont les mêmes pour tous |
| `webui/*` | Tableau de bord d'**administration** | Expose les logs de tout le monde, déclenche des pushs, etc. |

### 2.3 Routes sensibles non authentifiées

Aujourd'hui c'est acceptable parce que le serveur est chez toi. Publiquement, ce ne l'est plus :

- `POST /hub/sync`, `/nuvio/push`, `/nuvio/merge`, `/trakt/push`, `/simkl/push`, `/simkl/resync`,
  `/trakt/auth`, `/simkl/auth` — **n'importe qui connaissant l'URL peut écrire dans tes comptes**
  ou lancer une association de compte (`server.js`).
- `GET /debug/sync` renvoie la réponse brute de ton compte Movix ; `/health` révèle la
  configuration.
- La WebUI n'est protégée que si `WEBUI_PASSWORD` est rempli (il est vide dans `.env.example`).

> À noter même sans rien publier : si `PUBLIC_URL` est exposée sur Internet, ces routes le
> sont aussi. Un correctif rapide (mettre ces routes derrière la même auth que `/ui`) vaut
> le coup indépendamment de ce rapport.

---

## 3. Les obstacles, du plus bloquant au moins bloquant

### 3.1 La clé VIP Movix — bloquant fonctionnel

D'après `README.md` (section « Résolution serveur ») et `config.js` : Movix a fermé ses
endpoints d'extraction publics. Les m3u8 ne sont plus rendues que par les routes catalogue
avec `resolve=1` **et** l'en-tête `x-access-key` d'une clé VIP valide. Sans clé, l'addon ne
sait lire seul que voe, veev, darkibox et oneupload.

Conséquences pour une publication :

- **Partager ta clé** avec tous les utilisateurs = un seul compte VIP qui génère le trafic de
  N personnes. C'est le meilleur moyen de la faire révoquer (et de tout casser, pour toi
  compris). À exclure.
- **Chacun apporte sa clé** : c'est la seule voie saine. Cela veut dire que l'addon public
  n'est vraiment utile qu'aux personnes qui ont déjà un VIP Movix. C'est une limite de
  public, pas de code.
- **Mode dégradé sans VIP** : l'addon reste utilisable (catalogues TMDB, addons autonomes
  Aether/KissKH/Obrigoz/Cinejoy, sous-titres, hébergeurs extraits localement). Il faut alors
  le dire clairement à l'utilisateur plutôt que de montrer des listes vides — le diagnostic
  `server-only` existe déjà (`streaming/hosterExtract.js`), il suffit de le remonter.

### 3.2 Récupérer les identifiants Movix — friction utilisateur

Il n'y a pas de « connexion Movix » dans l'addon : on copie à la main `auth_token`,
`user_id` et `selected_profile_id` depuis le `localStorage` du site (commentaire dans
`config.js`). Pour un utilisateur lambda, « ouvre les outils développeur et copie trois
valeurs » est une vraie barrière.

Constat sur ton jeton actuel : il contient `sub`, `userType`, `sessionId`, `authMethod`,
`iat` et **aucune date d'expiration**. Il vit donc tant que la session côté Movix n'est
pas révoquée (déconnexion, changement de phrase de récupération…). C'est pratique (pas de
renouvellement à gérer) mais c'est aussi un secret à longue durée de vie qu'il faut
protéger comme un mot de passe.

Pistes pour réduire la friction, par ordre de réalisme :

1. **Un petit bookmarklet** (« Glisse ce bouton dans tes favoris, clique-le sur movix.fun »)
   qui lit les trois valeurs du `localStorage` et les affiche / les envoie à la page de
   configuration. Faisable en une demi-journée, aucune rétro-ingénierie.
2. **Connexion directe** (phrase BIP39 ou OAuth → JWT) en reproduisant l'appel d'auth du site.
   Non vérifié dans ce dépôt ; demande de rétro-concevoir le flux de connexion Movix, et
   collecter une phrase de récupération BIP39 est très sensible (c'est la clé maîtresse du
   compte). **Déconseillé.**

### 3.3 Le hub de synchronisation — le gros morceau

C'est la partie la plus précieuse du projet et la plus difficile à rendre multi-comptes :

- C'est une **boucle de fond** (cycle conseillé à 5 min) qui lit Movix, Nuvio et Simkl,
  compare à un instantané et écrit les différences. Pour N utilisateurs, il faut N boucles,
  chacune avec son instantané, son journal, ses verrous et son historique d'erreurs.
- Chaque cycle coûte plusieurs requêtes par service. À 100 utilisateurs et 5 min, c'est
  plusieurs dizaines de milliers de requêtes par jour vers Movix depuis **une seule IP**.
- La logique de suppression (`HUB_PROPAGATE_DELETIONS`, coupe-circuit
  `HUB_MAX_REMOVALS_PER_CYCLE`, `hub:undo`) est destructive par nature. Un bug d'isolation
  (ex. le `resolvedProfileId` partagé cité plus haut) ne ferait pas qu'afficher la mauvaise
  liste : il **supprimerait ou écrirait dans le compte de quelqu'un d'autre**.

En auto-hébergé (option A), tout ça marche déjà tel quel.

### 3.4 Limites de débit et blocages des services tiers

| Service | Limite connue (d'après le code) | Impact en service hébergé |
|---|---|---|
| **Movix / Mainapi** | Aucune doc ; origine usurpée (`SPOOFED_ORIGIN`) | Tout le trafic de tous les utilisateurs part de ton IP avec le même faux `Origin`. Très visible, facile à bloquer. |
| **Simkl** | 1 POST/s, verrou d'écriture par utilisateur, suspension **par `client_id`** en cas d'abus ; **ton IP de VPS est déjà bloquée** (d'où `SIMKL_PROXY_URL` via nas-tunnel) | Un seul `client_id` partagé : un blocage coupe Simkl pour **tout le monde**. Le proxy nas-tunnel passerait par ta connexion domestique. |
| **Nuvio (Supabase)** | 350 req/s **globales**, partagées par tous les clients Nuvio | Gérable, les 429 sont déjà réessayés (`nuvioCloud.js:20`). |
| **Trakt** | ~1 écriture/s, 1 app connectée max par compte gratuit | OAuth multi-utilisateurs = cas normal, mais device code à faire par utilisateur. |
| **TMDB** | Généreuse | Aucun souci, clé d'application partageable. |

### 3.5 Coûts d'hébergement

- **Proxy de flux** (`streaming/streamProxy.js`) : pour les addons autonomes, **toute la
  vidéo transite par ton serveur**. Un film ≈ 1–4 Go. Dix personnes qui regardent en même
  temps, c'est 50–150 Mbit/s en continu sur ton VPS.
- **Calage automatique des sous-titres** : lance `ffmpeg` sur 6 fenêtres de 90 s par titre.
  CPU et bande passante non négligeables par lecture.
- **Sonde de débit** : un aller-retour (voire 5 segments) par lien, à chaque ouverture de fiche.

Rien d'insurmontable, mais ces coûts sont aujourd'hui « gratuits » parce qu'il n'y a qu'un
utilisateur. En option A, chacun les paie chez lui.

### 3.6 Sécurité des secrets

En option B, tu stockerais pour chaque utilisateur : un JWT Movix sans expiration, **un mot
de passe Nuvio en clair** (le grant `password` de Supabase l'exige à chaque reconnexion,
`nuvioCloud.js:55`), une clé VIP, des jetons Simkl/Trakt. Une fuite de ta base = accès
complet aux comptes de tous tes utilisateurs. Il faudrait au minimum :

- chiffrement au repos (AES-256-GCM, clé maîtresse hors de la base) ;
- pour Nuvio, stocker le **refresh token** après une première connexion plutôt que le mot de
  passe (il faut vérifier combien de temps Supabase le laisse vivre ; si le refresh expire,
  l'utilisateur devra se reconnecter) ;
- ne jamais journaliser les secrets (les logs actuels ne les affichent pas, mais `/debug/*`
  et la WebUI ont été pensés pour un seul admin).

### 3.7 Aspect juridique / CGU

Le projet agrège des sources de streaming non officielles et contourne des protections de
Movix (origine usurpée, `README.md` : « Conçu pour un usage strictement personnel… Ne l'expose
pas publiquement »). En usage privé, le risque est limité. **Publier un service** qui fait
ça pour des tiers change la nature du risque : tu deviens l'opérateur. C'est à peser
avant de choisir l'option B. Publier le code pour que chacun l'héberge (option A) reste
exposé, mais nettement moins, et c'est ce que font la plupart des projets comparables.

---

## 4. Ce qui est déjà partageable sans rien changer

Bonne nouvelle : une grosse partie du code n'a aucune notion de compte.

- Catalogues TMDB (tendances, populaires, genres, recherche), fiches, épisodes.
- Scraping des sources Movix (hors clé VIP), addons autonomes, extracteurs voe/veev/…
- Sous-titres (vdrk, OpenSubtitles), conversion, calage automatique.
- Proxy de flux signé, disjoncteurs, cache persistant.
- Les caches `meta:*`, `seasons:*`, catalogues publics, extraction : **partageables entre
  utilisateurs**, c'est même un avantage d'une instance commune.

Seuls ~6 500 lignes sur ~14 300 (intégrations, hub, WebUI, `server.js`, manifest, catalogues
personnels) sont concernées par le passage multi-comptes.

---

## 5. Comment faire, concrètement

### Option A — Kit auto-hébergé (recommandée)

Objectif : quelqu'un qui n'a jamais vu le projet lance une commande, ouvre une page,
remplit ses identifiants, et installe l'addon dans Nuvio.

1. **Configuration depuis la WebUI au lieu de `.env`** (≈ 1 jour)
   - Un fichier `data/settings.json` (dans le volume déjà existant) qui surcharge `.env`.
   - `core/config.js` : fusionner `.env` < `settings.json` au chargement. Le reste du code
     ne change pas, puisqu'il lit déjà `config.*`.
   - Page `/ui/setup` affichée tant que rien n'est configuré : champs VIP, Movix (avec le
     bookmarklet du §3.2), Nuvio, boutons « Connecter Simkl / Trakt » (les flux PIN/device
     code existent déjà : `startCodeAuth` dans `server.js`).
   - Bouton « Tester » par service (les diagnostics existent : `/debug/sync`, `/health`,
     santé de la WebUI).
   - Redémarrage à chaud ou message « redémarre le conteneur » après sauvegarde.
2. **Sécurité par défaut** (≈ ½ jour)
   - Mot de passe WebUI **obligatoire**, généré au premier démarrage et affiché dans les logs.
   - Toutes les routes d'écriture (`/hub/*`, `/nuvio/*`, `/trakt/*`, `/simkl/*`) et `/debug/*`
     derrière la même auth.
   - `STREAM_PROXY_SECRET` généré et persisté automatiquement dans `data/` au lieu d'être
     aléatoire à chaque démarrage.
3. **Clés d'application** (≈ ½ jour)
   - `TMDB_API_KEY`, `SIMKL_CLIENT_ID`, `TRAKT_CLIENT_ID` : soit chacun crée les siennes
     (documenté), soit tu fournis les tiennes par défaut. Pour Simkl, fournir la tienne
     expose ton `client_id` au blocage collectif (§3.4) — mieux vaut que chacun crée la sienne,
     c'est gratuit et prend deux minutes.
   - Rendre `SIMKL_PROXY_URL` clairement optionnel : le blocage d'IP est propre à ton VPS.
4. **Distribution** (≈ 1 jour)
   - Image Docker publiée (GitHub Container Registry via une Action).
   - `docker-compose.yml` minimal sans `.env` obligatoire.
   - README orienté utilisateur (5 étapes, captures), séparé de la doc technique actuelle.
   - Renommer le manifest (`Movix (perso)`, description « non destiné à être partagé »).
5. **Mode sans VIP explicite** (≈ ½ jour) : bannière dans la santé + message dans la liste de
   flux quand tout est `server-only`.

**Total : 2 à 4 jours.** Aucun risque de mélange de comptes, puisque chaque instance n'en a qu'un.

### Option B — Service hébergé multi-comptes

À n'envisager qu'après A, et seulement si tu es prêt à opérer un service (§3.5–3.7).

**Architecture cible**

```
Utilisateur ──> /configure (page publique)
                  │ saisit ses identifiants, connecte Simkl/Trakt
                  ▼
               base SQLite  (users: id, jeton d'installation, secrets chiffrés, réglages)
                  │
Nuvio ──> /u/<jeton>/manifest.json, /u/<jeton>/stream/...
                  │ middleware : jeton → UserContext (AsyncLocalStorage)
                  ▼
          handlers existants, qui lisent getUser() au lieu de config.* pour les secrets

Ordonnanceur ──> pour chaque utilisateur actif : runCycle(user)  (file, concurrence bornée)
```

**Étapes**

1. **Stockage des comptes** (≈ 3 j) : SQLite (`better-sqlite3`), secrets chiffrés
   AES-256-GCM avec une clé maîtresse en variable d'environnement. Jeton d'installation
   opaque et aléatoire (jamais les identifiants eux-mêmes dans l'URL). Révocation / suppression
   de compte.
2. **Contexte utilisateur** (≈ 3 j) : `AsyncLocalStorage` de Node pour porter l'utilisateur à
   travers les appels sans modifier toutes les signatures. Routes `/u/:token/*` : le SDK
   Stremio 1.6 supporte déjà un préfixe `/:config?` (`getRouter.js:34`) et passe
   `args.config` aux handlers — mais `server.js` sert déjà son propre `/manifest.json`
   (pour la TV en direct), il faudra donc le faire aussi pour `/u/:token/manifest.json`.
3. **Transformer les singletons en instances par utilisateur** (≈ 1–2 semaines, le plus gros) :
   - `movixClient` : clé VIP passée par requête, plus d'intercepteur global.
   - `movixSync` : clés de cache `sync:data:<userId>`, `resolvedProfileId` par utilisateur.
   - `nuvioCloud`, `traktCloud`, `simklCloud`, `simklLibrary` : fabriques
     `createClient(userSecrets)` ; jetons en base, plus dans des fichiers.
   - Simkl : garder **une** file d'attente globale (le `client_id` est partagé) mais une pause
     par utilisateur quand la cause est individuelle (verrou d'écriture), globale sinon.
   - `manifest.js` : manifest calculé par utilisateur (rangées personnelles selon ses comptes).
   - `catalog/recommend.js` : recommandations depuis l'historique de l'utilisateur.
   - `streaming/playback.js` et les sous-titres calés : l'observation « quel flux est en
     cours » doit être indexée par utilisateur, sinon deux personnes qui regardent le même
     titre se marchent dessus.
   - Choisir si les résultats de résolution VIP (m3u8 signées, 12 h) sont partagés entre
     utilisateurs (économique, mais la clé de A sert B) ou isolés par clé (plus propre).
4. **Hub multi-comptes** (≈ 1 semaine) : `hub/state.js` et `core/journal.js` par utilisateur
   (table ou dossier `data/users/<id>/`), ordonnanceur avec concurrence bornée et étalement
   des cycles (pas tous à la même seconde), désactivation automatique d'un utilisateur dont
   les identifiants échouent N fois de suite, **tests d'isolation** (deux faux comptes, on
   vérifie qu'aucune écriture ne franchit la frontière). Tests d'autant plus nécessaires
   que les suppressions sont propagées.
5. **WebUI** (≈ 3–5 j) : séparer l'**administration** (toi) de l'**espace utilisateur** (son
   état de synchro, ses erreurs, ses boutons « tester / reconnecter »). Les logs bruts restent
   admin seulement.
6. **Exploitation** (continu) : limites par utilisateur (fiches ouvertes/min, bande passante
   du proxy), inscriptions sur invitation au départ, surveillance du blocage par Movix/Simkl,
   sauvegarde chiffrée de la base.

**Total : 4 à 7 semaines** pour quelque chose de fiable, en comptant les tests. La partie
« entrer ses identifiants » elle-même est rapide ; c'est l'isolation (étape 3–4) qui prend le
temps et qui porte le risque.

### Option C — Configuration dans l'URL (pour mémoire)

Le modèle classique des addons Stremio configurables : la configuration est encodée
(base64) dans le chemin, `/<config>/manifest.json`. Serveur sans base, sans état.

- Marche pour **catalogues + flux + sous-titres** avec la clé VIP de chacun.
- **Ne marche pas pour le hub** : il n'y a pas de boucle de fond possible sans stocker les
  identifiants quelque part, et c'est tout l'intérêt du projet.
- Les secrets sont en clair dans l'URL, qui est enregistrée dans l'app, synchronisée dans le
  compte Nuvio/Stremio, et apparaît dans les logs de n'importe quel reverse proxy.

À réserver au cas où tu voudrais publier seulement « l'addon de streaming », sans synchro.

---

## 6. Recommandation

1. **Maintenant** (indépendamment de la publication) : protéger les routes d'écriture et
   `/debug/*` derrière l'auth de la WebUI (§2.3). ½ journée.
2. **Pour publier** : faire l'**option A**. En 2–4 jours, n'importe qui avec Docker et une
   clé VIP Movix peut avoir le même outil que toi, en remplissant un formulaire. Aucun de
   leurs secrets ne passe par toi, aucun trafic ne passe par ton IP.
3. **Option B seulement si** la demande est réelle et que tu acceptes d'être l'opérateur :
   secrets de tiers, bande passante, et exposition juridique. Si tu y vas, commencer par
   quelques personnes de confiance, sur invitation, et désactiver la propagation des
   suppressions tant que les tests d'isolation ne sont pas solides.

Le facteur qui limite le plus le public visé reste le même dans les trois cas : **sans clé
VIP Movix à soi, l'addon perd l'essentiel de ses flux.**
