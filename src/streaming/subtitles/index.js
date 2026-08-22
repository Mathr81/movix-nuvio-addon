const axios = require('axios');
const zlib = require('zlib');
const { promisify } = require('util');
const config = require('../../core/config');
const cache = require('../../core/cache');
const playback = require('../playback');
const sync = require('./sync');
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
function subtitleUrl(publicBaseUrl, downloadUrl, bind) {
  // Le lien porte aussi DE QUOI RETROUVER LE FLUX a caler (cf. playback.js): soit un
  // identifiant de flux precis, soit une cle de contenu, auquel cas c'est le flux
  // reellement servi par le proxy au moment de la lecture qui fera foi.
  const payload = bind ? JSON.stringify([downloadUrl, bind.kind, bind.ref]) : downloadUrl;
  return `${publicBaseUrl}/subtitle/${Buffer.from(payload, 'utf8').toString('base64url')}.vtt`;
}

/**
 * Lit ce qu'une URL `/subtitle/<...>.vtt` transporte.
 * L'ancienne forme (une URL nue) reste comprise: des liens sont deja dans des lecteurs.
 */
function readPayload(encoded) {
  let decoded;
  try {
    decoded = Buffer.from(String(encoded).replace(/\.vtt$/i, ''), 'base64url').toString('utf8');
  } catch {
    return null;
  }
  if (!decoded.startsWith('[')) return { url: decoded };
  try {
    const [url, kind, ref] = JSON.parse(decoded);
    return { url, kind, ref };
  } catch {
    return null;
  }
}

/** Le flux a caler, d'apres ce que porte le lien. */
function boundStream({ kind, ref }) {
  if (kind === 's') return playback.recall(ref);
  if (kind !== 'c' || !ref) return null;
  const found = playback.current(ref, { fallbackToFirst: config.SUBTITLE_AUTOSYNC_GUESS_STREAM });
  if (!found) {
    // Cas typique: un lien qui ne passe pas par le proxy de flux, donc dont on n'a rien vu
    // passer. Le dire est utile -- sans ce message, une piste non calee reste inexpliquee.
    console.log(
      `[subsync] aucun flux observe pour ${ref} -- piste servie telle quelle ` +
        '(SUBTITLE_AUTOSYNC_BIND=stream pour rattacher les pistes a chaque flux)',
    );
    return null;
  }
  if (!found.certain) {
    console.log(`[subsync] aucun flux observe pour ${ref}: calage tente sur le mieux classe (${found.record.label || 'flux'})`);
  }
  return found.record;
}

/**
 * Attend un calage, mais pas indefiniment.
 *
 * Le calcul dure quelques dizaines de secondes la premiere fois. Un lecteur qui attend
 * aussi longtemps une piste abandonne, ou pire, reste bloque: passe le delai on sert la
 * piste brute. Le calcul, lui, CONTINUE -- il est memoise -- et la piste ressortira calee
 * si on la reselectionne. C'est aussi ce que le prechargement rend rare (cf. streamBuilder).
 */
