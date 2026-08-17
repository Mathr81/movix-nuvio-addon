const axios = require('axios');
const zlib = require('zlib');
const { promisify } = require('util');
const config = require('../../core/config');
const cache = require('../../core/cache');
const { decodeSubtitle, toCleanVtt } = require('./vtt');

const gunzip = promisify(zlib.gunzip);

const PROVIDERS = [require('./vdrk'), require('./opensubtitles')];

/**
 * Sous-titres, en cascade de fournisseurs.
 *
 * SUBTITLE_PROVIDERS donne l'ordre. La cascade se fait **par langue** et non en tout ou
 * rien: si vdrk n'a pas de piste francaise sur un titre confidentiel mais qu'il a
 * l'anglais, OpenSubtitles n'est interroge que pour le francais. C'est tout l'interet
 * d'un repli -- combler un trou, pas remplacer l'ensemble.
 *
 * Un fournisseur n'est donc appele que s'il reste une langue a pourvoir.
 */
function activeProviders() {
  const order = config.SUBTITLE_PROVIDERS;
  return order
    .map((id) => PROVIDERS.find((p) => p.id === id.toLowerCase()))
    .filter(Boolean);
}

/**
 * En-tetes attendus par l'hote qui sert le fichier: chaque fournisseur a les siens, et la
 * route de conversion ne recoit qu'une URL, sans savoir d'ou elle vient.
 */
function headersFor(url) {
  const provider = PROVIDERS.find((p) => p.host && String(url).includes(p.host));
  return (provider || PROVIDERS[PROVIDERS.length - 1]).headers;
}

/**
 * Hotes vers lesquels la route de conversion accepte de relayer.
 *
 * Sans cette borne, `/subtitle/<url>` serait un proxy HTTP ouvert. La liste est DERIVEE
 * des fournisseurs: elle etait auparavant ecrite en dur dans server.js, et ajouter vdrk
 * s'y heurtait a un 403 sans rapport apparent avec le nouveau fournisseur.
 */
function isAllowedHost(hostname) {
  const host = String(hostname).toLowerCase();
  return PROVIDERS.some((p) => p.host && (host === p.host || host.endsWith(`.${p.host}`)));
}

/**
 * Telecharge une piste et renvoie du WebVTT propre.
 *
 * Trois formes possibles a l'entree: du WebVTT (vdrk), du SRT, ou un .gz contenant du SRT
 * (OpenSubtitles). Stremio/Nuvio ne savent lire que la premiere, d'ou ce passage par
 * notre propre serveur.
 */
