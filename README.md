# Movix Addon (Stremio / Nuvio) — usage personnel

Addon self-hosted qui expose le catalogue et les flux Movix via le protocole d'addon
Stremio standard, consommé tel quel par **Stremio** et **Nuvio**.

> Conçu pour un usage strictement personnel : la clé VIP est injectée côté serveur et
> partagée par tous les clients qui joignent l'addon. Ne l'expose pas publiquement.

## Démarrage

```bash
cp .env.example .env   # puis remplis les valeurs
npm install
npm start
```

Puis installe `http://<host>:8787/manifest.json` dans Stremio ou Nuvio.

### En arrière-plan avec PM2

```bash
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 logs movix-addon          # suivre les logs
pm2 save && pm2 startup       # relance automatique au reboot (suivre l'instruction affichée)
```

Raccourcis : `npm run pm2:start|pm2:stop|pm2:restart|pm2:logs`.
Les logs sont écrits dans `logs/` (ignoré par git).

> Une seule instance est lancée volontairement : le cache vit dans la mémoire du
> process, donc plusieurs instances multiplieraient les appels aux scrapers sans rien
> partager.

Le serveur écoute sur **toutes les interfaces** — l'IP LAN ou Tailscale du serveur
fonctionne donc directement. Le message `HTTP addon accessible at: http://127.0.0.1:...`
affiché par le SDK est une chaîne fixe, pas le reflet du binding réel.

### Avec Docker

```bash
cp .env.example .env   # puis remplis les valeurs
docker compose up -d
docker compose logs -f
```

Un **seul volume** (`movix-data` → `/app/data`) porte tout ce qui doit survivre au
conteneur : cache persistant, instantané et journal du hub, jetons Trakt/Simkl. Sans lui,
chaque redémarrage repaye le scraping, l'extraction et la mesure de débit de chaque fiche.

> Les jetons sont redirigés vers ce volume par `TRAKT_TOKEN_FILE` / `SIMKL_TOKEN_FILE`
> plutôt que montés fichier par fichier : un bind-mount dont la source n'existe pas encore
> fait créer un **répertoire** par Docker à sa place, et l'écriture du jeton échoue ensuite
> sans explication — ce qui est exactement le cas au premier démarrage, avant connexion.

Pour des catalogues personnalisés, dépose `catalogs.json` dans le volume :

```bash
docker compose cp catalogs.json movix-addon:/app/data/catalogs.json
docker compose restart
```

### Structure du projet

```
server.js              Point d'entrée HTTP (Express) : monte le SDK Stremio, le proxy
                        de flux et les routes de diagnostic/push.

src/
├── addon.js            Handlers Stremio (catalog/meta/stream/subtitles)
├── manifest.js          Manifest de l'addon
│
├── hub/                 Synchro bidirectionnelle Movix ↔ Nuvio → Simkl
│   ├── index.js          Orchestration d'un cycle (lit, compare, écrit)
│   ├── model.js           Modèle canonique + clés partagées
│   ├── state.js            Instantané persisté d'un cycle à l'autre
│   ├── diff.js              Ce qui a changé/disparu, et ce qu'il est prudent de propager
│   ├── readers/             Lecture des trois sources → modèle canonique
│   └── writers/             Écriture du modèle vers chaque source
│
├── core/                Infrastructure transverse
│   ├── config.js         Lecture/validation des variables d'environnement
│   ├── paths.js           Chemins ancrés à la racine (data/, jetons)
│   ├── cache.js            Cache TTL persistant sur disque
│   ├── log.js               Logging des sources
│   ├── journal.js           Journal des synchros (retour arrière)
│   └── breaker.js           Disjoncteur pour les services en panne
│
├── catalog/             Construction des catalogues Stremio
│   ├── catalogs.js        Catalogues personnalisables (config → TMDB)
│   ├── genres.js           Résolution des genres TMDB
│   ├── recommend.js         Recommandations locales
│   └── idResolver.js        Résolution tmdb:/tt… → id TMDB
│
├── streaming/           Résolution et diffusion des flux vidéo
│   ├── streamBuilder.js    Agrège sources + addons, construit les objets stream
│   ├── streamProxy.js       Proxy HTTP qui rejoue les en-têtes attendus par les CDN
│   ├── hosterExtract.js      Détection d'hébergeur, extraction d'URL directe
│   ├── hosterVoe.js           Résolution spécifique aux domaines tournants Voe
│   ├── probe.js               Sonde le débit/la taille réels d'un flux
│   ├── playback.js             Quel flux est en cours de lecture (le protocole ne le dit pas)
│   └── subtitles/              Sous-titres : cascade de fournisseurs, conversion VTT, calage
│       ├── index.js             Cascade par langue, route de conversion, liste blanche
│       ├── vdrk.js               Fournisseur par défaut (déjà en VTT, indexé TMDB)
│       ├── opensubtitles.js       Fournisseur de repli
│       ├── langs.js                Libellés vdrk → codes ISO 639-2/B
│       ├── vtt.js                   SRT→VTT, encodage, retrait des publicités
│       ├── cues.js                   Bornes des répliques, application d'une correction
│       ├── audio.js                   Voie la moins chère vers la bande son d'un flux
│       ├── speech.js                   Où l'on parle dans le flux (enveloppe ffmpeg)
│       ├── align.js                     Corrélation croisée → décalage et dérive
│       └── sync.js                       Orchestration, mémoire, seuil de refus
│
├── integrations/        Clients des services externes
│   ├── movixClient.js      Client HTTP vers Mainapi (Movix)
│   ├── movixSync.js         Lecture des collections Movix (watchlist/favoris/historique)
│   ├── tmdb.js               Client TMDB
│   ├── traktCloud.js / traktPush.js   Auth + push vers Trakt
│   ├── simklCloud.js / simklPush.js / simklProbe.js   Auth + push vers Simkl
│   ├── nuvioCloud.js / nuvioPush.js   Auth + push vers Nuvio Sync
│   ├── contentIds.js          Forme des identifiants, servis ET poussés (source unique)
│   └── nuvioMerge.js           Fusion des entrées vers la forme configurée
│
├── sources/             Scrapers de sites tiers (passent par movixClient)
└── addons/              Sources autonomes (indépendantes de Mainapi), voir plus bas
```

## Ce que l'addon fournit

| Ressource | Détail |
|-----------|--------|
| `catalog` | Catalogues personnels (sync compte), recommandations, Tendances / Populaires / Mieux notés / Nouveautés, filtrables par genre, avec recherche |
| `meta` | Fiches complètes, épisodes par saison, casting, genres |
| `stream` | Agrégation des sources Movix + addons autonomes, extraction serveur des embeds |
| `subtitles` | vdrk puis OpenSubtitles en repli, nettoyés et servis en WebVTT (KissKH fournit les siens, rattachés au flux) |

### Catalogues personnalisables

Trois niveaux, du plus simple au plus libre :

1. **Choisir et ordonner** les rangées intégrées — `CATALOGS` dans `.env` :
   ```bash
   CATALOGS=watchlist,reco,trending,popular
   ```
   Ids disponibles : `watchlist`, `favorites`, `reco`, `trakt-reco`,
   `trending`, `popular`, `toprated`, `new`. L'ordre de la liste est l'ordre d'affichage.

2. **Renommer / créer des rangées** — copie `catalogs.example.json` en `catalogs.json`
   (il prend alors le pas sur `CATALOGS`). Une rangée personnalisée est un jeu de
   paramètres **TMDB Discover** transmis tels quels, donc aussi expressive que l'API :
   ```json
   [
     { "id": "watchlist" },
     { "id": "trending", "name": "Le moment" },
     { "id": "films-fr", "name": "Films français", "types": ["movie"],
       "discover": { "with_original_language": "fr", "sort_by": "primary_release_date.desc" } }
   ]
   ```
   `types` restreint aux films ou aux séries, `genres: true` ajoute le filtre par genre,
   `disabled: true` masque sans supprimer.

3. Tout ce qui n'est pas déclaré n'apparaît pas.

> Après modification, **redémarre l'addon** et incrémente `version` dans `src/manifest.js`
> si Nuvio garde l'ancienne liste en cache.

### Catalogues personnels (sync compte Movix)

Si `MOVIX_JWT` + `MOVIX_USER_ID` sont renseignés, deux rangées supplémentaires
apparaissent, alimentées par les mêmes données que le site (`/api/sync`) :
**Ma liste** et **Favoris**.

> **Il n'y a plus de rangée « Reprendre ».** Le protocole Stremio ne permet pas à un addon
> de positionner la reprise de lecture : cette rangée ne pouvait qu'*afficher* la
> progression (`S2E5 · 80 %` dans le libellé) avant de relancer au début. Depuis que le
> hub pousse les positions vers **Nuvio Sync** et **Simkl**, qui gèrent la reprise
> nativement et savent replacer le curseur, la doubler ici revenait à proposer une rangée
> moins capable que celle d'à côté — et à surcharger les libellés. Les titres sont donc
> rendus tels quels.

### Push vers Nuvio Sync (bibliothèque, vus, reprise de lecture)

Nuvio possède un compte cloud avec une API de synchronisation. L'addon peut y **écrire**
tes données Movix — ce qu'un addon Stremio ne peut pas faire, et qui donne la vraie
reprise de lecture à la seconde près.

Renseigne `NUVIO_EMAIL` / `NUVIO_PASSWORD` (le compte Nuvio, pas Movix), puis :

```bash
npm run nuvio:push:dry   # simule et affiche le résultat, n'écrit rien
npm run nuvio:push       # applique
# ou, serveur démarré :
curl -X POST http://localhost:8787/nuvio/push
curl -X POST "http://localhost:8787/nuvio/push?dryRun=1"
```

Ce qui est transféré :

