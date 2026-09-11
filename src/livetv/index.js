const { mainApi } = require('../integrations/movixClient');
const config = require('../core/config');
const cache = require('../core/cache');

/**
 * TV en direct.
 *
 * C'est la nouveaute la plus visible de la refonte Movix: `liveTvRoutes.js` expose un
 * triplet manifest / catalog / stream qui parle DEJA le protocole Stremio. Le travail de
 * l'addon se reduit donc a un relais, plus quelques decisions que le site prend cote
 * client et qu'un lecteur ne peut pas prendre:
 *
 *   vavoo_*      HLS brut, gratuit, sans cle. C'est la source jouable par defaut.
 *   tvmio-*      playlist M3U locale du serveur, jouable.
 *   iptv_*       Xtream, reserve aux VIP (403 sans cle).
 *   northlive_*  lecteur en IFRAME (`_isEmbed`). Injouable par Stremio/Nuvio: la reponse
 *                est une page HTML, pas un flux. On ne les propose qu'en "ouvrir dans le
 *                navigateur", et seulement si SHOW_UNPLAYABLE_EMBEDS est actif.
 *   match_*      rencontres sportives FCTV. Le flux natif est verrouille par IP et resolu
 *                cote client par l'extension du site; sans elle le site retombe lui aussi
 *                sur un embed. Meme traitement que northlive.
 *
 * Les ids voyagent prefixes `movixtv:` pour ne pas entrer en collision avec les ids TMDB
 * ou IMDb du reste de l'addon, et les catalogues `movixtv-`.
 */

const ID_PREFIX = 'movixtv:';
const CATALOG_PREFIX = 'movixtv-';

// Le manifest amont recalcule ses catalogues toutes les 5 min (la liste des sports FCTV
// suit les rencontres en cours). Inutile de le tenir plus longtemps que lui.
const MANIFEST_TTL_MS = 5 * 60 * 1000;
// Les catalogues dynamiques amont sont caches 1 min chez Movix; on s'aligne.
const CATALOG_TTL_MS = 60 * 1000;
// Un flux live est resolu a la demande et ses URLs tournent: on ne le garde qu'un instant,
// juste assez pour qu'un lecteur qui redemande immediatement ne repaye pas la resolution.
const STREAM_TTL_MS = 30 * 1000;

function enabled() {
  return config.LIVETV_ENABLED && !!config.MAIN_API_BASE_URL;
}

/** `movixtv-vavoo_france` -> `vavoo_france` */
function rawCatalogId(catalogId) {
  return String(catalogId || '').startsWith(CATALOG_PREFIX)
    ? String(catalogId).slice(CATALOG_PREFIX.length)
    : null;
}

/** `movixtv:vavoo_xyz` -> `vavoo_xyz` */
function rawChannelId(id) {
  return String(id || '').startsWith(ID_PREFIX) ? String(id).slice(ID_PREFIX.length) : null;
}

function isLiveTvId(id) {
  return typeof id === 'string' && id.startsWith(ID_PREFIX);
}

/**
 * Catalogues annonces par Movix, filtres par LIVETV_CATALOGS quand il est renseigne.
 *
 * L'appel est fait a chaque construction de manifest, mais mis en cache: Stremio et Nuvio
 * relisent le manifest regulierement, et un aller-retour a chaque fois pour une liste qui
 * bouge toutes les 5 minutes n'aurait pas de sens.
 */
async function catalogs() {
  if (!enabled()) return [];

  try {
    const rows = await cache.wrap('livetv:manifest', MANIFEST_TTL_MS, MANIFEST_TTL_MS, async () => {
      const { data } = await mainApi.get('/api/livetv/manifest', { timeout: 8000 });
      return Array.isArray(data?.catalogs) ? data.catalogs : [];
    });

    const wanted = config.LIVETV_CATALOGS;
    return rows
      .filter((row) => row && row.id && (!wanted || wanted.some((w) => w.toLowerCase() === String(row.id).toLowerCase())))
      .map((row) => ({
        type: 'tv',
        id: `${CATALOG_PREFIX}${row.id}`,
        // Le nom amont est nu ("France", "Sport"): on le rattache a la rangee Movix pour
        // qu'il soit identifiable au milieu des autres addons installes.
        name: `Movix TV · ${row.name || row.id}`,
        extra: [{ name: 'skip', isRequired: false }],
      }));
  } catch (err) {
    // Une panne du Live TV ne doit pas empecher l'addon de servir son manifest: sans
    // catalogues, la rubrique disparait simplement.
    console.warn(`[livetv] manifest indisponible: ${err.message}`);
    return [];
  }
}