function withDeadline(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/**
 * WebVTT propre ET cale sur le flux en cours, quand on sait lequel c'est.
 * @returns {Promise<{vtt:string, plan:object|null, stream:object|null}>}
 */
async function servedVtt(payload) {
  const vtt = await fetchAsVtt(payload.url);
  const stream = payload.kind ? boundStream(payload) : null;
  if (!stream) return { vtt, plan: null, stream: null };

  const plan = await withDeadline(
    sync.planFor({
      streamUrl: stream.url,
      streamKey: stream.key,
      subtitleKey: payload.url,
      vtt,
      refererUrl: stream.refererUrl,
      durationHint: stream.durationHint,
    }),
    config.SUBTITLE_AUTOSYNC_WAIT_MS,
  );

  return { vtt: sync.apply(vtt, plan), plan, stream };
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
 * Pistes disponibles pour un titre, deja triees et bornees par langue.
 *
 * Separee de la mise en forme Stremio parce que les MEMES pistes doivent pouvoir etre
 * servies sous plusieurs habillages: une fois pour la ressource `subtitles`, une fois
 * rattachees a chaque flux (chacune portant alors l'identifiant de SON flux).
 */
async function collectTracks({ type, tmdbId, season, episode }) {
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
  const perLang = Math.max(config.SUBTITLES_PER_LANG, 1);
  const tracks = [];

  for (const lang of wanted) {
    const entries = byLang.get(lang);
    if (!entries) continue;
    entries.sort((a, b) => b.score - a.score);
    entries.slice(0, perLang).forEach((entry, index) => {
      tracks.push({
        id: `movix-${entry.provider.id}-${lang}${index > 0 ? `-${index + 1}` : ''}`,
        lang,
        url: entry.url,
        provider: entry.provider.name,
      });
    });
  }

  console.log(
    `[subtitles] tmdbId=${tmdbId} ${tracks.length} piste(s)` +
      (origine.length > 0 ? ` (${origine.join(', ')})` : ' (aucun fournisseur n\'a repondu)'),
  );
  return tracks;
}

/**
 * Pistes au format Stremio.
 *
 * Le champ `lang` est un CODE. La specification dit qu'un libelle libre est affiche tel
 * quel, mais Nuvio, lui, normalise et rend "inconnu" tout ce qu'il ne reconnait pas --
 * c'est ce qui arrivait quand on suffixait les pistes ("fre (2)"). D'ou le defaut a un
 * code pur, et le libelle du fournisseur derriere un reglage.
 */
function toStremio(tracks, publicBaseUrl, bind) {
  return tracks.map((track) => ({
    id: track.id,
    lang: config.SUBTITLE_PROVIDER_LABEL ? `${track.lang} · ${track.provider}` : track.lang,
    url: subtitleUrl(publicBaseUrl, track.url, bind),
  }));
}

/** Liste de sous-titres au format Stremio, pour la ressource `subtitles`. */
async function buildSubtitles({ type, tmdbId, season, episode, publicBaseUrl, bind = null }) {
  return toStremio(await collectTracks({ type, tmdbId, season, episode }), publicBaseUrl, bind);
}

/**
 * Prepare le calage d'une piste sur un flux, en arriere-plan.
 *
 * Le calcul dure quelques dizaines de secondes: le faire au moment ou l'on ouvre le menu
 * des sous-titres serait le faire trop tard. On le lance donc a deux moments ou l'on
 * apprend quelque chose d'utile -- quand la liste des flux est rendue (le mieux classe est
 * le plus probable) et surtout quand la LECTURE COMMENCE, ou l'on sait enfin lequel c'est.
 *
 * Silencieux et sans await: un echec de prechauffage ne doit peser sur rien.
 */
const prefetching = new Set();

async function prepareSync(stream, tracks) {
  if (!config.SUBTITLE_AUTOSYNC || !stream || tracks.length === 0) return;
  const key = `${stream.id}:${tracks[0].url}`;
  if (prefetching.has(key)) return;
  prefetching.add(key);

  try {
    // Une seule piste suffit a payer le releve audio du flux, qui est le gros du travail;
    // les autres pistes du meme flux ne couteront ensuite qu'une correlation.
    const vtt = await fetchAsVtt(tracks[0].url);
    await sync.planFor({
      streamUrl: stream.url,
      streamKey: stream.key,
      subtitleKey: tracks[0].url,
      vtt,
      refererUrl: stream.refererUrl,
      durationHint: stream.durationHint,
    });
  } catch (err) {
    console.warn(`[subsync] prechauffage abandonne: ${err.message}`);
  } finally {
    prefetching.delete(key);
  }
}

// Des que le proxy sert un flux, la lecture a commence: on cale ses sous-titres pendant que
// le generique defile. C'est ce qui fait qu'a l'ouverture du menu, la piste est deja prete.
playback.whenPlaybackStarts(async (stream) => {
  if (!config.SUBTITLE_AUTOSYNC || !stream.content) return;
  const [type, tmdbId, season, episode] = String(stream.content).split(':');
  const tracks = await collectTracks({
    type,
    tmdbId,
    season: season === '' ? undefined : Number(season),
    episode: episode === '' ? undefined : Number(episode),
  }).catch(() => []);
  console.log(`[subsync] lecture demarree (${stream.label || 'flux'}) -- calage en preparation`);
  await prepareSync(stream, tracks);
});

module.exports = { buildSubtitles, collectTracks, toStremio, prepareSync, fetchAsVtt, servedVtt, readPayload, subtitleUrl, isAllowedHost };