| Movix | → Nuvio |
|-------|---------|
| Watchlist + Favoris | Bibliothèque (`sync_push_library`) |
| `watched_movie` / `watched_tv` / épisodes vus | Éléments vus (`sync_push_watched_items`) |
| Clés `progress_*` (position + durée) | Reprise de lecture (`sync_push_watch_progress`) |

`NUVIO_PUSH_INTERVAL_MS` (ex. `3600000`) active un push automatique périodique.

> **La bibliothèque Nuvio est remplacée en totalité par cet appel.** L'addon lit donc
> d'abord la bibliothèque existante et fusionne avant d'envoyer : ce que tu as ajouté
> depuis Nuvio est préservé. Ne contourne pas cette étape.

> Ce push est unidirectionnel. Pour les deux sens, voir le **hub** ci-dessous.

#### Un seul identifiant, sinon la même série apparaît deux fois

`ID_FORMAT` décide de la forme des identifiants — **et il gouverne les deux bouts à la
fois** : les ids que l'addon *sert* (catalogues, fiches, épisodes) et les `content_id`
*écrits* dans Nuvio.

| `ID_FORMAT` | Forme | Ce que ça implique |
|---|---|---|
| `imdb` (défaut) | `tt0903747` | Aligné sur Cinemeta et le reste de l'écosystème : une série ouverte depuis cet addon ou depuis un autre est **la même fiche**, avec une seule progression. Coûte une résolution TMDB → IMDb par titre, mise en cache 24 h. |
| `tmdb` | `tmdb:1396` | Aucun appel supplémentaire, mais les titres n'ont rien en commun avec ceux des addons indexés par IMDb. |

Les deux bouts doivent s'accorder parce que **Nuvio enregistre la progression sous l'id
de la fiche qu'il lit**. Servir une forme tout en poussant l'autre crée deux entrées pour
le même titre — c'est l'origine exacte du doublon Breaking Bad (`tt0903747` *et*
`tmdb:1396`, avec une progression différente dans chacun). Le `content_id` était en fait
fabriqué à trois endroits avec deux politiques : `NUVIO_ID_PREFERENCE` ne pilotait que le
push direct, ni le hub ni les ids servis. `src/integrations/contentIds.js` est désormais
le seul module qui en décide, et `NUVIO_ID_PREFERENCE` est remplacé par `ID_FORMAT`.

Un second effet, plus sournois : à la lecture, les deux formes retombaient sur la même clé
canonique et c'est la dernière résolue qui gagnait — un ordre qui dépend de la latence de
TMDB. Une position pouvait donc **reculer**, et le hub propageait ce recul jusqu'à Movix.
Le lecteur garde maintenant la position la plus avancée.

Les entrées qui ne sont pas dans la forme configurée sont **fusionnées vers celle-ci**, au
début de chaque cycle du hub (`NUVIO_MERGE_LEGACY_IDS`) ou à la demande :

```bash
npm run nuvio:merge:dry   # montre ce qui serait fusionné, n'écrit rien
npm run nuvio:merge       # applique
# ou, serveur démarré :
curl http://localhost:8787/debug/nuvio/duplicates    # combien d'entrées à aligner
curl -X POST "http://localhost:8787/nuvio/merge?dryRun=1"
```

La cible suit le réglage : en mode `imdb` ce sont les entrées `tmdb:` qui basculent vers
`tt`, et l'inverse en mode `tmdb`. **Changer `ID_FORMAT` puis relancer le merge fait donc
basculer tout le compte.** Quand les deux formes portent le même épisode, la position la
plus avancée gagne — même règle que pour les conflits du hub, la seule qui ne fasse jamais
reculer une reprise.

> La bibliothèque se nettoie toute seule (`sync_push_library` remplace la liste entière,
> donc ne pas renvoyer une ligne suffit à la supprimer). Pour la progression et les
> éléments vus, les endpoints `sync_push_*` sont **additifs** : retirer l'exemplaire en
> trop demande une suppression, que l'addon cherche dans ce que l'API publie elle-même.

Trois choses ne sont jamais supposées, parce qu'elles diffèrent d'un compte à l'autre :

- **La signature de la fonction de suppression.** Une RPC Postgres se résout par son nom
  *et* sa liste d'arguments : appeler `sync_delete_watch_progress(p_id, p_profile_id)`
  quand elle est déclarée `(p_keys, p_profile_id)` renvoie un `404 PGRST202` — la
  *fonction* est introuvable, pas la ligne. Elle est donc lue dans la spec OpenAPI, et à
  défaut dans le champ `hint` que PostgREST renvoie avec l'erreur.
- **Les paramètres qu'on ne comprend pas.** `sync_delete_watched_items` est déclarée
  `(p_keys, p_origin_client_id, p_profile_id)`. Seuls le profil et les clés sont
  renseignés ; tout le reste part à `null`. Remplir `p_origin_client_id` avec le tableau
  de clés faisait **accepter l'appel sans rien supprimer** — un paramètre dont on ignore
  le sens se laisse vide, il ne s'invente pas.
- **La clé attendue.** `row.id` est un UUID technique alors que la clé logique ressemble à
  `tt0903747_s1e5`, laquelle n'existe comme champ sur aucune ligne et doit être bâtie.
  Chaque forme plausible est essayée puis **vérifiée en relisant** : une RPC peut accepter
  un appel sans rien supprimer, et annoncer 48 suppressions imaginaires est pire que
  d'admettre n'avoir rien fait. Une forme qui n'en couvre qu'une partie (`video_id` est
  renseigné sur les épisodes, nul sur les films) n'arrête pas la recherche — les lignes
  restantes repassent par la suivante, d'où un `cle` qui peut en lister plusieurs.

Et la suppression n'emprunte pas une seule voie : **toutes** les RPC candidates *puis* le
DELETE direct sur la table sont essayés, chacun avec chaque forme de clé, jusqu'à ce que
la relecture confirme la disparition. Une RPC qui existe n'est pas une RPC qui supprime —
`sync_delete_watched_items` accepte ses appels sans rien retirer tant qu'on ne lui donne
pas la clé qu'elle attend, alors qu'un DELETE filtre sur des colonnes qu'on peut *voir*.

Si rien n'aboutit, les positions restent correctement fusionnées et le résumé liste ce qui
a été tenté, plus les `voies` disponibles. `GET /debug/nuvio/sample` donne alors les noms
de champs réels d'une ligne — telle que la lisent les `sync_pull_*` **et** telle qu'elle
existe dans la table, ce qui n'est pas la même chose : `watch_progress` porte une colonne
`progress_key` (`tt33546863_s1e1`) que la lecture expose, là où les éléments vus n'en
montrent aucune.

### Hub de synchronisation (les deux sens, en continu)

Le hub fait circuler les données **Movix ↔ Nuvio Sync**, et recopie le tout vers Simkl.
Tu peux commencer un film sur le site et le reprendre dans Nuvio, ou l'inverse.

```bash
HUB_ENABLED=true
HUB_INTERVAL_MS=45000   # plancher 15000
```

```bash
npm run hub:dry     # montre ce qui serait propagé, n'écrit rien
npm run hub:once    # un cycle
curl http://localhost:8787/hub/status
curl -X POST http://localhost:8787/hub/sync
```

**Comment il décide.** Le hub compare chaque côté à un instantané du tour précédent
(`data/hub-state.json`) plutôt que de se fier à des horodatages : Movix n'estampille pas
ses clés `progress_*`, donc « qui est le plus récent » est indécidable — alors que
« qu'est-ce qui a changé depuis le dernier tour » est exact des deux côtés. Le premier
cycle, sans instantané, traite tout comme nouveau et produit l'union des deux comptes.

| | Sens | Contenu |
|---|---|---|
| Movix ↔ Nuvio | bidirectionnel | listes, titres et épisodes vus, positions de lecture |
| → Simkl | miroir seulement | historique et listes (jamais une source) |

- **Conflit sur une même position** (les deux côtés ont bougé) : la position la plus
  avancée gagne.
- **Simkl ne reçoit pas les positions** : son API n'a pas d'endpoint de progression, et
  sa progression n'est de toute façon conservée qu'une semaine.
- L'instantané n'est enregistré qu'en cas de succès complet — un échec partiel est
  rejoué au cycle suivant plutôt qu'oublié. Il intègre aussi ce que le cycle vient
  d'**écrire** : sans ça, nos propres écritures reviendraient au tour suivant comme des
  nouveautés venues de la source.

#### Suppressions (`HUB_PROPAGATE_DELETIONS=true`)

Retirer un titre quelque part le retire partout. Sans ça, une suppression est annulée au
cycle suivant par les deux autres systèmes, qui le réajoutent.

C'est le seul chemin destructif du hub, d'où trois garde-fous :

1. **Un ajout concurrent l'emporte** — si l'élément a été (ré)ajouté ailleurs pendant le
   même cycle, la suppression est ignorée. Effacer un ajout frais est irrattrapable ;
   une suppression ignorée revient au tour suivant.
2. **Une source qui paraît vide est tenue pour muette** — une lecture ratée ne se
   distingue pas d'un compte vidé, alors on refuse de conclure.
3. **Plafond par cycle** (`HUB_MAX_REMOVALS_PER_CYCLE`, 10 par défaut) — au-delà, on
   suppose une lecture incomplète et on ne propage rien.

> Côté Nuvio, supprimer ne coûte rien : la bibliothèque s'écrit en remplacement complet,
> il suffit de ne pas renvoyer la ligne.

#### Journal et retour arrière

Chaque écriture du hub est consignée dans `data/hub-journal.jsonl` (une opération par
ligne). Les **retraits y sont enregistrés avec l'élément retiré**, donc restaurables.

```bash
npm run hub:journal          # les 40 dernières opérations
npm run hub:journal 200      # plus large
grep '"action":"remove"' data/hub-journal.jsonl
npm run hub:undo             # rejoue à l'envers les suppressions du dernier cycle
npm run hub:undo <cycle-id>  # celles d'un cycle précis
```