/** Fiches d'un catalogue. Les ids sont reecrits dans notre espace de noms. */
async function catalog(catalogId, { skip = 0 } = {}) {
  const raw = rawCatalogId(catalogId);
  if (!enabled() || !raw) return [];

  try {
    const metas = await cache.wrap(`livetv:catalog:${raw}`, CATALOG_TTL_MS, CATALOG_TTL_MS, async () => {
      const { data } = await mainApi.get(`/api/livetv/catalog/tv/${encodeURIComponent(raw)}`, { timeout: 12000 });
      return Array.isArray(data?.metas) ? data.metas : [];
    });

    const page = skip > 0 ? metas.slice(skip) : metas;
    const mapped = page.map(toMeta);
    // Index de secours pour `meta()`: le protocole demande la fiche d'une chaine APRES
    // l'avoir listee, on a donc presque toujours deja tout ce qu'il faut sous la main.
    for (const entry of mapped) knownMetas.set(entry.id, entry);
    return mapped;
  } catch (err) {
    console.warn(`[livetv] catalogue ${raw} indisponible: ${err.message}`);
    return [];
  }
}

// Fiches deja vues, pour repondre a `meta` sans relire un catalogue entier.
const knownMetas = new Map();

function toMeta(entry) {
  return {
    id: `${ID_PREFIX}${entry.id}`,
    type: 'tv',
    name: entry.name || entry.id,
    poster: entry.poster || entry.logo || undefined,
    posterShape: 'square',
    logo: entry.logo || undefined,
    background: entry.background || undefined,
    description: entry.description || undefined,
  };
}

/**
 * Fiche d'une chaine.
 *
 * Movix n'expose pas de route `meta`: la fiche vient de l'index rempli en listant les
 * catalogues. Une chaine ouverte sans etre passee par un catalogue (lien direct, reprise
 * d'un historique) n'y est pas -- on rend alors une fiche minimale deduite de l'id, ce qui
 * suffit a ce que le lecteur affiche la liste des flux au lieu d'une page d'erreur.
 */
async function meta(id) {
  const raw = rawChannelId(id);
  if (!enabled() || !raw) return null;

  const known = knownMetas.get(id);
  if (known) return known;

  const name = raw.replace(/^(?:vavoo|northlive|match|iptv)[_-]/, '').replace(/[-_]+/g, ' ').trim();
  return { id, type: 'tv', name: name || raw, posterShape: 'square' };
}

/**
 * Flux d'une chaine, au format Stremio.
 *
 * Un flux marque `_isEmbed` est une PAGE, pas un media: le proposer tel quel donnerait un
 * lecteur qui tourne dans le vide. On le degrade en "ouvrir dans le navigateur", et
 * seulement si l'utilisateur a demande a voir ces liens-la.
 */
async function streams(id) {
  const raw = rawChannelId(id);
  if (!enabled() || !raw) return [];

  try {
    const rows = await cache.wrap(`livetv:stream:${raw}`, STREAM_TTL_MS, STREAM_TTL_MS, async () => {
      const { data } = await mainApi.get(`/api/livetv/stream/tv/${encodeURIComponent(raw)}`, { timeout: 15000 });
      return Array.isArray(data?.streams) ? data.streams : [];
    });

    const out = [];
    for (const row of rows) {
      if (!row?.url) continue;
      const title = row.title || 'Direct';
      if (row._isEmbed) {
        if (config.SHOW_UNPLAYABLE_EMBEDS) {
          out.push({ name: 'Movix TV', title: `${title} · page web`, externalUrl: row.url });
        }
        continue;
      }
      out.push({
        name: 'Movix TV',
        title,
        url: row.url,
        behaviorHints: { notWebReady: false },
      });
    }
    return out;
  } catch (err) {
    // 403 = chaine reservee aux VIP (Xtream) sans cle valide. Le dire: une liste vide
    // ressemble sinon a une chaine morte.
    if (err.response?.status === 403) {
      console.warn(`[livetv] ${raw}: reserve aux VIP (VIP_ACCESS_KEY absente ou refusee)`);
    } else {
      console.warn(`[livetv] flux ${raw} indisponible: ${err.message}`);
    }
    return [];
  }
}

module.exports = { enabled, isLiveTvId, catalogs, catalog, meta, streams, ID_PREFIX, CATALOG_PREFIX };
