/**
 * Lecture des libelles de chaines.
 *
 * Chaque source nomme la meme chaine a sa facon: Vavoo ecrit `TF 1 ULTRA 4K .c`, l'IPTV
 * Xtream `Fr: TF1 FHD`, une playlist tierce `TF1 HD (BACKUP)`. Fusionner demande de
 * separer, dans ce libelle, ce qui IDENTIFIE la chaine (`TF1`) de ce qui decrit le FLUX
 * (definition, serveur, mention "secours"). Tout le module tient dans cette separation.
 */

// Definition annoncee -> hauteur d'image. L'ordre compte: `FHD` contient `HD`.
const QUALITY_RULES = [
  [/\b8K\b/i, 4320],
  [/\b(?:ULTRA\s*4K|4K|UHD|2160P?)\b/i, 2160],
  [/\b(?:FHD|FULL\s*HD|1080P?)\b/i, 1080],
  [/\bHD\b\+?/i, 720],
  [/\b720P?\b/i, 720],
  [/\bSD\b/i, 480],
];

// Retires du nom une fois la definition lue. `HD+` laisserait sinon un `+` orphelin, lu
// ensuite comme le "plus" de Canal+.
const QUALITY_NOISE =
  /\b(?:ULTRA\s*4K|4K\s*ULTRA|8K|4K|UHD|FHD|FULL\s*HD|HD\b\+?|SD|2160P?|1080P?|720P?|HEVC|H\.?26[45]|50\s*FPS|RAW)(?![\w+])/gi;

const QUALITY_LABELS = { 4320: '8K', 2160: '4K', 1080: 'FHD', 720: 'HD', 480: 'SD' };

function qualityLabel(quality) {
  return QUALITY_LABELS[quality] || '';
}

/**
 * Cle de fusion: ce qui reste d'un nom une fois retires casse, accents, espaces et
 * ponctuation. `+` devient `plus` AVANT ce nettoyage -- Canal+ et Canal ne sont pas la
 * meme chaine, pas plus que Boomerang et Boomerang +1.
 */
function keyOf(name) {
  let key = String(name || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\+/g, 'plus')
    .replace(/&/g, ' ')
    .replace(/[^a-z0-9]+/g, '');

  for (const [pattern, replacement] of KEY_ALIASES) key = key.replace(pattern, replacement);
  return key;
}

// Variantes d'ecriture d'une meme chaine, ramenees a une forme unique. A completer quand
// `/iptv/<jeton>/channels.json?unmatched=1` montre deux lignes pour une seule chaine.
const KEY_ALIASES = [
  [/sports/g, 'sport'],
  [/^tf1seriesfilm$/, 'tf1seriesfilms'],
  [/^tf1seriesetfilms?$/, 'tf1seriesfilms'],
  // Les Cine+ sont ecrits "Cine Emotion", "Cine + Frisson" ou "Cine+ Frisson" selon la source.
  [/^cine(?=emotion|frisson|premier|classic|club|famiz|family|festival|estival)/, 'cineplus'],
  [/^canalaplus/, 'canalplus'],
  [/^(\d+)(?:eme|e)rue$/, '$1emerue'],
  [/^cnew$/, 'cnews'],
  [/^lequipe(?:tv|21)?$/, 'lequipe'],
  [/^bfm$/, 'bfmtv'],
  [/^franceinfotv$/, 'franceinfo'],
  [/^canalpluspl$/, 'canalpluspremierleague'],
  [/^cineplusestival$/, 'cineplusfestival'],
  [/leauge/, 'league'],
  [/^equipe(?:21)?$/, 'lequipe'],
  [/^tfi$/, 'tf1'],
  [/^cina/, 'cine'],
  [/^cineplusfri?s?sion$|^cineplusisson$/, 'cineplusfrisson'],
  [/^cinepluspremiere$/, 'cinepluspremier'],
  [/^canalpluscnema$/, 'canalpluscinema'],
  [/^cstarhits?$/, 'cstarhitsfrance'],
  [/^natgeo$|^nationalgeographicfr$/, 'nationalgeographic'],
  [/^nationalgeo(?:graphic)?wild$/, 'natgeowild'],
  [/^discovery$/, 'discoverychannel'],
  [/^discoveryid$|^investigationdiscovery$/, 'discoveryinvestigation'],
  [/^nick(?:elodeon)?j(?:unio)?r(?:fr)?$/, 'nickelodeonjunior'],
  [/^paramountdecale(?:fr)?$/, 'paramountchanneldecale'],
  [/^paramount$/, 'paramountchannel'],
  [/^planete$/, 'planeteplus'],
  [/^planetepluscrime$|^planete(?:plus)?ci$/, 'planetepluscrimeinvestigation'],
  [/^sciences?(?:et)?vie(?:tv)?$/, 'scienceetvietv'],
  [/^maisontravaux(?:tv)?$/, 'maisonettravaux'],
  [/^chassepeche$/, 'chasseetpeche'],
  [/^toutelhistore$/, 'toutelhistoire'],
  [/^ocsgeanet$/, 'ocsgeants'],
  [/^tv8montblanc$/, '8montblanc'],
  [/^rmcsport(\d)access$/, 'rmcsportaccess$1'],
  [/^infosport$/, 'infosportplus'],
  [/^ushuaia$/, 'ushuaiatv'],
  [/^comedie$/, 'comedieplus'],
  [/^polar$|^cine(?:plus)?polar(?:plus)?$|^cinpolar$/, 'polarplus'],
  [/^golf$/, 'golfplus'],
  [/^warner$/, 'warnertv'],
  [/^tv5mondoinfo$/, 'tv5mondeinfo'],
];