Le journal est écrit **avant** l'opération : si une écriture échoue en cours de route, la
trace de ce qui a été tenté existe quand même. `hub:undo` efface aussi l'instantané —
il décrit un monde où ces éléments n'existaient plus, le garder les re-supprimerait au
cycle suivant.
- Les objets écrits côté Movix reproduisent exactement les formes du site
  (`{id, type, title, poster_path, addedAt}`, `continueWatching`, `watched_episodes_tv_*`),
  pour que l'interface du site les affiche normalement.

> La latence perçue est `HUB_INTERVAL_MS`. Descendre à 15–20 s rend la reprise quasi
> immédiate, au prix d'un aller-retour Movix + Nuvio à chaque cycle.

### Quel tracker choisir (⚠️ limite Trakt gratuit)

Depuis 2026, **un compte Trakt gratuit n'autorise qu'une seule application tierce
connectée à la fois** (les apps officielles Trakt sont exemptées). Nuvio occupe ce slot
dès que tu y branches Trakt : cet addon ne peut alors pas rester connecté en parallèle
sans Trakt VIP. Trakt renvoie un `420` quand une limite de compte est dépassée.

Trois options, cumulables :

| Option | Compte requis | Ce que ça donne |
|--------|---------------|-----------------|
| **Recommandations locales** | aucun | Rangée « Parce que tu as regardé », calculée depuis l'historique Movix. Activée par défaut. |
| **Simkl** *(recommandé sans VIP)* | Simkl (gratuit) | Historique + listes partagés, **pas de limite d'app**, intégré nativement par Nuvio depuis août 2026. |
| **Trakt** | Trakt (gratuit) | Le plus large écosystème d'addons — mais un seul slot : voir l'import ponctuel ci-dessous. |

Les positions de reprise à la seconde près restent gérées par le push **Nuvio Sync**
(section précédente) : l'API Simkl n'a pas d'endpoint de progression, et le slot Trakt
sert mieux à Nuvio qu'à cet addon.

### Pont Simkl (historique partagé, sans limite)

```bash
# 1. Crée une app sur https://simkl.com/settings/developer
# 2. Renseigne SIMKL_CLIENT_ID dans .env (aucun secret nécessaire)
npm run simkl:auth        # affiche un code à saisir sur simkl.com/pin
npm run simkl:push:dry
npm run simkl:push
```

| Movix | → Simkl |
|-------|---------|
| Films vus + épisodes vus | Historique (`/sync/history`) |
| Watchlist + Favoris | `plantowatch` |
| Titres en cours de lecture | `watching` |

Contrairement à Nuvio, qui n'a qu'une bibliothèque plate, Simkl distingue
`plantowatch` / `watching` / `completed` — le push s'en sert. Un titre n'ayant qu'un
seul statut, une lecture en cours l'emporte sur « à voir ».

```bash
npm run simkl:probe   # lecture seule: affiche la forme réelle des réponses de l'API
```

`simkl:probe` sert à câbler la synchronisation **Simkl → hub** : la documentation
publique de Simkl est incomplète (le fichier apiary figé sur GitHub ne contient ni
`/scrobble` ni les formes de réponse de `/sync/all-items`), donc on interroge le compte
réel plutôt que de coder sur des suppositions.

Branche ensuite Simkl dans les réglages de Nuvio : il y scrobble tout seul, donc
l'historique reste à jour sans relancer l'import. `SIMKL_PUSH_INTERVAL_MS` active
malgré tout un import périodique depuis Movix si tu continues à utiliser le site.

### Pont Trakt (historique partagé + recommandations)

Le sync cloud Nuvio est un silo : seul Nuvio le lit. **Trakt** est le hub d'historique de
tout l'écosystème — Nuvio s'y connecte nativement et y *scrobble automatiquement* ce que
tu regardes, et les addons de recommandation/catalogue (AIOLists, Trakt…) lisent Trakt.

Y importer l'historique Movix apporte deux choses que Nuvio Sync ne peut pas donner :

1. **Des recommandations basées sur ce que tu regardes** — l'algorithme Trakt a besoin
   d'un historique pour fonctionner, et c'est là qu'il le lit.
2. **La bidirectionnalité** — Nuvio écrit dans Trakt en continu, donc l'historique reste
   à jour sans rien relancer, quel que soit l'appareil.

```bash
# 1. Crée une app sur https://trakt.tv/oauth/applications (Redirect URI: urn:ietf:wg:oauth:2.0:oob)
# 2. Renseigne TRAKT_CLIENT_ID / TRAKT_CLIENT_SECRET dans .env
npm run trakt:auth        # affiche un code à saisir sur trakt.tv/activate
npm run trakt:push:dry    # simule, n'écrit rien
npm run trakt:push        # importe
# ou, serveur démarré :
curl -X POST http://localhost:8787/trakt/auth
curl -X POST "http://localhost:8787/trakt/push?dryRun=1"
```

| Movix | → Trakt |
|-------|---------|
| Films vus + épisodes vus | Historique (`/sync/history`) |
| Watchlist | Watchlist |
| Favoris | Liste privée « Movix · Favoris » |
| Clés `progress_*` | Points de reprise (`/scrobble/pause`) |

Le jeton est enregistré dans `.trakt-token.json` (ignoré par git) et renouvelé
automatiquement — l'autorisation n'est à faire qu'une fois.

Une fois autorisé, **redémarre l'addon** : une rangée **« Movix · Recommandé pour vous »**
apparaît, alimentée par l'algorithme Trakt. `TRAKT_PUSH_INTERVAL_MS` active un import
périodique.

> Les visionnages Movix ne sont pas horodatés : ils sont datés de la sortie du titre
> (`TRAKT_WATCHED_AT=released`) pour ne pas remplir « vu récemment » avec 50 titres du jour.
> `now` bascule sur la date courante.

> Trakt limite les écritures à environ une par seconde : l'import est volontairement
> sérialisé, un premier push de plusieurs dizaines de reprises prend donc une minute.

> **Sans Trakt VIP, fais-en un import ponctuel** : autorise cet addon, lance
> `npm run trakt:push`, puis révoque-le dans
> [tes réglages Trakt](https://trakt.tv/settings/applications) et connecte Nuvio à la
> place. L'historique est stocké côté Trakt : il reste en place après la révocation, et
> c'est Nuvio qui l'alimente ensuite. La rangée « Recommandé pour vous » de cet addon
> disparaît alors (elle exige une connexion active) — la rangée locale
> « Parce que tu as regardé » prend le relais.

### Sous-titres

Deux fournisseurs, interrogés **dans l'ordre de `SUBTITLE_PROVIDERS`** (défaut :
`vdrk,opensubtitles`).

| | vdrk | OpenSubtitles |
|---|---|---|
| Format servi | **WebVTT** directement | `.gz` → `.srt` → conversion |
| Encodage | UTF-8 annoncé | non annoncé, souvent latin-1 (accents cassés si lu en UTF-8) |
| Indexation | **id TMDB** | id IMDb → un appel `/external_ids` de plus |
| Requêtes | une seule, toutes langues | **une par langue** (la forme groupée répond 400) |
| Clé / quota | aucune | aucune, mais l'API publique est capricieuse |

La cascade se fait **par langue**, pas en tout ou rien : si vdrk a l'anglais mais pas le
français sur un titre confidentiel, OpenSubtitles n'est interrogé que pour le français —
et pas du tout s'il ne manque rien. C'est tout l'intérêt d'un repli : combler un trou,
pas remplacer l'ensemble.

vdrk nomme ses pistes en anglais avec un numéro pour les variantes (`French`, `French2`,
`French3`…), traduits en codes ISO 639-2/B par `langs.js`. Attention : ce sont les codes
*bibliographiques* (`fre` et non `fra`, `ger`, `dut`, `gre`, `rum`, `per`, `cze`) — Nuvio
normalise ce champ et affiche « inconnu » pour tout le reste. La piste sans numéro est
celle que vdrk présente en premier, donc celle retenue par défaut.

#### Les publicités sont retirées

Ce n'est pas théorique : la piste française de Breaking Bad S01E01 s'ouvre sur
`Visit hoofoot.ru to watch all sports livestream and highlights for free`, affiché six
secondes avant la première réplique. Les deux fournisseurs en ont, et on en compte **4 par
épisode** sur ce fichier.

Le nettoyage raisonne par **réplique entière** (horodatage + texte) et non ligne à ligne :
supprimer le texte en laissant son horodatage produirait un cartouche vide que certains
lecteurs affichent en noir. La détection exige une forme de *domaine* (`quelquechose.tld`)
plutôt qu'une simple extension — chercher `.fr` ou `.tv` nu emporterait du dialogue
légitime — plus une liste de signatures connues (`opensubtitles`, `addic7ed`, `sous-titres
par`, `traduction :`…).

> Les pistes vdrk sont déjà du WebVTT et seraient jouables en direct. Elles passent quand
> même par `/subtitle/`, pour ce nettoyage et pour ne dépendre que d'un seul chemin
> éprouvé (PUBLIC_URL, cache, en-têtes). Cette route n'accepte de relayer que vers les
> hôtes des fournisseurs déclarés — la liste est **dérivée** d'eux, sans quoi ajouter un
> fournisseur se solderait par un 403 sans rapport apparent.

#### Les sous-titres sont calés sur le flux

Le problème est structurel : les flux viennent de sources diverses, les sous-titres d'un
index qui ne les connaît pas. Rien ne garantit qu'ils décrivent le même montage ni la même
cadence, et le résultat se répartit en deux cas :

| Symptôme | Cause | Le réglage de délai du lecteur suffit-il ? |
|---|---|---|
| Décalage constant de quelques secondes | Habillage de source, logo de distributeur, montage différent | Oui, mais il faut le retrouver à la main |
| Calé au début, faux de plusieurs minutes à la fin | **Conversion PAL** : la piste vient d'un master à 25 im/s appliqué à un flux à 23,976 (rapport 1,0427) | **Non** — le décalage change en permanence |

