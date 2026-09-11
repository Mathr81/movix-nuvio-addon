const axios = require('axios');
const config = require('../core/config');
const breaker = require('../core/breaker');
const voe = require('./hosterVoe');
const streamProxy = require('./streamProxy');

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * Extraction des liens d'embed en URLs de flux.
 *
 * CE MODULE A CHANGE DE ROLE. Movix a ferme ses surfaces d'extraction publiques:
 *
 *  - `/api/extract-<hebergeur>` et `/api/voe/m3u8` sur proxiesembed exigent maintenant
 *    l'en-tete `x-internal-key`, un secret partage uniquement entre Mainapi et
 *    proxiesembed (media_signing.py, `_require_internal`). Un appel sans lui recoit
 *    `403 INTERNAL_KEY_REQUIRED`;
 *  - `/api/extract-supervideo` et `/api/extract-dropload` sur Mainapi n'existent plus;
 *  - il n'existe volontairement AUCUN remplacant prenant une URL en parametre: une telle
 *    route etait une cible controlable par le client, et c'est precisement la faille que
 *    la refonte ferme (routes/mediaExtract.js le dit explicitement).
 *
 * L'extraction se fait desormais DANS LES ROUTES CATALOGUE, avec `?resolve=1` et une cle
 * VIP -- cf. src/sources/resolved.js. Ce qui arrive ici est donc ce que le serveur n'a
 * PAS resolu, et il ne reste que les extracteurs que l'addon sait faire tourner seul,
 * sans rien demander a Movix:
 *
 *   voe        repli local complet (src/streaming/hosterVoe.js)
 *   darkibox   lecture du HTML de la page d'embed
 *   oneupload  idem
 *
 * Tout le reste demande la resolution serveur. Renvoyer "no-extractor" pour ces liens
 * n'est pas une regression: sans cle VIP ils n'etaient de toute facon plus extractibles
 * par personne d'autre que le site lui-meme.
 */

/**
 * Miroir de Mainapi/utils/embedExtraction.js (HOSTER_PATTERNS), lui-meme miroir de
 * src/utils/hosterRegistry.ts cote site. Liste reprise telle quelle a l'amont: elle est
 * bien plus fournie que la precedente, notamment sur Voe.
 *
 * Deux strategies, selon le nom de l'hebergeur:
 *  - nom distinctif (uqload, vidmoly, fsvid...): un simple mot suffit et couvre tous ses
 *    TLD presents et futurs;
 *  - domaines DELIBEREMENT anonymes: il faut une liste explicite. Voe en est le cas
 *    d'ecole -- il renouvelle ses domaines de sortie environ tous les mois, avec des noms
 *    qui ne contiennent pas "voe" (ralphysuccessfull.com, prepareddare...).
 *
 * Cette liste vieillit donc par construction. HOSTER_PATTERNS_EXTRA permet d'ajouter un
 * domaine sans toucher au code, comme le site le fait avec ses "hosters custom & regex".
 */
