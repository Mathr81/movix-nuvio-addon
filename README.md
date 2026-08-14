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

## Ce que l'addon fournit

| Ressource | Détail |
|-----------|--------|
| `catalog` | Catalogues personnels (sync compte), recommandations, Tendances / Populaires / Mieux notés / Nouveautés, filtrables par genre, avec recherche |
| `meta` | Fiches complètes, épisodes par saison, casting, genres |
| `stream` | Agrégation de 7 sources Movix + extraction serveur des embeds |
| `subtitles` | OpenSubtitles, converti à la volée en WebVTT |

### Catalogues personnalisables

Trois niveaux, du plus simple au plus libre :

1. **Choisir et ordonner** les rangées intégrées — `CATALOGS` dans `.env` :
   ```bash
   CATALOGS=continue,watchlist,reco,trending,popular
   ```
   Ids disponibles : `continue`, `watchlist`, `favorites`, `reco`, `trakt-reco`,
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

Si `MOVIX_JWT` + `MOVIX_USER_ID` sont renseignés, trois rangées supplémentaires
apparaissent, alimentées par les mêmes données que le site (`/api/sync`) :
**Reprendre** (avec `S2E5 · 80 %` dans le libellé), **Ma liste**, **Favoris**.

> Le protocole Stremio ne permet pas à un addon de positionner la reprise de lecture :
> la progression est affichée, mais la lecture redémarre au début. Pour une vraie
> reprise, utilise le push vers Nuvio Sync ci-dessous.

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

### Sources agrégées

`PurStream` (liens directs), `Links` (liens communautaires Movix — les `.mp4` sont
directement jouables), `Coflix`, `FrenchStream`, `FStream`, `Wiflix`, `Cpasmal`,
`1jour1film`, `Voirdrama` (séries asiatiques).

Les embeds sont résolus en URLs directes pour **12 hosters** — soit tous
ceux que le site sait extraire côté serveur : voe, uqload, vidzy, fsvid, vidmoly, sibnet,
doodstream, seekstreaming (via `proxiesembed`), supervideo, dropload (via Mainapi),
darkibox et oneupload (scraping HTML direct).

`smoothpre` et `minochinos` figurent dans le registre du site mais n'ont **aucun**
extracteur (ni serveur, ni extension) — ce sont uniquement des motifs de détection pour
l'ordre de priorité. Rien à porter.

### Débit affiché

Chaque stream annonce son **débit** à côté de la résolution :

- **Master HLS** — il déclare lui-même `BANDWIDTH` et `RESOLUTION` par variante. Valeur
  exacte, et la résolution lue là est plus fiable qu'un libellé « HD » de la source.
- **Playlist de segments** (ce que renvoie la plupart des hosters une fois extraits) —
  pas de `BANDWIDTH`, mais on pèse un segment et on le divise par sa durée `EXTINF`.
- **Fichier direct** — taille (`HEAD`, ou `GET Range` si le hoster refuse `HEAD`) divisée
  par la durée TMDB. Estimation, préfixée `~`. Si la durée est inconnue (épisode dont
  TMDB ignore le runtime), la **taille** est affichée à la place.

Les hosters exigent presque tous un `Referer` de leur propre domaine, sinon `HEAD` et
`GET` répondent 403 — c'est pourquoi seul PurStream (master HLS servi sans contrôle)
était mesuré au départ. **Le site ne les joint pas davantage depuis le navigateur** : il
passe par son proxy (`buildProxyUrl`, `src/config/runtime.ts:19`), qui pose les
`Origin`/`Referer` attendus par domaine (`API/miscs/bypass403.py:120`).

Renseigne donc `PROBE_PROXY_BASE_URL`. Deux façons de l'obtenir :

```bash
# le plus simple: lancer le proxy du dépôt, il a déjà les en-têtes par domaine
python API/miscs/bypass403.py           # écoute sur 25568
PROBE_PROXY_BASE_URL=http://127.0.0.1:25568
```

ou reprendre la valeur de `VITE_PROXY_BASE_URL` du site (le worker Cloudflare). Les deux
exposent la même route `/proxy/<url>`.

Les streams sont triés : langue préférée d'abord (français par défaut), puis résolution,
puis **débit** — à résolution égale, c'est lui qui sépare un vrai 1080p d'un upscale
compressé. `PROBE_BITRATE=false` désactive la mesure si l'ouverture des fiches devient
lente (elle coûte un aller-retour par lien, mis en cache ensuite).

## Diagnostic

Quand Nuvio affiche « aucun stream », deux endpoints donnent l'état réel :

```bash
curl http://localhost:8787/health                      # config chargée, clé VIP présente ?
curl http://localhost:8787/debug/movie/tmdb:157336     # ce que chaque source a renvoyé
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
  lecture ne saura pas joindre la route de conversion.