L'addon règle les deux. Il écoute quelques fenêtres du flux avec ffmpeg, relève **quand on
y prend la parole**, compare ces instants à ceux des répliques, et en déduit la correction
`t_flux = scale × t_sous-titre + offset`.

##### Trois décisions qui font que ça marche

**On compare les DÉBUTS, pas les durées.** C'est le point qui a tout changé à la mesure.
Corréler les intervalles entiers revient à comparer des durées — or une réplique ne dure
pas ce que dure la phrase : elle reste affichée après, elle en regroupe parfois deux, une
traduction condense. Les débuts, eux, coïncident : le sous-titre apparaît quand l'acteur
ouvre la bouche. Sur deux longs-métrages de test, passer aux débuts fait passer l'un de
« aucun calage trouvé » à *six fenêtres sur six d'accord*, et ramène à zéro les faux calages
sur des paires de films sans rapport.

**Le seuil de parole est relatif au HAUT de la dynamique, et il GLISSE** (`p95 − 8 dB`,
recalculé sur ±15 s). Un seuil absolu façon `silencedetect` ne marche pas : un film mixé
fort n'a aucun silence, un film mixé bas n'a que ça. Un seuil à mi-hauteur ne marchait pas
beaucoup mieux — sur un film où la musique ne s'arrête jamais, il marquait 60 à 80 % du
temps comme « parlé », un signal presque constant dont on ne tire rien. Et un seuil calculé
une fois pour toute la fenêtre échoue encore autrement : une fenêtre d'une minute et demie
couvre souvent une scène calme *et* une scène d'action, et le même seuil noie la première ou
vide la seconde. En le recalculant en continu, **le nombre de pistes calées passe de 5 à 11
sur le banc d'essai** (voir plus bas), sans un seul faux calage de plus. La bande est en
outre limitée à 200–3000 Hz : les basses d'une explosion ne comptent plus pour de la voix.

**La dérive n'est pas cherchée comme une pente libre.** Une conversion PAL multiplie
*exactement* par 25 / (24000/1001) : seuls les rapports d'images/seconde réels sont essayés
(`1`, `25/23,976`, `25/24`, `24/23,976`, et leurs inverses). Chacun l'est à fond — répliques
ramenées à sa cadence, puis **une courbe de corrélation complète par fenêtre**, ce qui
permet de juger chaque candidat à la même aune. Une version antérieure remesurait chaque
fenêtre dans une bande étroite autour du décalage attendu, là où il n'y a plus de rival à
battre : deux fenêtres tombant d'accord sur un faux décalage y paraissaient irréprochables
et l'emportaient sur quatre fenêtres justes.

**Ce que ça coûte.** Presque rien, parce que l'addon ne télécharge jamais la vidéo entière :
il prend la piste audio séparée du master (`EXT-X-MEDIA:TYPE=AUDIO`) quand il y en a une, et
sinon la variante **la moins bien encodée** — la bande son y est la même, c'est la même
diffusion. Compter ~30 Mo et une trentaine de secondes pour un long-métrage ; sur un flux
HLS de 30 min mesuré de bout en bout, 3 Mo et 4 secondes.

**Une deuxième piste peut confirmer la première.** Quand le français et l'anglais d'un même
titre, calés séparément sur le même flux, tombent sur la *même* correspondance à une
demi-seconde près d'un bout à l'autre du film, le verrou de confiance est abaissé pour les
deux. Avec une réserve qui s'est révélée décisive à la mesure : les deux pistes doivent être
**réellement indépendantes**. Beaucoup de traductions sont deux textes posés sur un seul
fichier de minutage — elles rendent alors exactement la même mesure, au centième près, et
les faire se confirmer revient à compter deux fois la même chose. L'addon compare donc les
*débuts de réplique* des deux pistes : des pistes écrites séparément en partagent 0 à 26 %,
des pistes issues du même minutage 79 à 92 %. Sans ce garde-fou, Dune 2 sortait « calé » à
−91 s sur la foi de deux pistes jumelles, alors que sa fenêtre la plus franche disait tout
autre chose.

##### Quand un calage est refusé

Trois verrous, et il faut les passer tous les trois. En dessous, la piste est servie **telle
quelle** — c'est voulu : un calage approximatif est pire que pas de calage, il est faux
*partout* au lieu d'être faux d'une quantité constante, que l'œil corrige tout seul.

| Verrou | Défaut | Ce qu'il écarte |
|---|---|---|
| `SUBTITLE_AUTOSYNC_MIN_WINDOWS` | 3 | Deux fenêtres d'accord ne démontrent rien : sur une recherche de ±120 s il existe toujours des paires de faux sommets qui s'accordent par hasard |
| `SUBTITLE_AUTOSYNC_MIN_REACH` | 0,6 | Un modèle vérifié sur les deux premiers tiers seulement — signature d'un **montage différent** (version longue, coupure), qu'aucune correction affine ne peut décrire |
| `SUBTITLE_AUTOSYNC_MIN_CONFIDENCE` | 0,20 | Corrélations molles, sommets qui ne se détachent pas du fond (0,08 si une piste indépendante confirme) |

Les seuils sont calibrés sur de l'audio de **film**, pas sur un signal de laboratoire : la
musique et les ambiances y sont continues, une corrélation juste y vaut 0,3–0,5 là où un
signal propre donne 0,8.

##### Banc d'essai

Mesuré sur **16 titres** (films récents et anciens, séries), soit 22 pistes de sous-titres,
avec les vraies sources de l'addon. Le protocole ne suppose aucune vérité extérieure : on
**décale la piste d'une quantité connue** et on vérifie que le calage la retrouve, on
**injecte une conversion PAL** et on vérifie qu'il retrouve le rapport exact, et on
confronte chaque flux aux sous-titres des 15 autres titres, qui doivent tous être refusés.

