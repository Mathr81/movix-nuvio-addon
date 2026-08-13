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
| `catalog` | Tendances + populaires (films & séries), avec recherche — via TMDB |
| `meta` | Fiches complètes, épisodes par saison, casting, genres |
| `stream` | Agrégation de 7 sources Movix + extraction serveur des embeds |
| `subtitles` | OpenSubtitles, converti à la volée en WebVTT |

### Sources agrégées

`PurStream` (liens directs), `Coflix`, `FrenchStream`, `FStream`, `Wiflix`, `Cpasmal`,
`1jour1film`. Les embeds sont résolus en URLs directes via `proxiesembed` pour 10 hosters
(voe, uqload, vidzy, fsvid, vidmoly, sibnet, doodstream, seekstreaming, supervideo, dropload).

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
- **Certains embeds sont inexploitables** : `vidara.to`, `lecteurvideo.com`,
  `p2pstream.vip` n'ont pas d'extracteur côté Movix (le site les lit via l'extension
  navigateur, qui n'a pas d'équivalent serveur). `SHOW_UNPLAYABLE_EMBEDS=true` les
  expose en « ouvrir dans le navigateur » plutôt que de les masquer.
- **Sous-titres** : nécessite `PUBLIC_URL` correctement renseignée, sinon l'appareil de
  lecture ne saura pas joindre la route de conversion.
