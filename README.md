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

Le serveur écoute sur **toutes les interfaces** — l'IP LAN ou Tailscale du serveur
fonctionne donc directement. Le message `HTTP addon accessible at: http://127.0.0.1:...`
affiché par le SDK est une chaîne fixe, pas le reflet du binding réel.

## Ce que l'addon fournit

| Ressource | Détail |
|-----------|--------|
| `catalog` | Catalogues personnels (sync compte) + Tendances / Populaires / Mieux notés / Nouveautés, filtrables par genre, avec recherche |
| `meta` | Fiches complètes, épisodes par saison, casting, genres |
| `stream` | Agrégation de 7 sources Movix + extraction serveur des embeds |
| `subtitles` | OpenSubtitles, converti à la volée en WebVTT |

### Catalogues personnels (sync compte Movix)

Si `MOVIX_JWT` + `MOVIX_USER_ID` sont renseignés, trois rangées supplémentaires
apparaissent, alimentées par les mêmes données que le site (`/api/sync`) :
**Reprendre** (avec `S2E5 · 80 %` dans le libellé), **Ma liste**, **Favoris**.

> Le protocole Stremio ne permet pas à un addon de positionner la reprise de lecture :
> la progression est affichée, mais la lecture redémarre au début. C'est une limite du
> protocole, pas de l'implémentation.

### Sources agrégées

`PurStream` (liens directs), `Coflix`, `FrenchStream`, `FStream`, `Wiflix`, `Cpasmal`,
`1jour1film`. Les embeds sont résolus en URLs directes pour **12 hosters** — soit tous
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
- **Sous-titres** : nécessite `PUBLIC_URL` correctement renseignée, sinon l'appareil de
  lecture ne saura pas joindre la route de conversion.