/**
 * `Fr: TF1 FHD [Match Time]` -> { name: 'TF1', key: 'tf1', quality: 1080, ... }
 *
 * `server` est la lettre que Vavoo colle en fin de nom (`.s`, `.b`, `.c`): trois
 * fournisseurs distincts derriere le meme catalogue. Elle ne dit rien de la chaine mais
 * distingue les flux entre eux, on la garde pour l'affichage.
 */
function parse(raw) {
  let text = String(raw || '').trim();

  let server = '';
  const serverMatch = text.match(/\s\.([a-z])$/i);
  if (serverMatch) {
    server = serverMatch[1].toUpperCase();
    text = text.slice(0, serverMatch.index);
  }

  // Prefixe de pays des bouquets Xtream: `FR: `, `Fr: `, `FR | `.
  text = text.replace(/^\s*[a-z]{2}\s*[:|]\s*/i, '');

  const backup = /\bBACKUP\b/i.test(text);
  // Flux allumes seulement pendant une rencontre: a ne pas preferer a un flux permanent.
  const eventOnly = /EVENTS?\s+ONLY|MATCH\s+TIME/i.test(text);
  text = text.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ');

  let quality = 0;
  for (const [pattern, height] of QUALITY_RULES) {
    if (pattern.test(text)) {
      quality = height;
      break;
    }
  }
  text = text.replace(QUALITY_NOISE, ' ').replace(/\s+/g, ' ').trim();

  return { name: text, key: keyOf(text), quality, server, backup, eventOnly };
}

// --- Rangement par theme -----------------------------------------------------

const GROUPS = ['Généraliste', 'Info', 'Sport', 'Cinéma', 'Séries', 'Jeunesse', 'Découverte', 'Musique', 'Divertissement', 'Régional', 'Autres'];

// Premier theme dont un mot-cle figure dans la cle gagne: l'ordre regle les ambiguites
// (`canalplussport` est du sport avant d'etre une chaine Canal).
const GROUP_KEYWORDS = [
  ['Sport', ['sport', 'bein', 'dazn', 'ligue1', 'foot', 'golf', 'equidia', 'tennis', 'lequipe', 'motors', 'moteurs', 'automoto', 'skweek', 'canalpluslive', 'olplay', 'trace sport']],
  ['Jeunesse', ['gulli', 'canalj', 'kids', 'piwi', 'tiji', 'disney', 'nick', 'cartoon', 'boomerang', 'boing', 'teletoon', 'mangas', 'gameone', 'okoo', 'toonami', 'junior', 'babytv', 'jone']],
  ['Cinéma', ['cine', 'ocs', 'tcm', 'boxoffice', 'paramount', 'grandecran', 'action', 'movie', 'film', 'canalpluscinema']],
  ['Séries', ['serie', 'warner', 'syfy', 'polar', 'crime', '13emerue', 'novelas', 'comedie', 'comedy', 'ab1', 'teva', 'tvbreizh']],
  ['Info', ['info', 'bfm', 'cnews', 'lci', 'euronews', 'i24', 'france24', 'lcp', 'publicsenat', 'figaro', 'tv5']],
  ['Musique', ['music', 'musique', 'mtv', 'trace', 'nrjhits', 'mcm', 'mezzo', 'rfm', 'melody', 'cstarhits', 'djazz', 'stingray']],
  ['Découverte', ['discovery', 'natgeo', 'nationalgeo', 'planete', 'ushuaia', 'decouverte', 'histoire', 'science', 'nature', 'animaux', 'chasse', 'peche', 'voyage', 'docs', 'rmcstory', 'museum', 'trek', 'seasons']],
  ['Généraliste', ['tf1', 'tfx', 'tmc', 'france2', 'france3', 'france4', 'france5', 'm6', 'w9', '6ter', 'arte', 'nrj12', 'cherie25', 'novo19', 't18', 'cstar', 'canalplus', 'parispremiere', 'rtl9', 'c8']],
];

// Categories des bouquets (Xtream) et des fiches Vavoo, quand le nom ne dit rien.
const GROUP_HINTS = [
  [/sport|bein|ligue/i, 'Sport'],
  [/cinema|movie/i, 'Cinéma'],
  [/kids|jeunesse|enfant/i, 'Jeunesse'],
  [/do[uc]+mentar|d[ée]couverte/i, 'Découverte'],
  [/news|info/i, 'Info'],
  [/music|musique/i, 'Musique'],
  [/entertainment|divertissement/i, 'Divertissement'],
  [/general|g[ée]n[ée]raliste/i, 'Généraliste'],
  [/series?|s[ée]ries/i, 'Séries'],
  [/local|r[ée]gion/i, 'Régional'],
];

function groupOf(key, hints = []) {
  for (const [group, words] of GROUP_KEYWORDS) {
    if (words.some((word) => key.includes(word.replace(/\s+/g, '')))) return group;
  }
  for (const hint of hints) {
    for (const [pattern, group] of GROUP_HINTS) {
      if (pattern.test(hint || '')) return group;
    }
  }
  return 'Autres';
}

// Numerotation TNT, pour que les premieres chaines de la playlist soient celles qu'on
// attend sur la telecommande. Les autres suivent, rangees par theme.
const TNT_ORDER = [
  'tf1', 'france2', 'france3', 'france4', 'france5', 'm6', 'arte', 'lcp', 'w9', 'tmc', 'tfx',
  'gulli', 'bfmtv', 'cnews', 'lci', 'franceinfo', 'cstar', 't18', 'novo19', 'tf1seriesfilms',
  'lequipe', '6ter', 'rmcstory', 'rmcdecouverte', 'cherie25', 'parispremiere', 'canalplus',
];

module.exports = { parse, keyOf, qualityLabel, groupOf, GROUPS, TNT_ORDER };
