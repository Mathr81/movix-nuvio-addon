const config = require('../core/config');

/**
 * Resolution des m3u8 COTE SERVEUR.
 *
 * Movix a ferme ses surfaces d'extraction publiques: `/api/extract-<hebergeur>` sur
 * proxiesembed exige desormais une cle interne (`x-internal-key`) que seul Mainapi
 * detient, et les endpoints `/api/extract-supervideo` et `/api/extract-dropload` de
 * Mainapi n'existent plus. Il n'y a plus nulle part d'endpoint "extrais-moi cette URL":
 * c'est delibere, une telle route etait une cible controlable par le client.
 *
 * A la place, ce sont les ROUTES CATALOGUE qui resolvent, quand on le demande:
 *
 *   GET /api/<source>/...?resolve=1        + header x-access-key (VIP)
 *
 * et chaque lecteur extractible de la reponse porte en plus un champ `m3u8Url`
 * (cf. Mainapi/utils/embedExtraction.js). Les catalogues dont les lecteurs ne sont pas
 * des objets -- chaines brutes chez Anime-Sama, listes mixtes des liens communautaires --
 * rendent a la place une table parallele `m3u8ByPlayer` (lien -> m3u8).
 *
 * Deux consequences importantes:
 *
 *  - la resolution ne porte QUE sur ce qu'on demande. Pour une serie il faut donc
 *    joindre `episode=<n>`: sans lui la reponse reste en liens embed, meme avec
 *    `resolve=1`. C'est voulu cote Movix (ne pas extraire une saison entiere pour une
 *    seule lecture), et c'est le piege principal de cette API;
 *
 *  - la m3u8 rendue est DEJA proxifiee et signee (`.../fsvid-proxy?url=...&exp=&sig=`).
 *    Elle est jouable telle quelle: c'est proxiesembed qui rejoue les Origin/Referer que
 *    le CDN de l'hebergeur exige. Rien a reproxifier de notre cote, et la signature vaut
 *    12 h -- largement au-dela de STREAM_TTL_MS.
 */

/**
 * Le serveur ne resout que pour un VIP: sans cle, `resolve=1` ne coute rien mais ne
 * rapporte rien non plus. On l'omet alors, ce qui evite aussi de faire travailler Movix
 * pour des reponses qu'on n'exploitera pas.
 */
function enabled() {
  return config.MOVIX_RESOLVE && !!config.VIP_ACCESS_KEY;
}

/**
 * Parametres de requete d'un appel catalogue "de lecture".
 * `extra` porte ce que la route attend en propre (season, episode...).
 */
function params(extra = {}) {
  const out = {};
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined && value !== null && value !== '') out[key] = value;
  }
  if (enabled()) out.resolve = 1;
  return out;
}

// Champs portant le lien embed, selon le catalogue: `url` (wiflix, j1f, swiftflow,
// cpasmal, fstream), `link` (frenchstream, voirdrama), `decoded_url` (coflix).
const EMBED_URL_FIELDS = ['url', 'link', 'decoded_url'];
const MAX_DEPTH = 8;

/**
 * Parcourt une reponse catalogue et renvoie la table `lien embed -> m3u8 resolue`.
 *
 * La forme exacte importe peu: le parcours est recursif et couvre les trois
 * arborescences en usage (`players` par langue, `episodes[n].languages`, tableaux
 * plats), plus les tables `m3u8ByPlayer`.
 */
function collect(payload, table = new Map(), depth = 0) {
  if (!payload || typeof payload !== 'object' || depth > MAX_DEPTH) return table;

  if (Array.isArray(payload)) {
    for (const item of payload) collect(item, table, depth + 1);
    return table;
  }

  const resolvedUrl = payload.m3u8Url;
  if (typeof resolvedUrl === 'string' && resolvedUrl) {
    for (const field of EMBED_URL_FIELDS) {
      const embed = payload[field];
      if (typeof embed === 'string' && embed) table.set(embed, resolvedUrl);
    }
  }

  const byPlayer = payload.m3u8ByPlayer;
  if (byPlayer && typeof byPlayer === 'object' && !Array.isArray(byPlayer)) {
    for (const [embed, m3u8] of Object.entries(byPlayer)) {
      if (typeof m3u8 === 'string' && m3u8) table.set(embed, m3u8);
    }
  }

  for (const value of Object.values(payload)) collect(value, table, depth + 1);
  return table;
}

/**
 * Applique la table de resolution a un lien collecte par une source.
 *
 * Resolu: le lien devient un flux DIRECT, et l'URL d'embed est conservee dans
 * `embedUrl` -- c'est elle que les CDN attendent en Referer, et c'est la cle sur
 * laquelle le reste de l'addon deduplique.
 */
function apply(item, table) {
  const m3u8 = item.url ? table.get(item.url) : null;
  if (!m3u8) return item;
  return { ...item, url: m3u8, embedUrl: item.url, direct: true, resolvedByServer: true };
}

/** Applique la table a toute une liste, et compte ce qui a ete resolu. */
function applyAll(items, table) {
  const out = items.map((item) => apply(item, table));
  return { items: out, resolved: out.filter((i) => i.resolvedByServer).length };
}

/**
 * Libelle de journal commun: "12 lien(s), 9 resolu(s) par le serveur".
 * Sans cle VIP la mention disparait -- il n'y avait rien a resoudre.
 */
function summary(total, resolved) {
  if (!enabled()) return `${total} lien(s) (resolution serveur desactivee)`;
  return `${total} lien(s), ${resolved} resolu(s) par le serveur`;
}

module.exports = { enabled, params, collect, apply, applyAll, summary };