const BUILTIN_HOSTER_PATTERNS = {
  voe: [
    // voe.<tld> + les variantes `voe-unblock`, `v-o-e-unblock`, `voeunbl0ck12`...
    'voe\\.',
    '(?:v-?o-?e)?-?un-?bl[o0]?c?k\\d{0,2}(?:-?voe)?\\.',
    // Alias sans "voe" dans le nom, tenus a jour d'apres les domaines de sortie observes.
    '(?:19turanosephantasia|20demidistance9elongations|30sensualizeexpression|321naturelikefurfuroid|35volitantplimsoles5|449unceremoniousnasoseptal|745mingiestblissfully|adrianmissionminute|alleneconomicmatter|antecoxalbobbing1010|anthonysaline|apinchcaseation|audaciousdefaulthouse|auraleanline|availedsmallest|bigclatterhomesguideservice)\\.',
    '(?:boonlessbestselling244|bradleyviewdoctor|brittneystandardwestern|brucevotewithin|caseyimpactstation|charlestoughrace|christopheruntilpoint|chromotypic|chuckle-tube|cindyeyefinal|claudiosepulchral|conscientiousedu|counterclockwisejacky|crownmakermacaronicism|crystaltreatmenteast|cyamidpulverulence530)\\.',
    '(?:dianaavoidthey|diananatureforeign|donaldlineelse|edwardarriveoften|effortlessexperim|ellenpoliticalfollow|erikcoldperson|figeterpiazine|fittingcentermondaysunday|fraudclatterflyingcar|gamoneinterrupted|garylargeavailable|generatesnitrosate|goofy-banana|graceaddresscommunity|greaseball6eventual20)\\.',
    '(?:guidon40hyporadius9|heatherdiscussionwhen|housecardsummerbutton|ianrequireadult|jamessoundcost|jamiesamewalk|jasminetesttry|jayservicestuff|jeanprofessorcentral|jefferycontrolmodel|jennifercertaindevelopment|jennifereconomicgive|jessicachoosemake|jessicayeahcatch|jilliandescribecompany|johnalwayssame)\\.',
    '(?:johnbeyondnation|jonathansociallike|josephseveralconcern|juliewomanwish|kathleenmemberhistory|kellywhatcould|kennethofficialitem|kinoger|kristiesoundsimply|lancewhosedifficult|launchreliantcleaverriver|lauradaydo|letsupload|lisatrialidea|loriwithinfamily|lukecomparetwo)\\.',
    '(?:lukesitturn|mariatheserepublican|marissasharecareer|matriculant401merited|matthewhotelscience|maxfinishseveral|metagnathtuggers|michaelapplysome|mikaylaarealike|nathanfromsubject|nectareousoverelate|nonesnanking|ogladaj|pamelachangemission|paulkitchendark|preferciseaccurate)\\.',
    '(?:prepareddare|ralphysuccessfull|realfinanceblogcenter|rebeccaneverbase|rebeccapracticeloss|reputationsheriffkennethsand|richardsignfish|roberteachfinal|robertordercharacter|robertplacespace|sandratableother|sandrataxeight|scatch176duplicities|sethniceletter|shannonpersonalcost|simpulumlamerop|smoki)\\.',
    '(?:stevenfamilyedge|stevenimaginelittle|strawberriesporail|telyn610zoanthropy|timberwoodanotia|timmaybealready|toddpartneranimal|toxitabellaeatrebates306|tracylocalschool|uptodatefinishconferenceroom|valeronevijao|walterprettytheir|wolfdyslectic|yodelswartlike)\\.',
  ],
  // `ansembed` sert le lecteur Vidmoly sous un autre nom: meme extracteur.
  vidmoly: ['vidmoly', 'ansembed'],
  uqload: ['uqload'],
  sibnet: ['sibnet'],
  // Veev partage `doods.to` avec la nebuleuse DoodStream mais a son propre protocole: il
  // doit donc etre teste AVANT `doodstream`, dont le motif `dood` l'attraperait sinon
  // (l'ordre des cles fait foi ici).
  veev: ['veev\\.', 'poophq', 'doods\\.to'],
  doodstream: [
    'doodstream', 'd0000d', 'd000d', 'd0o0d', 'do0od',
    'dood\\.', 'doodster', 'dooodster', 'dooood', 'doodcdn',
    'myvidplay', 'dsvplay', 'doply', 'playmogo',
    'ds2play', 'ds2video', 'dood2', 'all3do', 'do7go',
    'vidply', 'vide0\\.net', 'vvide0', 'd-s\\.io',
  ],
  lulustream: [
    'lulustream', 'luluvdo', 'luluvdoo', 'luluvid', 'lulu\\.st',
    'streamhihi', 'd00ds\\.site', 'cdn1\\.site', '732eg54de642sa',
  ],
  vidara: ['vidara\\.(?:to|so)'],
  seekstreaming: [
    'embedseek', 'embed4me', 'servicecatalog',
    'technicalcatalog', 'seekplayer', 'seeks\\.cloud', 'seekplays',
  ],
  vidzy: ['vidzy'],
  fsvid: ['fsvid'],
  // Hors liste amont: ces deux-la n'ont jamais eu d'extracteur cote Movix, l'addon les
  // lit lui-meme depuis le HTML de la page d'embed.
  darkibox: ['darkibox'],
  oneupload: ['oneupload'],
};