| Mesure | Résultat |
|---|---|
| Pistes calées | **12 / 20** (2 pistes étaient tronquées par le fournisseur) |
| Faux calages (piste d'un autre titre) | **0 / 180** |
| Précision — décalage connu réinjecté | médiane **3 ms**, p90 14 ms, max 300 ms |
| Précision — dérive PAL réinjectée | médiane **0 ms**, max 2 ms (cadence exacte à chaque fois) |
| Validation croisée (chaque fenêtre prédite par les autres) | médiane **200 ms**, p90 1,4 s |
| Coût par titre | ~87 Mo, ~55 s |

Ce que le banc a mis au jour, et qui dit l'intérêt de la chose :

- **Un habillage de +19 s en tête des flux d'une source** : Pulp Fiction ressort à +19,69 s
  et Oppenheimer à +19,00 s sur les mêmes serveurs. Ce sont exactement les minutes de
  recalage manuel que ce mécanisme supprime.
- **De vraies pistes PAL**, détectées comme telles : la piste anglaise d'Avengers et la
  française de Matrix sortent toutes deux à 1,0427. La preuve est jolie — une fois corrigée,
  la dernière réplique anglaise d'Avengers (7815 s) retombe sur la même seconde que la
  dernière réplique française (8149 s).
- **Des pistes déjà justes**, reconnues comme telles : Breaking Bad S01E01 en anglais sort à
  −0,02 s. Le calage ne touche alors à rien.
- Les échecs restants ne viennent pas du calcul : 4 titres n'ont eu **aucun flux audio
  lisible** (CDN muet ou variante sans piste audio) et 2 pistes étaient **tronquées à la
  source** (37 répliques pour tout Interstellar).

##### Savoir quel flux caler

Le protocole ne le dit pas. La ressource `subtitles` reçoit un type et un id de contenu,
jamais le flux choisi — or le décalage n'existe pas dans l'absolu, il dépend du release
qu'on regarde. Trois façons de retrouver l'information (`SUBTITLE_AUTOSYNC_BIND`) :

| Mode | Comment | Limite |
|---|---|---|
| `playback` *(défaut)* | Le proxy de flux **vient de servir** la playlist du flux choisi : ce n'est pas une supposition, c'est une observation | Aveugle aux liens qui ne passent pas par le proxy (extraction directe) |
| `stream` | Les pistes sont rattachées à chaque flux (`stream.subtitles`), chacune portant l'identifiant du sien | Suppose que le lecteur lise ces pistes-là ; elles peuvent apparaître **en double** avec celles de la ressource `subtitles` |
| `both` | Les deux | Le doublon ci-dessus |

Le calage a lieu **au moment où le lecteur réclame le fichier**, pas quand la liste est
construite : à cet instant la lecture a déjà commencé, donc le flux est connu. Et il est
préparé encore avant : la **première requête du proxy** marque le début de la lecture, ce
qui laisse les quelques dizaines de secondes nécessaires avant que quiconque ouvre le menu
des pistes. (La sonde de débit emprunte parfois la même route ; elle marque ses requêtes,
sans quoi elle déclencherait le calage de chaque lien de la liste.) Si le calcul n'est pas
fini au bout de `SUBTITLE_AUTOSYNC_WAIT_MS`, la piste brute est servie — le calcul, lui,
continue, et la piste ressort calée si on la resélectionne.

Un calage trouvé est mémorisé une semaine sous une clé volontairement stable (*cette source,
à cette qualité, pour cet épisode*) plutôt que sous l'URL du flux, qui porte souvent un jeton
expirant : reprendre une série le lendemain ne le repaye pas.

##### Vérifier

```bash
curl "http://localhost:8787/debug/subsync/movie/tmdb:157336?compute=1"   # calcule et détaille
curl -I "http://localhost:8787/subtitle/<...>.vtt"                       # en-tête X-Movix-Subsync
```

La console dit toujours *pourquoi* une piste n'a pas été calée : piste trop courte, aucun
flux observé, variante sans piste audio, ou lequel des trois verrous a bloqué.

> **ffmpeg est requis** — présent dans l'image Docker, à installer à côté sinon
> (`apt install ffmpeg`, `brew install ffmpeg`, ou `FFMPEG_PATH=/chemin/vers/ffmpeg`). S'il
> manque, l'addon le signale une fois au démarrage, désactive le calage et sert les pistes
> telles quelles : **rien d'autre n'en dépend**.

### Sources agrégées

**Via Movix** — `PurStream` (liens directs), `Links` (liens communautaires Movix — les
`.mp4` sont directement jouables), `Coflix`, `FrenchStream`, `FStream`, `Wiflix`,
`Cpasmal`, `1jour1film`, `Voirdrama` (séries asiatiques), `KissKH` (dramas et films
asiatiques, films **et** séries).

`KissKH` se distingue sur deux points : l'URL renvoyée est **déjà proxifiée** par le site
et pointe sur un master HLS — rien à extraire — et la réponse porte **ses propres
sous-titres**, rattachés au flux plutôt que jetés. C'est souvent la seule piste française
disponible sur ce catalogue, qu'OpenSubtitles couvre mal. Le libellé de langue suit ce
qui est réellement livré : `VOSTFR` quand une piste française est présente, `VO` sinon
(`KISSKH_LANG`) — annoncer du français sur un épisode qui n'en a pas fausserait le tri
par `PREFERRED_LANGS`. Les pistes chiffrées (`cipher.mode` ≠ `none`) sont écartées,
étant illisibles telles quelles.

**Addons autonomes** — `Aether` (3 serveurs), `Obrigoz`, `Cinejoy`. Voir [Addons](#addons-sources-autonomes).

Les embeds sont résolus en URLs directes pour **12 hosters** — soit tous
ceux que le site sait extraire côté serveur : voe, uqload, vidzy, fsvid, vidmoly, sibnet,
doodstream, seekstreaming (via `proxiesembed`), supervideo, dropload (via Mainapi),
darkibox et oneupload (scraping HTML direct).

`smoothpre` et `minochinos` figurent dans le registre du site mais n'ont **aucun**
extracteur (ni serveur, ni extension) — ce sont uniquement des motifs de détection pour
l'ordre de priorité. Rien à porter.

#### Domaines tournants (le cas Voe)

Deux stratégies de détection, selon le nom de l'hébergeur :

- **nom distinctif** (`uqload`, `vidmoly`, `fsvid`…) — un simple mot suffit et couvre tous
  ses TLD, présents et futurs ;
- **domaines délibérément anonymes** — il faut une liste explicite. **Voe** en est le cas
  d'école : il renouvelle ses domaines de sortie environ tous les mois, avec des noms qui
  ne contiennent pas « voe » (`ralphysuccessfull.com`, `prepareddare.com`,
  `timmaybealready.com`…). Les 11 alias connus du site sont portés.

Cette liste **vieillit par construction** : un domaine mis en service après elle passe pour
« sans extracteur » alors qu'il est parfaitement extractible. `HOSTER_PATTERNS_EXTRA` en
ajoute sans toucher au code — le pendant des « hosters custom & regex » du site :

```bash
HOSTER_PATTERNS_EXTRA=voe:bysebuho,voe:playmogo
```

`/debug/extract/...` liste les hôtes non reconnus (`"issue":"aucun extracteur"`) : ce sont
les candidats. Un nom inventé ou un hébergeur inconnu est signalé au démarrage plutôt
qu'ignoré.

**Reconnaître ne suffit pas.** Sur ces mêmes domaines récents, `proxiesembed` répond
`404 Content not found` : il a bien chargé la page, mais n'y a pas trouvé le bloc JSON
qu'il attendait. Le lien est alors détecté, envoyé, refusé — et perdu. Un **extracteur Voe
local** (`src/streaming/hosterVoe.js`) prend le relais dans ce cas : il suit les rebonds de la page
(`window.location`, `meta refresh`, lien `/e/…` — aucun n'est un vrai `3xx`, donc aucun
client HTTP ne les suit seul), lit le bloc obfusqué et le déchiffre.

Le déchiffrement n'est pas de la cryptographie : c'est un empilement de transformations
réversibles — `rot13` → retrait de sept symboles de bruit → base64 → décalage de 3 →
inversion → base64 → JSON (porté de `server.py:3100-3116`). Une seule erreur d'ordre rend
du binaire plutôt qu'une erreur, d'où le test qui **fabrique** une chaîne par le chemin
inverse et vérifie que la source est retrouvée à l'identique.

Le flux obtenu vient du CDN de Voe, qui n'accepte que le `Referer` de son lecteur : il
repart donc **par le proxy de flux**, comme un lien d'addon. Sans cela l'URL serait exacte
et pourtant injouable.

#### Domaines canoniques

`proxiesembed` **valide le domaine** de l'URL d'embed avant d'extraire quoi que ce soit, et
répond `400 Invalid URL` pour tout autre miroir :

| Hébergeur | Domaines acceptés | Champ de réponse |
|---|---|---|
| `fsvid` | `fsvid.lol` | `m3u8Url` |
| `vidzy` | `vidzy.org`, `vidzy.cc` | `m3u8Url` |
| `uqload` | `uqload.is/.bz/.cx/.com/.net/.org/.to/.io/.co` | `url` |
| `voe` | *(aucune — URL passée en base64)* | `source` |

Or les sources donnent régulièrement un **miroir**. C'est pourquoi seul `fsvid` sortait :
FStream sert justement ses liens fsvid sur le domaine canonique, et les autres non. L'hôte
est donc ramené sur ce domaine avant l'appel — comme le fait le site pour `uqload`
(`extractM3u8.ts:456`) ; l'identifiant de la vidéo, lui, est le même d'un miroir à l'autre.

Le site masquait le problème en passant **d'abord par son extension navigateur** pour ces
hébergeurs (`tryExtensionFirst`), `proxiesembed` n'étant que son repli. Un serveur n'a pas
cette échappatoire.

```bash
curl http://localhost:8787/debug/extract/movie/tmdb:157336
```

donne, par embed : l'hébergeur détecté, **l'URL réellement envoyée** après normalisation, et
le message d'erreur du service. `Invalid URL` désigne un domaine refusé et non un extracteur
manquant — deux causes indiscernables dans la liste de streams.

### Addons (sources autonomes)

Un **addon** est une source qui ne passe pas par Movix : ni Mainapi, ni clé VIP, ni
domaine spoofé. Il apporte son propre chemin de résolution (API tierce, scraping) et
déclare les en-têtes que ses CDN exigent. C'est la voie d'ajout d'un site reverse-engineeré.

| Addon | Contenu | Serveurs | Résolution |
|---|---|---|---|
| `aether` | Films **et séries** | `aurora`, `lul`, `link` (VO), `gallic` (**VF**) | par id TMDB |
| `obrigoz` | Films | — | par **titre** TMDB + année |
| `cinejoy` | Films **et séries** | — | par id TMDB (+ imdb/année/titre) |

> **Cinejoy** est un cas à part : son client de scellement est un module WebAssembly
> (`src/addons/vendor/crush.wasm`, obtenu par rétro-ingénierie). Le canal *lumen-gate-v2*
> fait ECDH P-256 → HKDF-SHA256 → AES-256-GCM, entièrement dans le wasm ; l'addon se
> contente de le piloter (`seal_request`), POST le corps scellé en **`fetch` natif**
> (pas de curl-impersonate côté serveur) et déchiffre la réponse. Elle porte un master
> HLS dont les variantes vidéo sont muettes (audio en rendition séparée). Pour offrir un
> vrai sélecteur de qualité, l'addon rend **une entrée par palier** : chacune est un
> mini-master reconstruit (la variante + les pistes audio), servi par le proxy en
> *playlist synthétique* (`proxyInlinePlaylist`) — le son est ainsi conservé à la qualité
> exacte choisie. Sans proxy actif, l'addon retombe sur le master brut (une seule entrée).

```bash
curl http://localhost:8787/debug/addons   # lesquels sont chargés, lesquels sont écartés et pourquoi
```

`ENABLED_ADDONS` restreint la liste (vide = tous). C'est un réglage **distinct** de
`ENABLED_SOURCES`, qui ne concerne que les sources Movix.

#### Le proxy de flux

Ces CDN ne servent leurs segments que si la requête porte l'`Origin` et le `Referer` de la
page de lecture officielle. Nuvio et Stremio ne savent pas poser d'en-têtes arbitraires sur
un flux HLS — ils demandent une URL, point. L'addon leur donne donc **une URL à nous**, et
`/proxy/stream` rejoue la signature attendue vers l'amont. C'est le même rôle que
`proxiesembed` côté site, mais piloté par la recette que chaque addon déclare.

À chaque requête, le proxy :

1. **vérifie la signature HMAC** de l'URL — sans elle, la route serait un relais HTTP
   ouvert (même précaution que pour les sous-titres) ;
2. **rejoue les en-têtes** de l'addon, en relayant le `Range` du lecteur ;
3. **réécrit les playlists m3u8** — chaque URI (segment, sous-playlist, clé AES-128,
   `EXT-X-MAP`) repasse par le proxy, sinon le lecteur irait chercher les segments en
   direct et se ferait refuser. Les URI **relatives** héritent des query params du parent
   (les CDN à jeton signent la playlist *et* ses segments avec la même query) ; une URL
   absolue vise un autre service et n'hérite de rien ;
4. **applique les règles par URL** de l'addon. Aurora sert par exemple ses segments
   déguisés en images TikTok, précédées de 8 octets d'amorce qu'aucun démuxeur ne lit :
   ils sont retirés et le vrai type MIME rétabli. Sur une requête `Range`, l'intervalle
   est décalé vers l'amont puis ramené au référentiel du lecteur.

Aucun octet de vidéo n'est bufferisé : tout le reste est un passe-plat en streaming.

**Jamais de compression sur un segment.** Le proxy demande `Accept-Encoding: identity` à
l'amont. Sans ça, axios réclame `gzip` par défaut et l'on relaie un corps *compressé*
accompagné de son `Content-Encoding` — correct pour un navigateur, illisible pour les
lecteurs vidéo, qui ne déchiffrent pas cet en-tête et n'y voient que du bruit. Une vidéo
est déjà compressée : gzip ne lui gagne rien.

**La nature d'une réponse se décide sur ses octets, jamais sur son URL.** Un proxy HLS sert
les playlists *et* les segments sur le même chemin (`…/m3u8-proxy?url=…`) :
trancher sur l'URL revenait à relire des segments vidéo comme du texte UTF-8, donc à les
corrompre (65 540 octets ressortaient à 118 764, chaque octet invalide remplacé par
`U+FFFD`). Le proxy lit maintenant les premiers octets, les remet en tête du flux, et ne
traite comme playlist que ce qui commence par `#EXTM3U`.

**Et quand la playlist parente le sait, on ne devine pas du tout.** HLS dit explicitement
ce que chaque URI référence : la ligne qui suit un `#EXT-X-STREAM-INF` est une variante,
`#EXT-X-MEDIA` pointe une rendition — tandis que `#EXT-X-KEY` désigne une clé AES et
`#EXT-X-MAP` un segment d'initialisation. Le proxy s'appuie sur ces tags, ce qui le rend
insensible aux CDN dont les URL n'ont **aucune extension** (`/pl/H4sIAAAA…`).

#### Sondage des lecteurs (le cas iPad)

Les lecteurs ne demandent pas tous la même chose. AVFoundation (iOS) sonde une ressource
en `HEAD` puis en `Range` ; ExoPlayer (Android) fait un simple `GET`. Une playlist servie
en réponse à un `HEAD` ou à un `Range` doit donc **quand même** être réécrite : sinon le
lecteur reçoit les URL d'origine et va chercher les segments en direct, sans nos en-têtes
ni nos transformations — ce qui rendait tous les flux d'addons injouables sur iPad alors
qu'ils fonctionnaient sur Android.

Deux conséquences dans le code : la réécriture ne dépend ni de la méthode ni du `Range`, et
le `Content-Length` annoncé est celui de **notre** playlist, jamais celui de l'originale
(chaque URI y étant réécrite, les tailles n'ont aucun rapport — relayer celle de l'amont la
faisait tronquer). Les segments, eux, restent pleinement « rangeables » : c'est de la vidéo.

`STREAM_PROXY_LOG=true` journalise ce que le lecteur demande réellement (méthode, `Range`,
issue) — c'est ce qui permet de comparer un appareil qui marche à un autre qui non.

> ⚠️ **`PUBLIC_URL` est obligatoire** pour les addons : les liens proxifiés sont bâtis
> dessus. Vide, ils pointent sur `127.0.0.1` et l'iPad ou la TV qui les reçoit ne les
> lira jamais. Renseigne aussi **`STREAM_PROXY_SECRET`** : sans lui un secret aléatoire
> est tiré à chaque démarrage, et les liens déjà ouverts dans Nuvio cessent de fonctionner
> après un redémarrage.

La sonde de débit suit ces liens comme les autres — elle les ramène sur la boucle locale
au passage, `PUBLIC_URL` visant l'appareil de lecture et non cette machine.

#### Ajouter une source

Un fichier dans `src/addons/`, une ligne dans `MODULES` (`src/addons/index.js`). Rien d'autre :

```js
const kit = require('./kit');

async function getStreams({ tmdbId, type, season, episode }) {
  const { title, year, slug } = await kit.titleOf(type, tmdbId);   // TMDB, mis en cache
  const http = kit.createHttp({ headers: { Referer: 'https://monsite.tld/' } });
  const m3u8 = /* ...ta résolution... */;

  return [{
    url: kit.proxied(m3u8, {
      headers: { origin: 'https://monsite.tld', referer: `https://monsite.tld/film/${slug}` },
      // facultatif: octets d'amorce à jeter / type MIME à forcer, par motif d'URL
      rules: [{ match: 'cdn\\.monsite\\.tld', skipBytes: 8, contentType: 'video/mp2t' }],
      // facultatif: playlists servies sans extension .m3u8
      playlistHints: ['/stream-proxy'],
    }),
    direct: true,
    sourceName: 'MonSite',
    quality: '1080p',
    lang: 'VF',
  }];
}

