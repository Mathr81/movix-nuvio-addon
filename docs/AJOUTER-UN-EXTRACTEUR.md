# Ajouter un extracteur d'hébergeur

Un **extracteur** transforme un lien d'embed (`https://hebergeur.tld/e/abc123`) en URL de
flux jouable (`.m3u8` ou `.mp4`). Tout passe par `src/streaming/hosterExtract.js`. Les
extracteurs complexes (déchiffrement) ont leur propre module : `hosterVoe.js`,
`hosterVeev.js` et `hosterByse.js`.

## 1. Comment un lien arrive jusqu'à l'extracteur

```
source (Movix, FStream, …) ─► src/sources/resolved.js
        │  le serveur a déjà résolu ? ─► flux direct, rien à faire ici
        │  sinon, hasLocalExtractor(url) ? ─► garde l'embed + serverFallback
        ▼
src/streaming/streamBuilder.js ─► extractDirectUrl(embedUrl, playerNameHint)
        ▼
detectHoster()      : quel hébergeur ? (motifs d'URL + libellé du lecteur)
LOCAL_EXTRACTORS ?  : sinon → { ok:false, reason:'server-only' }
disjoncteur ouvert ? : sinon → { ok:false, reason:'cooldown' }
branche de l'hébergeur → { ok:true, url, hoster }
```

Valeurs de retour de `extractDirectUrl` :

| Résultat | Signification |
|---|---|
| `{ ok: true, url, hoster }` | Flux trouvé (souvent déjà proxifié). |
| `reason: 'no-extractor'` | Hébergeur inconnu, et le repli jwplayer générique n'a rien trouvé. |
| `reason: 'server-only'` | Hébergeur reconnu, mais seul Movix sait l'extraire (clé VIP). |
| `reason: 'deleted'` | La page a répondu : la vidéo n'existe plus. |
| `reason: 'no-url-field'` | La page a répondu, mais aucune source trouvée dedans. |
| `reason: 'http-error'` | Panne réseau ou HTTP (+ `status`). |
| `reason: 'cooldown'` | Disjoncteur ouvert après plusieurs pannes d'affilée. |

## 2. Avant d'écrire du code : étudier l'hébergeur

1. Ouvre l'embed dans un navigateur, onglet **Réseau** filtré sur `m3u8|mp4|api`.
2. Repère d'où vient l'URL du flux. Du plus simple au plus pénible :
   - **en clair dans le HTML** : `file: "…m3u8"`, `sources: [{src: …}]` ;
   - **dans un script P.A.C.K.E.R.** (`eval(function(p,a,c,k,e,d)…`) : `unpackPacker()` le
     dépaquète sans l'exécuter ;
   - **API JSON** appelée par le lecteur (ex. streamorigin : `/app/v1/play/<code>`) ;
   - **redirection** vers un autre hébergeur (ex. trakx, upns) : on suit le lien, puis
     on relance la détection sur la cible ;
   - **API chiffrée** (ex. byse en AES-GCM, veev) : module dédié.