/** Hebergeurs que l'addon sait extraire SEUL, sans passer par Movix. */
const LOCAL_EXTRACTORS = new Set(['voe', 'darkibox', 'oneupload']);

/** Motifs compiles, alias supplementaires de la configuration inclus. */
const HOSTER_PATTERNS = (() => {
  const merged = Object.fromEntries(
    Object.entries(BUILTIN_HOSTER_PATTERNS).map(([hoster, patterns]) => [hoster, [...patterns]]),
  );

  for (const entry of config.HOSTER_PATTERNS_EXTRA) {
    const separator = entry.indexOf(':');
    const hoster = entry.slice(0, separator).trim().toLowerCase();
    const pattern = entry.slice(separator + 1).trim();
    if (separator < 1 || !pattern) {
      console.warn(`[extract] HOSTER_PATTERNS_EXTRA: "${entry}" ignore (attendu "hebergeur:motif")`);
      continue;
    }
    if (!merged[hoster]) {
      console.warn(`[extract] HOSTER_PATTERNS_EXTRA: hebergeur inconnu "${hoster}" (connus: ${Object.keys(merged).join(', ')})`);
      continue;
    }
    merged[hoster].push(pattern);
    console.log(`[extract] motif supplementaire pour ${hoster}: ${pattern}`);
  }

  return Object.fromEntries(
    Object.entries(merged).map(([hoster, patterns]) => [
      hoster,
      patterns.map((pattern) => {
        try {
          return new RegExp(pattern, 'i');
        } catch {
          console.warn(`[extract] motif invalide ignore pour ${hoster}: ${pattern}`);
          return null;
        }
      }).filter(Boolean),
    ]),
  );
})();

function detectHoster(url, playerNameHint) {
  const haystack = `${url} ${playerNameHint || ''}`;
  for (const [hoster, patterns] of Object.entries(HOSTER_PATTERNS)) {
    if (patterns.some((pattern) => pattern.test(haystack))) return hoster;
  }
  return null;
}

/** Vrai si l'addon peut extraire ce lien lui-meme. */
function hasLocalExtractor(url, playerNameHint) {
  const hoster = detectHoster(url, playerNameHint);
  return !!hoster && LOCAL_EXTRACTORS.has(hoster);
}

/**
 * Darkibox et OneUpload sont extraits par regex sur le HTML de la page d'embed.
 * Le frontend passe par un proxy CORS (contrainte navigateur uniquement) -- depuis Node
 * on interroge le hoster directement, ce qui evite un intermediaire.
 */
async function fetchEmbedHtml(url, referer) {
  const { data } = await axios.get(url, {
    timeout: 8000,
    responseType: 'text',
    headers: { 'User-Agent': BROWSER_UA, ...(referer ? { Referer: referer } : {}) },
  });
  return typeof data === 'string' ? data : String(data);
}

function firstMatch(html, patterns) {
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && match[1]) return match[1];
  }
  return null;
}

/**
 * Disjoncteur par hebergeur: un hebergeur qui rend cinq 502 d'affilee par fiche fait
 * payer a chaque fois un aller-retour et un delai d'attente.
 */
const extractBreaker = breaker.create({
  streak: () => config.HOSTER_FAILURE_STREAK,
  cooldownMs: () => config.HOSTER_COOLDOWN_MS,
  label: 'extract',
});

const breakerState = extractBreaker.state;

/**
 * Voe, extrait ici de bout en bout.
 *
 * Le flux obtenu vient du CDN de Voe, qui n'accepte que le Referer de son propre lecteur:
 * on le passe par le proxy de flux, exactement comme les addons. Sans ca l'URL serait
 * exacte et pourtant injouable.
 *
 * Laisse remonter les erreurs de TRANSPORT (reseau, 5xx): elles seules disent quelque
 * chose de l'etat du service, et c'est a l'appelant d'en tirer les consequences. Un
 * `no-json`/`no-source` ne dit rien de tel -- c'est une page qui a bien repondu mais dont
 * la video est morte, cas parfaitement ordinaire.
 */