module.exports = {
  id: 'monsite',
  name: 'MonSite',
  supports: { movie: true, series: false },
  available: () => true,          // false = mal configuré, écarté avec un log
  getStreams,
};
```

L'adaptateur du registre porte deux garanties que l'addon n'a alors plus à redire : une
source n'est pas interrogée pour un type qu'elle ne gère pas, et une source qui échoue rend
une liste vide au lieu de faire tomber la collecte. Le tri, la déduplication sur l'URL
finale, la mesure de débit et l'affichage sont communs à toutes les sources.

#### Détail des deux addons livrés

**Aether** interroge ses serveurs en parallèle, chacun rendant le flux à sa façon :
`aurora` renvoie l'URL m3u8 dans son JSON, `lul` une URL intermédiaire qui répond `302`
vers le master (la redirection ne survivrait pas au passage dans un proxy HLS, elle est
donc résolue en amont), `link` une URL brute dont le CDN n'accepte que l'`Origin` d'un
tiers (`nextgencloudfabric.com`).

`gallic` est la **source VF** du site, et la seule à sortir du lot deux fois : elle vit sur
sa propre base d'API (`AETHER_GALLIC_API`, un Worker Cloudflare) et rend **plusieurs flux
d'un coup**, un par fournisseur, sous `{success, streams: [{title, provider, url}]}`. Ces
liens se lisent avec les en-têtes ordinaires du site — c'est l'API qui diffère, pas la
lecture. Chaque lien porte alors un `variant` (le fournisseur), qui s'affiche dans la ligne
de détail et **sert de clé à l'élagage** : deux fournisseurs différents ne sont jamais des
doublons, ce sont deux replis, et seul un lien surclassé *par le même fournisseur* est
masqué.

L'API ne nomme pas toujours ses fournisseurs — elle les **numérote** (`1`, `2`, `3`), et un
rang ne distingue rien pour qui lit la liste. Le champ `provider` n'est donc retenu que
s'il porte un vrai nom ; sinon c'est le **domaine qui sert le flux** qui nomme le lien
(`sfy-01-fr.vidsonic.net` → `Vidsonic`).

> Si ton `.env` fige `AETHER_SERVERS=aurora,lul,link`, `gallic` n'est pas interrogé et tout
> reste en VO. Le démarrage le dit désormais : `serveur(s) installés mais absents de
> AETHER_SERVERS`. `/debug/addons` liste côte à côte les serveurs demandés et ceux
> installés.

Le site encapsule ce dernier dans son propre proxy HLS (`jbam.aether.bar`) parce qu'un
**navigateur** ne peut ni forger un `Origin` ni échapper au CORS. Un serveur, si : on pose
directement les en-têtes attendus (`AETHER_LINK_ORIGIN`) et on économise le rebond.

Les **séries** passent par les mêmes trois serveurs, au chemin près : `/tv/<id>/<saison>/
<épisode>` au lieu de `/movie/<id>`. Le `Referer`, lui, descend jusqu'à l'épisode et le
désigne par les **ids TMDB internes**, pas par ses numéros —
`/media/tmdb-tv-273240-off-campus/421523/7061243`. Ils viennent d'un appel `/tv/{id}/season
/{n}`, mis en cache **par saison** : une série regardée d'affilée ne le repaye jamais. Si
TMDB ne répond pas, le `Referer` retombe sur la page du titre plutôt que d'abandonner la
résolution — un `Referer` moins précis reste meilleur qu'aucun flux.

Quand un serveur Aether ne joue pas, un diagnostic suit la chaîne **jusqu'à un vrai
segment** et se prononce sur ses **octets**, pas sur son code de statut :

```bash
npm run aether:diag -- 157336        # film
npm run aether:diag -- 273240 1 1    # série : tmdbId saison épisode
```

C'est la seule étape qui prouve quoi que ce soit, et elle a servi deux fois. Un CDN qui
refuse un segment ne répond pas forcément `403` : il sert volontiers une page d'erreur
**en `200`**. Un proxy HLS peut étiqueter de la vidéo en `text/html`. Et un segment reçu
compressé est illisible pour un lecteur. Dans les trois cas le lecteur redemande en boucle
sans jamais démarrer, et rien dans les statuts ne le laisse voir — le diagnostic, lui,
reconnaît `0x47` toutes les 188 octets (MPEG-TS), `ftyp`/`moof` (MP4 fragmenté), `<`
(page HTML) et l'en-tête gzip.

Le proxy applique le même contrôle en fonctionnement, et il en tire une **correction** :
quand l'amont étiquette `text/html` (ou n'étiquette rien) ce qui est en réalité du MPEG-TS
ou du MP4 fragmenté, le `Content-Type` est rectifié avant d'être servi. C'était le cas de
proxys HLS qui rendent leurs segments en `text/html; charset=UTF-8` alors que les octets commencent
bien par `0x47` — le lecteur refusait un segment parfaitement valide, redemandait, et
bouclait. S'il s'agit d'une vraie page d'erreur, rien n'est modifié et un avertissement est
écrit dans les logs.

Le diagnostic espace ses requêtes de 1,5 s et commence par la chaîne complète. Ce n'est pas
de la politesse : le CDN de `link` **limite le débit de requêtes par demandeur**, et une
rafale rapide faisait expirer les requêtes suivantes — le diagnostic déclenchait donc
lui-même la limite qu'il cherchait à mesurer, et concluait à tort que rien ne sortait.

### Lisibilité de la liste

Nuvio regroupe déjà les streams sous le nom de l'addon. Chaque ligne se limite donc à ce
qui distingue *ce* lien des autres :

```
1080p                          au lieu de     Movix
~2.3 Mb/s                                     1036p
FStream · VFQ · uqload                        ~2.3 Mb/s
                                              FStream
                                              VFQ · uqload · ~2.3 Mb/s
