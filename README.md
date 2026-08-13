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

> Le sens est Movix → Nuvio uniquement. Ce que tu regardes *dans* Nuvio ne remonte pas
> vers le site : Nuvio ne notifie pas les addons de la lecture. Le pont Trakt ci-dessous
> résout ce point.

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
| Watchlist + Favoris | `plantowatch` (Simkl n'a pas de favoris distincts) |

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

Les streams sont triés : langue préférée d'abord (français par défaut), puis résolution
décroissante.

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