async function fetchAsVtt(downloadUrl) {
  const cacheKey = `sub:${downloadUrl}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const { data } = await axios.get(downloadUrl, {
    headers: headersFor(downloadUrl),
    responseType: 'arraybuffer',
    timeout: 15000,
  });

  let buffer = Buffer.from(data);
  // Magic number gzip (1f 8b) -- certains miroirs servent le .srt deja decompresse.
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
    buffer = await gunzip(buffer);
  }

  const { vtt, removed } = toCleanVtt(decodeSubtitle(buffer));
  if (removed > 0) {
    console.log(`[subtitles] ${removed} replique(s) publicitaire(s) retiree(s) de ${downloadUrl.slice(0, 80)}`);
  }
  cache.set(cacheKey, vtt, config.CACHE_TTL_MS);
  return vtt;
}

/**
 * URL de notre route de conversion pour une piste.
 *
 * La source voyage dans le CHEMIN, encodee en base64url, et l'URL se termine par ".vtt".
 * Elle transitait auparavant par un parametre de requete (`?src=...`), ce qui la rendait
 * tributaire de tout ce qui touche a la query en route -- lecteur qui la tronque, proxy
 * inverse qui la reecrit -- et se soldait par un 400 sans explication. Un chemin opaque
 * ne peut pas etre mal interprete, et l'extension rassure les lecteurs qui la verifient.
 *
 * Les pistes vdrk sont deja du WebVTT et seraient jouables en direct; elles passent quand
 * meme par ici, pour le retrait des publicites et pour ne dependre que d'un seul chemin
 * eprouve (PUBLIC_URL, cache, en-tetes).
 */
function subtitleUrl(publicBaseUrl, downloadUrl) {
  return `${publicBaseUrl}/subtitle/${Buffer.from(downloadUrl, 'utf8').toString('base64url')}.vtt`;
}

/** Recherche chez un fournisseur, memoisee et tolerante a l'echec. */
async function searchWith(provider, { type, tmdbId, season, episode, langs }) {
  const key = `subs:${provider.id}:${type}:${tmdbId}:${season ?? '-'}:${episode ?? '-'}`;
  return cache.wrap(key, config.CACHE_TTL_MS, config.CACHE_EMPTY_TTL_MS, () =>
    provider.search({ type, tmdbId, season, episode, langs }).catch((err) => {
      console.warn(`[subtitles] ${provider.name} a echoue tmdbId=${tmdbId}: ${err.message}`);
      return [];
    }),
  );
}

/**
 * Construit la liste de sous-titres au format Stremio.
 * Chaque URL pointe vers notre propre route, qui convertit et nettoie a la volee.
 */
async function buildSubtitles({ type, tmdbId, season, episode, publicBaseUrl }) {
  if (!config.SUBTITLES_ENABLED) return [];

  const wanted = config.SUBTITLE_LANGS;
  const byLang = new Map();
  const origine = [];

  for (const provider of activeProviders()) {
    const manquantes = wanted.filter((lang) => !byLang.has(lang));
    if (manquantes.length === 0) break;

    const found = await searchWith(provider, { type, tmdbId, season, episode, langs: manquantes });
    let retenues = 0;
    for (const item of found) {
      // On ne prend que les langues encore vides: le premier fournisseur qui a une langue
      // la garde, sinon les listes se melangeraient sans ordre defendable.
      if (!manquantes.includes(item.lang)) continue;
      if (!byLang.has(item.lang)) byLang.set(item.lang, []);
      byLang.get(item.lang).push({ ...item, provider });
      retenues += 1;
    }
    if (retenues > 0) origine.push(`${provider.name}:${retenues}`);
  }

  // Le protocole prevoit plusieurs pistes par langue, differenciees par leur `id`
  // (docs/api/responses/subtitles.md). Une seule par defaut: elles s'affichent toutes sous
  // le meme nom de langue, et personne ne choisit entre deux "Français" identiques.
  //
  // Le champ `lang` est un CODE. La specification dit qu'un libelle libre est affiche tel
  // quel, mais Nuvio, lui, normalise et rend "inconnu" tout ce qu'il ne reconnait pas --
  // c'est ce qui arrivait quand on suffixait les pistes ("fre (2)"). D'ou le defaut a un
  // code pur, et le libelle du fournisseur derriere un reglage.
  const perLang = Math.max(config.SUBTITLES_PER_LANG, 1);
  const subtitles = [];

  for (const lang of wanted) {
    const entries = byLang.get(lang);
    if (!entries) continue;
    entries.sort((a, b) => b.score - a.score);
    entries.slice(0, perLang).forEach((entry, index) => {
      subtitles.push({
        id: `movix-${entry.provider.id}-${lang}${index > 0 ? `-${index + 1}` : ''}`,
        lang: config.SUBTITLE_PROVIDER_LABEL ? `${lang} · ${entry.provider.name}` : lang,
        url: subtitleUrl(publicBaseUrl, entry.url),
      });
    });
  }

  console.log(
    `[subtitles] tmdbId=${tmdbId} ${subtitles.length} piste(s)` +
      (origine.length > 0 ? ` (${origine.join(', ')})` : ' (aucun fournisseur n\'a repondu)'),
  );
  return subtitles;
}

module.exports = { buildSubtitles, fetchAsVtt, subtitleUrl, isAllowedHost };