3. Teste le flux avec `curl`, **depuis le VPS** :
   - sans en-têtes ;
   - avec `Origin` / `Referer` de la page d'embed ;
   - pour un segment aussi, pas seulement pour la playlist.

   Ce test dit s'il faut le proxy (en-têtes, ou jeton lié à l'IP `i=` / `asn=`) et s'il
   faut le tunnel NAS (le CDN refuse l'IP du VPS).
4. **Limite :** on n'implémente pas de contournement anti-bot. Les hébergeurs suivants
   restent `server-only` ou sans extracteur :
   - challenge Cloudflare (doodstream, savefiles) ;
   - empreinte canvas/WebGL forgée (vidzy et fsvid, jeton `gk`) ;
   - détection de navigateur automatisé (turboembed).

## 3. Les étapes dans `hosterExtract.js`

### a. Déclarer les motifs d'URL — `BUILTIN_HOSTER_PATTERNS`

```js
monhebergeur: ['monhebergeur', 'miroir-anonyme\\.com'],
```

- Ce sont des regex (chaînes, insensibles à la casse), testées sur `url + libellé du
  lecteur`.
- **L'ordre des clés compte** : la première qui correspond gagne. Par exemple, `veev` passe
  avant `doodstream` parce que `doods.to` contient `dood`.
- Si le nom est distinctif, un simple mot suffit. Pour des domaines anonymes, il faut une
  liste explicite (cf. les alias de voe).
- Un nouveau domaine pour un hébergeur **déjà connu** n'exige aucun code :
  `HOSTER_PATTERNS_EXTRA=voe:nouveaudomaine` dans `.env`.

### b. Le déclarer extractible localement — `LOCAL_EXTRACTORS`

Ajoute le nom au `Set`. Sans ça, `extractDirectUrl` répond `server-only`, et
`resolved.js` ne garde pas l'embed en secours.

Si c'est un simple lecteur jwplayer (source dans le HTML ou un P.A.C.K.E.R.), ajoute-le
plutôt à `JWPLAYER_HOSTERS`. **C'est fini** : `extractJwPlayer()` s'en charge, flux
proxifié avec l'Origin/Referer de l'embed. Essaie toujours cette voie d'abord.

### c. Écrire la fonction d'extraction

Elle renvoie l'URL du flux, ou `null` si la vidéo est morte. Elle **laisse remonter** les
erreurs réseau : c'est `extractDirectUrl` qui les compte pour le disjoncteur. Modèle,
tiré de `extractStreamOrigin` :

```js
/**
 * Monhebergeur (monhebergeur.tld/e/<code>): le lecteur lit `GET /api/source/<code>`
 * (JSON en clair, AAAA-MM). `null` = video supprimee.
 */
async function extractMonHebergeur(embedUrl) {
  const { origin, pathname } = new URL(embedUrl);
  const code = pathname.split('/').filter(Boolean).pop();
  if (!code) return null;
  const { data } = await axios.get(`${origin}/api/source/${code}`, {
    timeout: 8000,
    validateStatus: (status) => status < 500, // 4xx = video morte, 5xx = panne (exception)
    headers: { 'User-Agent': BROWSER_UA, Referer: embedUrl },
  });
  return typeof data?.hls === 'string' && /^https?:\/\//.test(data.hls) ? data.hls : null;
}
```

Outils déjà disponibles :

| Outil | Rôle |
|---|---|
| `fetchEmbedHtml(url, referer?)` | HTML de la page, avec un User-Agent de navigateur. |
| `firstMatch(html, [regex…])` | Premier groupe 1 trouvé parmi plusieurs regex. |
| `unpackPacker(html)` | Dépaquète un P.A.C.K.E.R. par substitution, sans `eval`. |
| `resolveRedirect(url)` | Cible d'un `Location` ou d'un `location.href = …`. |
| `proxyFromEmbed(url, embedUrl)` | Proxifie avec l'Origin/Referer de l'embed. |
| `streamProxy.proxyUrl(url, spec)` | Proxy avec un spec sur mesure (voir §4). |

### d. La brancher dans `extractDirectUrl`

Le cas le plus simple (pas de règle de proxy spéciale) : l'ajouter au branchement
existant.

```js
if (JWPLAYER_HOSTERS.has(hoster) || hoster === 'streamorigin' || hoster === 'monhebergeur') {
  const url = hoster === 'streamorigin' ? await extractStreamOrigin(embedUrl)
    : hoster === 'monhebergeur' ? await extractMonHebergeur(embedUrl)
    : await extractJwPlayer(embedUrl);
```

Ce bloc gère déjà `noteRecovery`, le proxy et les erreurs. Si l'hébergeur a besoin d'un
autre traitement (sharecloudy et son type MIME, darkibox sans proxy), écris une branche
`if (hoster === 'monhebergeur') { … }` sur le modèle de celles qui existent. Respecte ces
règles :

- appelle `extractBreaker.noteRecovery(hoster)` dès que le service a répondu ;
- dans le `catch`, appelle `noteOutage(hoster)` **seulement** si
  `!status || status >= 500` ;
- renvoie un objet `{ ok, reason, hoster }`, jamais d'exception.

**Redirecteur** (l'embed ne fait que pointer vers un autre hébergeur) : ajoute-le à la
condition `hoster === 'redirector' || …` et renvoie la cible. La détection est relancée
dessus.

### e. Mettre à jour le commentaire d'en-tête

Le gros commentaire en haut du fichier liste tous les extracteurs locaux. Ajoute une
ligne : le nom et comment il est lu.

## 4. Proxy de flux : quand et comment

Le proxy (`src/streaming/streamProxy.js`) relaie playlists et segments en ajoutant des
en-têtes. Il réécrit les playlists pour que les segments repassent par lui. Il le faut
quand :

- le CDN exige `Origin` / `Referer` (403 ou 404 sans eux) ;
- le jeton est lié à l'IP qui a fait l'extraction (`i=`, `asn=`) ;
- le CDN envoie un mauvais `Content-Type` → `rules` :

```js
streamProxy.proxyUrl(url, {
  headers: { accept: '*/*', origin, referer: `${origin}/`, 'user-agent': BROWSER_UA },
  rules: [{ match: '\\.ts(?:$|\\?)', contentType: 'video/mp2t' }],      // sharecloudy
  // rules: [{ match: '\\.png(?:$|\\?)', contentType: 'video/mp4' }],    // segments déguisés
  // playlistVia: 'MOVY_PROXY_URL',  // playlists via le tunnel NAS (IP résidentielle)
  // allVia: true,                   // ET les segments (CDN qui refuse le VPS partout)
});
```

Toujours garder `config.STREAM_PROXY_ENABLED ? proxyUrl(...) : url` : sans proxy, l'URL
brute.

## 5. Tester

### Test unitaire

Dans `test/hosterExtract.test.js`, au minimum la détection :

```js
test('monhebergeur est reconnu', () => {
  assert.strictEqual(detectHoster('https://monhebergeur.tld/e/abc'), 'monhebergeur');
  const { hasLocalExtractor } = require('../src/streaming/hosterExtract');
  assert.ok(hasLocalExtractor('https://monhebergeur.tld/e/abc'));
});
```

Si tu as écrit un décodage non trivial (regex délicate, déchiffrement), teste-le à part
avec une entrée figée, sans réseau. Exemples : `unpackPacker`, `decryptPlayback` de byse.

```bash
node --test test/*.test.js
```

### Essai réel, dans le container

```bash
docker exec -w /app movix-addon node -e "
require('./src/streaming/hosterExtract').extractDirectUrl('https://monhebergeur.tld/e/abc')
  .then(r => console.log(r))"
```

Puis vérifie que l'URL renvoyée se lit vraiment : la playlist, **et un segment**. Un
`200` sur le master ne prouve rien si les segments répondent `403`.

### Sur un vrai titre

- WebUI → fiche du titre → bloc **Extraction** (`/ui/api/title/<type>/<id>/extract`) :
  montre pour chaque lien l'hébergeur détecté et l'issue.
- `/debug/streams/<type>/<imdb>?refresh=1` : flux finaux tels que Nuvio les verra. Les ids
  sont des IMDb (`tt…`) ; pour une série, `tt…:S:E`.

## 6. Déployer

```bash
test -f .env && docker compose up -d --build   # .env est bind-monté : vérifier que c'est un fichier
docker logs movix-addon --since 2m | grep extract
```

## Récapitulatif

- [ ] Motif dans `BUILTIN_HOSTER_PATTERNS` (à la bonne position)
- [ ] Nom dans `LOCAL_EXTRACTORS`, ou dans `JWPLAYER_HOSTERS` si le jwplayer générique suffit
- [ ] Fonction d'extraction (`null` = vidéo morte, exception = panne)
- [ ] Branche dans `extractDirectUrl`, avec le disjoncteur respecté
- [ ] Proxy si en-têtes ou jeton lié à l'IP ; `rules` si mauvais Content-Type
- [ ] Commentaire d'en-tête du fichier mis à jour
- [ ] Test de détection + `node --test test/*.test.js`
- [ ] Essai réel : playlist **et** segment lisibles