```

- le nom de l'addon n'est plus répété sur chaque ligne ;
- le débit n'apparaît plus deux fois ;
- les hauteurs exotiques des masters HLS (`1036p`, `468p` — recadrages, encodages
  anamorphiques) sont ramenées au **palier** correspondant, à 10 % près ;
- un libellé de source déjà composé (`pulse | 1080p | MULTI`) perd la résolution qui y
  faisait doublon.

**Le palier se lit sur la largeur, pas sur la hauteur.** Un film en 2.40:1 est encodé
`1920x800` : juger sur la hauteur le faisait passer pour du **720p** alors que son image
est exactement aussi définie qu'un `1920x1080` — les 280 lignes d'écart sont des bandes
noires qui n'existent pas dans le fichier. C'est le cas de la plupart des grosses
productions. La hauteur ne sert plus qu'à défaut : master sans `RESOLUTION`, fichier
direct, ou libellé de source (`1080p`). L'inverse est vrai aussi : un vieux `1024x768`
sort en `720p` et non en `1080p`.

| Résolution réelle | Affiché |
|---|---|
| `1920x800` (scope) | **1080p** |
| `1920x1080` | 1080p |
| `1280x534` | 720p |
| `1024x768` (4:3) | 720p |
| `3840x1600` (scope 4K) | **4K** |

Ce palier sert aussi au **tri** et à l'**élagage** : sans ça, deux liens seraient comparés
sur une échelle et affichés sur une autre — et un `1280x800` aurait éliminé un `1920x800`,
les deux se valant en hauteur. `/debug/streams` montre `resolution` (brute) et `palier`.

#### Tout garder, ou masquer les redondances

`STREAM_LIST` choisit entre les deux :

| Valeur | Effet |
|---|---|
| `compact` *(défaut)* | Écarte les liens qu'un autre de la **même source et du même fournisseur** surclasse à la fois en résolution **et** en débit — personne ne choisit le 480p à 1,1 Mb/s quand le même fournisseur donne 1080p à 2,3 — puis limite à `MAX_STREAMS_PER_SOURCE`. |
| `complet` | Propose **tout** ce qui a été résolu, sans rien masquer. |

Sur une liste réelle de 8 liens : 6 en `compact`, 8 en `complet`.

`MAX_STREAMS_PER_SOURCE` (2 par défaut) ne s'applique qu'en mode compact. En garder plus
d'un préserve un repli quand un hébergeur est en panne ; `0` lève la limite sans pour
autant réintroduire les liens redondants.

L'élagage est **purement un choix d'affichage** : `/debug/streams` montre dans tous les cas
la totalité de ce qui a été résolu, avec `mode` et `affichesDansNuvio` pour comparer.

### Débit affiché

Chaque stream annonce son **débit** à côté de la résolution. L'objectif est que deux liens
soient *comparables* : toutes les valeurs représentent le débit **moyen**.

- **Master HLS avec `AVERAGE-BANDWIDTH`** — valeur déclarée et exacte, prise telle quelle.
  La résolution lue là est plus fiable qu'un libellé « HD » de la source.
- **Master HLS sans `AVERAGE-BANDWIDTH`** — `BANDWIDTH` est le débit de **pointe** que le
  lecteur doit pouvoir soutenir, pas la moyenne du fichier : il la dépasse de 10 à 50 %.
  On descend donc mesurer la variante retenue, et le pic ne sert que de dernier recours
  (signalé `~`).
- **Playlist de segments** — on pèse `PROBE_SEGMENT_SAMPLES` segments (5 par défaut)
  **répartis sur toute la durée**, début écarté, et on divise la somme des tailles par la
  somme des durées `EXTINF`. Une playlist en `EXT-X-BYTERANGE` annonce ses tailles :
  aucune requête n'est alors nécessaire.
- **Fichier direct** — taille divisée par la durée TMDB. Estimation, préfixée `~`. Si la
  durée est inconnue (épisode dont TMDB ignore le runtime), la **taille** est affichée.

La taille d'un segment est obtenue par `HEAD`, sinon par un `GET Range` **coupé dès les
en-têtes lus** — un serveur qui ignore `Range` commence à renvoyer le segment entier, et
rien n'oblige à le télécharger pour apprendre sa taille. Quand aucune de ces voies
n'aboutit (ni `HEAD`, ni `Content-Length`, ni `Content-Range`), un seul segment est pesé
en le téléchargeant : la précision d'un échantillonnage large ne vaut pas plusieurs
dizaines de Mo à chaque ouverture de fiche.

> **Pourquoi un seul prélèvement ne suffisait pas.** Sur un profil VBR simulé (fond à
> 6 Mb/s, amorce légère, quelques scènes d'action à 15 Mb/s), un prélèvement unique donne
> **26 % d'erreur moyenne et 93 % au 90ᵉ centile** — d'où des valeurs qui paraissent
> tirées au sort. À 5 prélèvements : 13 % et 21 %. Au-delà de 5-6, le gain devient
> marginal. `PROBE_SEGMENT_SAMPLES` règle ce curseur.

```bash
curl http://localhost:8787/debug/streams/movie/tmdb:157336
```

donne, par lien, la valeur obtenue et **d'où elle vient** — `declare` (lue dans le
master), `mesure` (calculée sur N segments pesés) ou `aucun` — ce que le libellé affiché
dans Nuvio ne permet plus de distinguer.

Les hosters exigent presque tous un `Referer` de leur propre domaine, sinon `HEAD` et
`GET` répondent 403 — c'est pourquoi seul PurStream (master HLS servi sans contrôle)
était mesuré au départ. **Le site ne les joint pas davantage depuis le navigateur** : il
passe par son proxy (`buildProxyUrl`, `src/config/runtime.ts:19`), qui pose les
`Origin`/`Referer` attendus par domaine (`API/miscs/bypass403.py:120`).

**Le site ne lit jamais ces flux en direct** : `proxiesembed` expose une route de proxy
**par hébergeur** (`/voe-proxy`, `/uqload-proxy`, `/fsvid-proxy`… — `server.py:1491`), et
chacune applique l'`Origin`, le `Referer`, l'`User-Agent` et le `Host` que *son* CDN
attend. Ce ne sont pas des en-têtes devinés depuis l'URL : ce sont ceux de la page de
lecture officielle du service.

La sonde emprunte donc le même chemin, dans cet ordre :

1. **l'amont directement**, quand le lien est un lien de proxy (voir ci-dessous) ;
2. la route dédiée de l'hébergeur, via `PROXIES_EMBED_BASE_URL` (déjà configuré pour
   l'extraction) — la seule dont on sait qu'elle fonctionne ;
3. en direct, avec le referer de la page d'embed ;
4. `PROBE_PROXY_BASE_URL` s'il est renseigné (facultatif).

Couverts par une route dédiée : voe, fsvid, vidzy, vidmoly, sibnet, uqload, doodstream,
seekstreaming. Les autres (supervideo, dropload, darkibox, oneupload) passent en direct.

Les streams sont triés : langue préférée d'abord (français par défaut), puis résolution,
puis **débit** — à résolution égale, c'est lui qui sépare un vrai 1080p d'un upscale
compressé. `PROBE_BITRATE=false` désactive la mesure si l'ouverture des fiches devient
lente (elle coûte un aller-retour par lien, mis en cache ensuite).

### Ce qui rend l'ouverture d'une fiche lente

Les sources sont interrogées en parallèle depuis le début ; ce qui s'allongeait, c'est ce
qui vient **après** elles. Trois causes, trois réponses.

**La sonde mesurait à travers notre propre proxy.** Un lien d'addon pointe sur
`PUBLIC_URL` : mesurer ce lien faisait sortir la requête de la machine, revenir par le
domaine public, puis faire télécharger au proxy la playlist entière **et la réécrire ligne
par ligne** — des centaines d'URI signées — pour n'en lire que les durées `EXTINF`. Un
travail dont la sonde n'a aucun usage, payé à chaque lien et à chaque ouverture de fiche :
c'est ce qui saturait les 3,5 s de `PROBE_TIMEOUT_MS` et laissait ces liens
systématiquement « sans débit mesuré ». La sonde relit maintenant la cible **et les
en-têtes** depuis le lien signé, et joint le CDN directement. Sur le banc : **0 requête au
proxy, mesure complète en 73 ms**. Le passage par le proxy reste en repli.

**Un service en panne l'est pour tous ses liens.** `seekstreaming` rendait cinq `502`
d'affilée par fiche, chacun payé au prix d'un aller-retour et d'un délai d'attente. Un
**disjoncteur** l'écarte après `HOSTER_FAILURE_STREAK` pannes, pour `HOSTER_COOLDOWN_MS`.
Seules les **pannes de service** comptent (`5xx`, timeout, erreur réseau) : un `400` ou un
`404` parle d'*une* vidéo (`Uqload media URL not found`) et ne dit rien des suivantes — les
compter reviendrait à couper un hébergeur en bon état parce que trois de ses vidéos ont été
supprimées. `/debug/extract` affiche les hébergeurs écartés (`ecartes`), sans quoi un
`0/3` ressemblerait à une extraction ratée alors qu'aucune requête n'est partie.

Le même disjoncteur couvre les **voies de mesure** : `vidzy-proxy` dépasse régulièrement
les 3,5 s, et chaque lien vidzy repayait ce délai avant de tomber sur le repli. Seules les
voies qui sont des **services partagés** y sont soumises (`<hébergeur>-proxy`, `proxy`) —
`amont` et `direct` visent chacun un CDN différent, généraliser n'aurait aucun sens.
`/debug/streams` les liste sous `ecartes`.

**Une sonde lente retardait la liste entière.** `PROBE_PHASE_BUDGET_MS` (9 s) borne la
phase de mesure pour une ouverture de fiche : au-delà, les liens restants sont rendus
**sans débit** plutôt que de faire attendre. Rien n'est alors mis en cache — un « aucune
mesure » dû au manque de temps se figerait sinon pour `CACHE_EMPTY_TTL_MS`, et le lien
resterait sans débit pendant des minutes alors qu'il était mesurable.

`PROBE_CONCURRENCY` (10) et `EXTRACT_CONCURRENCY` (6) règlent le front de chaque phase :
les mesures attendent surtout le réseau, les extractions tapent un service unique qu'il
est inutile de bousculer.

#### Répondre avant d'avoir tout mesuré

La liste part au bout de `STREAM_FIRST_ANSWER_MS` (2,5 s) avec les débits **déjà** obtenus.
Les sondes restantes ne sont pas abandonnées : elles continuent, et **remplacent l'entrée de
cache** quand elles ont fini. Comme Nuvio redemande `/stream` à chaque ouverture de fiche,
ce qui manquait au premier affichage est là au second — sans avoir fait attendre personne.

Le compromis est explicite : au tout premier affichage d'un titre, quelques liens peuvent
apparaître sans débit. `STREAM_FIRST_ANSWER_MS=0` rétablit l'ancien comportement (tout
attendre). `/debug/streams` passe `wait: true` et voit toujours l'état **final**, sinon il
décrirait un état transitoire et on diagnostiquerait un débit manquant qui n'en est pas un.

**Une liste ne rétrécit pas.** Ce point a demandé un choix. L'élagage a besoin des débits :
tant qu'ils manquent, il ne peut rien conclure. Garder ces liens « au bénéfice du doute »
les faisait apparaître au premier affichage puis **disparaître** au second, une fois mesurés
et jugés redondants — une liste qui se vide sous les yeux inquiète, à raison. L'élagage est
donc **pessimiste** sur les liens non mesurés : un lien sans débit est écarté dès qu'un
autre de la même source **et du même fournisseur** le vaut en résolution. Même source, même
fournisseur, résolution supérieure ou égale : c'est le même film dans une autre définition,
pas un repli. Le premier affichage est alors un sous-ensemble du second, et la liste ne peut
que s'étoffer.

#### Forcer un nouveau scan

Un cache de 30 minutes veut dire qu'un lien mis en ligne entre-temps ne se verra pas. Le
protocole Stremio n'a pas de bouton « recharger » : une demande de streams ressemble à
toutes les autres. Mais **rouvrir la même fiche trois fois en 25 secondes n'est pas un
hasard** — c'est qu'on cherche autre chose que ce qui s'affiche. Ce geste est le seul signal
disponible, et il déclenche un scan complet, cache ignoré.

Le seuil est à 3 (`STREAM_REFRESH_HITS`) parce que l'ouverture compte pour un et que
certains lecteurs demandent les streams deux fois pour une seule ouverture : à 2, le cache
ne servirait jamais. Le compteur repart à zéro après un scan.

Un rescan **ne perd jamais un lien**. Les liens du scan précédent qui ne ressortent pas sont
conservés, avec leurs mesures : une source peut être muette un tour (502, timeout, changement
de domaine) sans que ses liens soient morts pour autant, et rafraîchir pour obtenir *moins*
de choix serait l'inverse du but recherché. Ils disparaîtront d'eux-mêmes à l'expiration.

Les mesures qui avaient **échoué** sont retentées ; celles qui avaient abouti sont gardées —
elles ne changent pas d'un scan à l'autre et coûtent cher à refaire. `STREAM_TTL_MS` règle
au bout de combien de temps un nouveau lien apparaît **tout seul**, sans rien demander.

#### Préparer l'épisode suivant

Quand une fiche d'épisode s'ouvre, la suite est prévisible : c'est l'épisode d'après. Il est
résolu en tâche de fond, `PREFETCH_DELAY_MS` après la réponse (le temps que la fiche en
cours finisse ses propres mesures), et son ouverture est alors immédiate.

Le coût est d'**une** résolution — là où précharger un catalogue entier en coûterait des
dizaines pour rien. L'existence de l'épisode est vérifiée auprès de TMDB avant de lancer
quoi que ce soit : une fin de saison ne déclenche pas un tour complet de scraping pour un
épisode qui n'existe pas. `PREFETCH_NEXT_EPISODE=false` le désactive.

#### Un cache qui survit au redémarrage

Tout était en mémoire : un `npm start` repartait de zéro et la première ouverture de chaque
fiche repayait le scraping, l'extraction **et** la mesure de débit. Le cache est maintenant
écrit dans `data/cache.json` (toutes les `CACHE_SAVE_INTERVAL_MS`, et à l'arrêt).

L'écriture est **atomique** — fichier temporaire puis `rename` : une coupure en plein write
laisserait sinon un JSON tronqué, et le cache serait perdu au démarrage suivant, ce qu'on
cherche précisément à éviter. Les entrées portent leur date d'expiration : celles qui l'ont
dépassée ne sont ni écrites ni relues. Un fichier illisible est ignoré et le serveur démarre
sur un cache vide.

## Diagnostic

Quand Nuvio affiche « aucun stream », deux endpoints donnent l'état réel :

```bash
curl http://localhost:8787/health                      # config chargée, clé VIP présente ?
curl http://localhost:8787/debug/movie/tmdb:157336     # ce que chaque source a renvoyé
curl http://localhost:8787/debug/addons                # addons chargés / écartés, état du proxy
curl http://localhost:8787/debug/extract/movie/tmdb:157336   # sort de chaque embed, et pourquoi
curl http://localhost:8787/debug/streams/movie/tmdb:157336   # débit mesuré par lien, et son origine
curl "http://localhost:8787/debug/subsync/movie/tmdb:157336?compute=1"  # calage des sous-titres
```

Côté synchronisation :

```bash
curl http://localhost:8787/hub/status                  # dernier cycle, erreurs éventuelles
curl http://localhost:8787/debug/sync                  # ce que Movix renvoie
curl http://localhost:8787/debug/nuvio/duplicates      # entrées encore identifiées en IMDb
curl http://localhost:8787/debug/nuvio/api             # tables et RPC réellement exposées par Nuvio
```

`/debug` liste chaque lien brut avec sa source et l'extracteur détecté — un lien marqué
`AUCUN EXTRACTEUR` est un embed que Stremio/Nuvio ne peuvent pas lire nativement.

La console détaille aussi, par source, le nombre de liens et la raison d'un échec
(status HTTP, corps de réponse, champ URL manquant).

## Limites connues

- **Pas de DRM** : le sous-système `drmproxy` (Netflix, Canal+, etc.) est volontairement
  exclu — contourner un DRM commercial reste illégal, y compris en usage privé.
- **Certains embeds restent inexploitables** : `vidara.to`, `lecteurvideo.com`,
  `p2pstream.vip` n'ont pas d'extracteur côté Movix (le site les lit via l'extension
  navigateur, qui n'a pas d'équivalent serveur). `SHOW_UNPLAYABLE_EMBEDS=true` les
  expose en « ouvrir dans le navigateur » plutôt que de les masquer.
- **Les lecteurs iframe du site ne sont pas portables** : Frembed
  (`frembed.click/api/film.php`), Videasy, VidSrc, Rivestream sont des pages web
  embarquées, pas des flux vidéo. Le site les affiche dans un iframe ; Stremio et
  Nuvio attendent une URL vidéo directe et ne peuvent donc pas les lire. C'est la
  principale raison d'un écart de nombre de liens avec le site.
- **Darkino / Nightflix est retiré côté site** (`WatchMovie.tsx:313`), il n'y a donc
  rien à intégrer de ce côté.
- **Sous-titres** : nécessite `PUBLIC_URL` correctement renseignée, sinon l'appareil de
  lecture ne saura pas joindre la route de conversion. L'URL servie encode la source dans
  le **chemin** (`/subtitle/<base64url>.vtt`) et non plus en paramètre de requête : rien à
  tronquer ni à réécrire en route, et l'extension rassure les lecteurs qui la vérifient.
  L'ancienne forme `?src=` reste acceptée pour les liens déjà distribués.
  OpenSubtitles est interrogé **une langue par requête** (`sublanguageid-fre`, puis
  `sublanguageid-eng`) : la forme groupée `fre,eng` répond `400`, donc aucun sous-titre.

| Réglage | Défaut | Effet |
|---|---|---|
| `SUBTITLES_PER_LANG` | `1` | Pistes proposées par langue, les plus téléchargées d'abord. Au-delà de 1, elles portent **toutes le même nom de langue** : le protocole ne les distingue que par leur `id`, jamais à l'écran. |
| `SUBTITLE_PROVIDER_LABEL` | `false` | Affiche `· OpenSubtitles` à côté de la langue. |

Le champ `lang` est un **code**. La spécification dit qu'un libellé libre est affiché tel
quel, mais Nuvio normalise ce champ et rend « inconnu » tout ce qu'il ne reconnaît pas —
c'est ce qui arrivait quand on suffixait les pistes (`fre (2)`, `fre (3)` : deux langues
donnaient deux pistes nommées et **quatre « inconnu »**). D'où le défaut à un code pur, et
le libellé du fournisseur derrière un réglage : à n'activer que si ton lecteur suit la
spécification.
- **Obrigoz : films uniquement.** Sa grille de recherche est une grille de films
  (`#search-film-grid`), sans notion de saison ni d'épisode. Aether, lui, gère les deux.
- **Les flux des addons dépendent du proxy** : ils passent tous par `PUBLIC_URL`, qui doit
  être joignable depuis l'appareil de lecture. `STREAM_PROXY_ENABLED=false` sert le lien
  brut, que la plupart de ces CDN refuseront.