async function extractVoeLocally(embedUrl) {
  const result = await voe.extract(embedUrl);
  if (!result.ok) {
    console.warn(`[extract:voe] rien a extraire de ${embedUrl}: ${result.reason}`);
    return null;
  }

  const url = config.STREAM_PROXY_ENABLED
    ? streamProxy.proxyUrl(result.url, {
        headers: {
          accept: '*/*',
          origin: 'https://voe.sx',
          referer: 'https://voe.sx/',
          'user-agent': voe.BROWSER_UA,
        },
      })
    : result.url;
  return { ok: true, url, hoster: 'voe' };
}

/**
 * Resout un lien d'embed que le serveur n'a pas resolu.
 *
 * `reason: 'server-only'` designe un hebergeur parfaitement extractible, mais seulement
 * par Movix: le lien n'est pas mort, il manque `resolve=1` et une cle VIP valide. C'est
 * une cause a distinguer de "no-extractor" (personne ne sait le lire), sans quoi une
 * cle VIP absente ressemble a un catalogue vide.
 */
async function extractDirectUrl(embedUrl, playerNameHint) {
  const hoster = detectHoster(embedUrl, playerNameHint);
  if (!hoster) return { ok: false, reason: 'no-extractor' };
  if (!LOCAL_EXTRACTORS.has(hoster)) return { ok: false, reason: 'server-only', hoster };

  // Service connu pour etre en panne a l'instant: on ne paye pas l'aller-retour.
  if (extractBreaker.isOpen(hoster)) return { ok: false, reason: 'cooldown', hoster };

  if (hoster === 'voe') {
    try {
      const local = await extractVoeLocally(embedUrl);
      // Le service a repondu, avec ou sans flux: il n'est pas en panne.
      extractBreaker.noteRecovery(hoster);
      return local || { ok: false, reason: 'no-url-field', hoster };
    } catch (err) {
      console.warn(`[extract:voe] echec HTTP pour ${embedUrl}: ${err.message}`);
      const status = err.response?.status;
      if (!status || status >= 500) extractBreaker.noteOutage(hoster);
      return { ok: false, reason: 'http-error', hoster, status };
    }
  }

  try {
    const html = await fetchEmbedHtml(embedUrl, hoster === 'oneupload' ? 'https://oneupload.net/' : undefined);

    if (hoster === 'darkibox') {
      // Darkibox: bloc `sources: [{src: "...m3u8"}]`.
      const block = html.match(/sources:\s*\[([\s\S]*?)\]/);
      const url = block ? firstMatch(block[1], [/src:\s*"([^"]+)"/]) : null;
      if (url && url.includes('.m3u8')) {
        extractBreaker.noteRecovery(hoster);
        return { ok: true, url, hoster };
      }
    } else {
      // OneUpload: file/source/src, m3u8 d'abord puis mp4.
      const url = firstMatch(html, [
        /file:\s*["']([^"']+\.m3u8[^"']*)/i,
        /source:\s*["']([^"']+\.m3u8[^"']*)/i,
        /src:\s*["']([^"']+\.m3u8[^"']*)/i,
        /"file":\s*"([^"]+\.m3u8[^"]*)"/i,
        /"source":\s*"([^"]+\.m3u8[^"]*)"/i,
        /file:\s*["']([^"']+\.mp4[^"']*)/i,
        /source:\s*["']([^"']+\.mp4[^"']*)/i,
        /src:\s*["']([^"']+\.mp4[^"']*)/i,
        /"file":\s*"([^"]+\.mp4[^"]*)"/i,
        /"source":\s*"([^"]+\.mp4[^"]*)"/i,
      ]);
      if (url) {
        extractBreaker.noteRecovery(hoster);
        return { ok: true, url, hoster };
      }
    }

    console.warn(`[extract:${hoster}] aucune source trouvee dans le HTML de ${embedUrl}`);
    return { ok: false, reason: 'no-url-field', hoster };
  } catch (err) {
    console.warn(`[extract:${hoster}] echec HTTP pour ${embedUrl}: ${err.message}`);
    const status = err.response?.status;
    // Panne de service (5xx, timeout, reseau) vs refus portant sur cette video (4xx).
    if (!status || status >= 500) extractBreaker.noteOutage(hoster);
    return { ok: false, reason: 'http-error', hoster, status };
  }
}

module.exports = { detectHoster, hasLocalExtractor, extractDirectUrl, breakerState, LOCAL_EXTRACTORS };
