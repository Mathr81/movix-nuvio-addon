const movixSources = require('../sources');
const addons = require('../addons');
const { extractDirectUrl } = require('./hosterExtract');
const resolvedSources = require('../sources/resolved');
const config = require('../core/config');
const cache = require('../core/cache');
const tmdbClient = require('../integrations/tmdb');
const streamProxy = require('./streamProxy');
const { probe, formatBitrate, formatSize } = require('./probe');

const MAX_CONCURRENT_EXTRACTIONS = config.EXTRACT_CONCURRENCY;

// Deux familles, deux reglages: ENABLED_SOURCES borne les sources qui passent par Movix,
// ENABLED_ADDONS celles qui sont autonomes (cf. src/addons/index.js).
const enabledMovixSources = config.ENABLED_SOURCES
  ? movixSources.filter((s) => config.ENABLED_SOURCES.some((n) => n.toLowerCase() === s.name.toLowerCase()))
  : movixSources;

if (config.ENABLED_SOURCES) {
  console.log(`[streamBuilder] sources Movix actives: ${enabledMovixSources.map((s) => s.name).join(', ') || '(aucune)'}`);
}

const sources = [...enabledMovixSources, ...addons.asSources()];

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Extrait une resolution numerique depuis un libelle libre ("1080p", "4K", "HD"...). */
function parseQuality(...labels) {
  const haystack = labels.filter(Boolean).join(' ');
  if (/\b(4k|2160p?)\b/i.test(haystack)) return 2160;
  if (/\b1440p?\b/i.test(haystack)) return 1440;
  if (/\b1080p?\b|\bfhd\b|\bfull[\s-]*hd\b/i.test(haystack)) return 1080;
  if (/\b720p?\b|\bhd\b/i.test(haystack)) return 720;
  if (/\b480p?\b/i.test(haystack)) return 480;
  if (/\b360p?\b/i.test(haystack)) return 360;
  return 0;
}

/**
 * Definition qu'un libelle annonce PRECISEMENT, 0 sinon.
 *
 * "HD" seul ne dit rien de la definition: Movix et beaucoup de lecteurs l'affichent aussi
 * bien sur du 720p que sur du 1920x800. S'il valait 720 ici, il dispenserait la sonde de
 * lire la vraie definition, et un 1080p en scope resterait affiche 720p pour toujours.
 * Il ne sert donc qu'en dernier recours (describe), jamais pour sauter la mesure.
 */
function announcedQuality(...labels) {
  const quality = parseQuality(...labels);
  if (quality !== 720) return quality;
  return /\b720p?\b/i.test(labels.filter(Boolean).join(' ')) ? 720 : 0;
}

/**
 * 0 = langue privilegiee (francais par defaut), 1 = le reste.
 * Volontairement binaire: toutes les pistes FR se valent, c'est la resolution qui doit
 * departager entre elles (sinon un 1080p MULTI passerait devant un 4K VFF).
 */
function langScore(...labels) {
  const haystack = labels.filter(Boolean).join(' ').toUpperCase();
  return config.PREFERRED_LANGS.some((lang) => haystack.includes(lang.toUpperCase())) ? 0 : 1;
}

/**
 * Famille de langue d'un lien, celle des sous-addons (cf. STREAM_SPLIT_BY_LANG): "vostfr"
 * avant tout (son libelle ne contient pas de langue privilegiee mais doit sortir de la VO),
 * puis "vf" pour les langues privilegiees (MULTI compris: il porte une piste francaise),
 * "vo" pour le reste -- inconnu compris, faute de mieux.
 */
function langGroup(link) {
  const labels = [link.lang, link.sourceName, link.quality, link.player];
  if (/VOSTFR|\bVOST\b|SUBFRENCH/i.test(labels.filter(Boolean).join(' '))) return 'vostfr';
  return langScore(...labels) === 0 ? 'vf' : 'vo';
}

/**
 * Sous-addons ou le lien apparait. Un MULTI porte la VF ET la VO: il est dans les deux --
 * sauf pour un film francais, dont la VO est deja la VF.
 */
function langGroupsOf(link, originalLanguage) {
  const group = langGroup(link);
  if (group === 'vf' && originalLanguage !== 'fr' && /\bMULTI\b/i.test(`${link.lang} ${link.sourceName}`)) return ['vf', 'vo'];
  return [group];
}

// Les sources ecrivent la meme langue de dix facons ("vf", "French", "TRUEFRENCH"...).
// "Default" (FStream) et "und" ne disent rien: mieux vaut ne rien afficher.
const LANG_ALIASES = [
  [/^(vff|truefrench)$/i, 'VFF'],
  [/^vfq$/i, 'VFQ'],
  [/^(vf|fr|fre|fra|french|fran[cç]ais)$/i, 'VF'],
  [/^(vostfr|vost|subfrench)$/i, 'VOSTFR'],
  [/^(vo|original)$/i, 'VO'],
  [/^multi$/i, 'MULTI'],
  [/^(default|und|unknown)?$/i, undefined],
];

function normalizeLang(raw) {
  const text = String(raw ?? '').trim();
  const alias = LANG_ALIASES.find(([pattern]) => pattern.test(text));
  return alias ? alias[1] : text;
}

/** Langue originale TMDB du titre ("fr", "en"...), null si inconnue. */
async function originalLanguage(type, tmdbId) {
  const details = await cache
    .wrap(`meta:${type}:${tmdbId}`, config.CACHE_TTL_MS, config.CACHE_EMPTY_TTL_MS, () => tmdbClient.details(type, tmdbId))
    .catch(() => null);
  return details?.original_language || null;
}

// Paliers auxquels on pense en choisissant un stream, avec la LARGEUR de reference de
// chacun. Les masters HLS annoncent des resolutions exotiques (1036, 468, 800) qui
// n'apportent rien de plus que le palier et rendent la liste penible a parcourir.
const QUALITY_TIERS = [
  { height: 2160, width: 3840 },
  { height: 1440, width: 2560 },
  { height: 1080, width: 1920 },
  { height: 720, width: 1280 },
  { height: 480, width: 854 },
  { height: 360, width: 640 },
  { height: 240, width: 426 },
];

/**
 * Palier d'un stream, en pixels de hauteur (1080, 720...).
 *
 * La LARGEUR prime quand elle est connue. Un film en 2.40:1 est encode 1920x800: juger sur
 * la hauteur le faisait passer pour du 720p, alors que son image est exactement aussi
 * definie qu'un 1920x1080 -- les 280 lignes d'ecart sont des bandes noires qui n'existent
 * pas dans le fichier. C'est le cas de tous les films en scope, c'est-a-dire de la plupart
 * des grosses productions.
 *
 * La hauteur ne sert donc que faute de mieux (libelle "1080p" d'une source, master sans
 * RESOLUTION).
 */
function resolutionTier(width, height) {
  if (width > 0) {
    const byWidth = QUALITY_TIERS.find((tier) => width >= tier.width * 0.9);
    if (byWidth) return byWidth.height;
  }
  if (!height) return 0;
  // 10% de tolerance: 1036 se lit "1080p", mais un vrai 720p reste un 720p.
  return QUALITY_TIERS.find((tier) => height >= tier.height * 0.9)?.height || height;
}

function formatQuality(tier) {
  if (!tier) return null;
  return tier >= 2160 ? '4K' : `${tier}p`;
}

/** Palier d'un lien deja mesure, recalcule au besoin (entrees anterieures au champ). */
function tierOf(stream) {
  return stream.tier || resolutionTier(stream.width, stream.height);
}

/**
 * Ecarte les liens qu'un autre de la MEME source surclasse sur les deux criteres a la
 * fois (resolution ET debit). Ce ne sont pas des choix, seulement du bruit: personne ne
 * prendra volontairement le 468p a 1,1 Mb/s quand le meme fournisseur propose 1080p a
 * 2,3 Mb/s.
 *
 * Volontairement limite a une meme source: garder un lien par fournisseur preserve un
 * repli quand un hebergeur est en panne, ce qu'un simple "garder les N meilleurs" perdrait.
 */
function pruneDominated(streams) {
  return streams.filter((candidate, index) => {
    if (candidate.externalUrl) return true; // liens "ouvrir dans le navigateur": hors comparaison
    return !streams.some((other, otherIndex) => {
      if (otherIndex === index || other.externalUrl) return false;
      // `variant` distingue les fournisseurs qu'une meme source agrege (Aether/Gallic en
      // rend plusieurs par appel): deux fournisseurs differents ne sont pas des doublons,
      // ce sont deux replis.
      if (other.sourceName !== candidate.sourceName || other.variant !== candidate.variant) return false;
      // Langue EXACTE, pas seulement sa famille: une VFQ ne rend pas une VFF redondante, et
      // une VO pas une VOSTFR.
      if (langGroup(other) !== langGroup(candidate) || other.lang !== candidate.lang) return false;
      // Un autre hebergeur n'est pas un doublon: c'est le repli quand le premier tombe.
      if ((other.hoster || other.player) !== (candidate.hoster || candidate.player)) return false;

      // Rien de mesure en face: aucune raison d'ecarter quoi que ce soit.
      if (!other.bitrate) return false;

      // Le candidat n'est pas (encore) mesure, l'autre si. On l'ecarte des que l'autre le
      // vaut en resolution -- meme source, meme fournisseur: c'est le meme film dans une
      // autre definition, pas un repli.
      //
      // Ce choix est deliberement PESSIMISTE, et c'est tout l'interet: la reponse en deux
      // temps affiche d'abord une liste ou beaucoup de debits manquent. Garder ces liens
      // "au benefice du doute" les faisait apparaitre au premier affichage puis
      // DISPARAITRE au second, une fois mesures et juges redondants. Une liste qui
      // retrecit sous les yeux inquiete; une liste qui s'etoffe, non.
      if (!candidate.bitrate) return tierOf(other) >= tierOf(candidate);

      const betterOrEqual = tierOf(other) >= tierOf(candidate) && other.bitrate >= candidate.bitrate;
      const strictlyBetter = tierOf(other) > tierOf(candidate) || other.bitrate > candidate.bitrate;
      // A egalite parfaite, seul le premier survit (sinon les deux s'eliminent).
      return betterOrEqual && (strictlyBetter || otherIndex < index);
    });
  });
}

/**
 * Nettoie le libelle d'une source pour l'affichage.
 *
 * Certaines sources renvoient un nom deja compose ("pulse | 1080p | MULTI"): la resolution
 * y fait doublon avec celle qu'on affiche en gras juste au-dessus, et le separateur en
 * barre verticale jure avec le reste de la ligne.
 */
function tidySourceName(sourceName) {
  if (!sourceName) return 'Movix';
  return String(sourceName)
    .split(/\s*[|·]\s*/)
    .map((part) => part.trim())
    .filter((part) => part && !/^(4k|\d{3,4}p)$/i.test(part))
    .join(' · ');
}

/**
 * Au plus N liens par source ET par famille de langue, les meilleurs d'abord (la liste est
 * deja triee): sans la langue, les deux 4K VO d'une source prendraient la place de sa VF.
 *
 * Les places restantes vont d'abord a une AUTRE langue (la VFF a cote de la VFQ), puis a
 * un autre hebergeur (un vrai repli), et seulement ensuite a un autre palier du meme.
 */
function capPerSource(streams, max) {
  if (!max || max <= 0) return streams;
  const keyOf = (stream) => `${stream.sourceName || 'source'}|${langGroup(stream)}`;
  const picked = new Set();
  const count = new Map();
  for (const facet of [(s) => s.lang || '', (s) => s.hoster || s.player || '', null]) {
    const seen = new Set([...picked].map((s) => facet && `${keyOf(s)}|${facet(s)}`));
    for (const stream of streams) {
      const key = keyOf(stream);
      if (picked.has(stream) || (count.get(key) || 0) >= max) continue;
      if (facet) {
        const mark = `${key}|${facet(stream)}`;
        if (seen.has(mark)) continue;
        seen.add(mark);
      }
      picked.add(stream);
      count.set(key, (count.get(key) || 0) + 1);
    }
  }
  return streams.filter((stream) => picked.has(stream));
}

/** Duree du titre en secondes, depuis TMDB (runtime film ou duree moyenne d'episode). */
async function runtimeSeconds(type, tmdbId) {
  const details = await cache.wrap(`meta:${type}:${tmdbId}`, config.CACHE_TTL_MS, config.CACHE_EMPTY_TTL_MS, () =>
    tmdbClient.details(type, tmdbId),
  );
  const minutes = type === 'series' ? details.episode_run_time?.[0] : details.runtime;
  return Number(minutes) > 0 ? Number(minutes) * 60 : null;
}

async function collectRawLinks({ tmdbId, type, season, episode }) {
  const [settled, original] = await Promise.all([
    Promise.allSettled(sources.map((s) => s.getStreams({ tmdbId, type, season, episode }))),
    originalLanguage(type, tmdbId),
  ]);

  settled.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.warn(`[streamBuilder] source "${sources[i].name}" a rejete sa promesse: ${r.reason?.message || r.reason}`);
    }
  });

  // Langue normalisee des l'entree: tri, elagage, categories et affichage lisent la meme.
  // Pour un film francais, la VO (ou une langue inconnue) EST la VF.
  return settled
    .flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
    .map((link) => {
      const lang = normalizeLang(link.lang);
      const out = lang === link.lang ? link : { ...link, lang };
      return original === 'fr' && langGroup(out) === 'vo' ? { ...out, lang: 'VF' } : out;
    });
}

/** Ce qui designe le FICHIER servi: la cible d'un lien proxifie, pas l'URL de proxy. */
function sameFileKey(link) {
  return link.externalUrl || streamProxy.targetOf(link.url) || link.url;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.());

/** Mesures encore en cours, par cle de cache (cf. l'option `wait`). */
const completing = new Map();

/** Un lien, decrit avec ce que la sonde en sait -- rien au depart, tout a la fin. */
function describe(link, measured) {
  const labelled = parseQuality(link.quality, link.player, link.sourceName, link.lang);
  const height = measured.height || labelled;
  return {
    ...link,
    // Une RESOLUTION lue dans un master HLS vaut mieux qu'un libelle "HD" approximatif.
    height,
    width: measured.width,
    // Palier retenu: une seule notion pour l'affichage, le tri ET l'elagage, sans quoi deux
    // liens seraient compares sur une echelle et affiches sur une autre.
    tier: resolutionTier(measured.width, height),
    bitrate: measured.bitrate,
    bytes: measured.bytes,
    bitrateEstimated: measured.estimated,
    // Nombre de segments effectivement peses: c'est lui qui dit si un debit affiche est
    // solide ou tire d'un seul prelevement (cf. /debug/streams).
    bitrateSamples: measured.samples,
    // D'ou vient la definition affichee: lue dans le flux par ffprobe faute d'etre annoncee
    // ("flux"), lue ou deduite de la playlist ("playlist"), ou seulement annoncee par la
    // source ("libelle"). Sert a diagnostiquer un palier douteux (cf. /debug/streams).
    resolutionSource: measured.resolutionProbed
      ? 'flux'
      : (measured.height ? 'playlist' : (labelled ? 'libelle' : 'aucune')),
    langRank: langScore(link.lang, link.sourceName, link.quality, link.player),
    // La sonde n'a pu joindre le lien par aucune voie (statut d'erreur, timeout).
    unreachable: measured.unreachable,
  };
}

/**
 * Tri, par blocs de definition: 4K, puis 1080p, puis 720p... C'est ce qu'on cherche en
 * parcourant la liste; la langue passait avant, et une 4K en VO se retrouvait noyee apres
 * tous les 720p francais. Dans chaque palier: langue preferee d'abord, puis debit -- a
 * definition egale, c'est lui qui separe un vrai 1080p d'un upscale compresse.
 *
 * En queue: les liens que la sonde n'a pu joindre (releguees, pas masques -- un hebergeur
 * peut n'etre tombe que quelques minutes), puis les liens externes.
 */
function sortStreams(streams) {
  return streams.sort((a, b) => {
    if (!!a.externalUrl !== !!b.externalUrl) return a.externalUrl ? 1 : -1;
    if (!!a.unreachable !== !!b.unreachable) return a.unreachable ? 1 : -1;
    if (tierOf(b) !== tierOf(a)) return tierOf(b) - tierOf(a);
    if (a.langRank !== b.langRank) return a.langRank - b.langRank;
    return (b.bitrate || 0) - (a.bitrate || 0);
  });
}

/**
 * Liens resolus et mesures, avant mise en forme Stremio. Expose pour /debug/streams:
 * c'est a ce niveau qu'on voit la difference entre "aucun debit mesure" et "debit mesure
 * mais aberrant", ce que le libelle final ne dit plus.
 *
 * `wait` attend que TOUTES les mesures soient finies (diagnostic); par defaut on rend la
 * main au bout de STREAM_FIRST_ANSWER_MS et les sondes restantes continuent seules.
 *
 * `refresh` ignore le cache et refait tout: c'est la seule facon de voir des liens apparus
 * depuis. Les liens du scan precedent qui ne ressortent pas sont CONSERVES -- une source
 * muette pendant un tour ne doit pas faire disparaitre ce qu'elle avait donne.
 */
async function resolveStreams({ tmdbId, type, season, episode, wait = false, refresh = false }) {
  const cacheKey = `resolved:${type}:${tmdbId}:${season ?? '-'}:${episode ?? '-'}`;

  const previous = refresh ? cache.get(cacheKey) || null : null;
  if (refresh) {
    cache.del(cacheKey);
    completing.delete(cacheKey);
  }

  const first = await cache.wrap(cacheKey, config.STREAM_TTL_MS, config.CACHE_EMPTY_TTL_MS, async () => {
    const raw = await collectRawLinks({ tmdbId, type, season, episode });

    const direct = raw.filter((r) => r.direct && r.url);
    const embeds = raw.filter((r) => !r.direct && r.url);

    // Ce qui reste a extraire ici est ce que le serveur Movix n'a PAS resolu: les liens
    // qu'il a resolus arrivent deja en `direct` (cf. src/sources/resolved.js), avec une
    // m3u8 proxifiee et signee par ses soins.
    const unplayable = [];
    const serverOnly = [];
    const extracted = await mapLimit(embeds, MAX_CONCURRENT_EXTRACTIONS, async (item) => {
      const result = await extractDirectUrl(item.url, item.player);
      // On conserve la page d'embed: c'est elle que le CDN attend en Referer, pas sa
      // propre origine. Sans ca, la mesure de debit repart en 403.
      if (result.ok) return { ...item, url: result.url, hoster: result.hoster, embedUrl: item.url };
      if (result.reason === 'no-extractor') unplayable.push(item);
      // Hebergeur extractible, mais par Movix seulement: le lien n'est pas mort, c'est la
      // resolution serveur qui n'a rien rendu (pas de cle VIP, VIP expiree, extraction en
      // echec cote Movix). Le distinguer evite de lire une liste vide comme "plus aucune
      // source" alors qu'il ne manque qu'une cle.
      if (result.reason === 'server-only') serverOnly.push({ ...item, hoster: result.hoster });
      return null;
    });

    if (serverOnly.length > 0) {
      const detail = resolvedSources.enabled()
        ? 'le serveur Movix ne les a pas resolus (extraction amont en echec, ou cle VIP refusee)'
        : 'MOVIX_RESOLVE desactive ou VIP_ACCESS_KEY absent -- ces hebergeurs ne sont extractibles que par Movix';
      console.warn(`[streamBuilder] ${serverOnly.length} lien(s) non resolu(s): ${detail}`);
    }

    const resolved = [...direct, ...extracted.filter(Boolean)];

    // Ni les embeds sans extracteur ni ceux que seul Movix sait lire ne sont lisibles
    // nativement; on peut quand meme les proposer en "ouvrir dans le navigateur"
    // (Stremio/Nuvio gerent externalUrl) plutot que de les jeter.
    if (config.SHOW_UNPLAYABLE_EMBEDS) {
      for (const item of [...unplayable, ...serverOnly]) {
        resolved.push({ ...item, externalUrl: item.url });
      }
    }

    // Deduplication sur l'URL FINALE: plusieurs pages d'embed differentes (parfois de
    // sources differentes) pointent souvent vers le meme fichier chez le meme hebergeur.
    // Ce ne sont pas des liens fusionnes, ce sont les memes.
    //
    // Pour un lien proxifie, c'est la CIBLE qui compte, pas l'URL de proxy: celle-ci scelle
    // aussi les en-tetes, et deux sources qui proxifient le meme fichier avec des en-tetes
    // a peine differents (Obrigoz ajoute accept-language a son Sharecloudy, l'extracteur
    // local non) donnaient deux fois le meme film dans Nuvio. Le lien garde note les
    // autres sources qui le proposaient (`alsoFrom`), pour qu'aucune ne semble perdue.
    const kept = new Map();
    const deduped = resolved.filter((r) => {
      const key = sameFileKey(r);
      const first = kept.get(key);
      if (first) {
        if (r.sourceName && r.sourceName !== first.sourceName && !first.alsoFrom.includes(r.sourceName)) {
          first.alsoFrom.push(r.sourceName);
        }
        return false;
      }
      r.alsoFrom = [];
      kept.set(key, r);
      return true;
    });
    if (deduped.length < resolved.length) {
      console.log(`[streamBuilder] ${resolved.length - deduped.length} doublon(s) exact(s) ecarte(s) (meme URL finale)`);
    }

    // La duree sert a estimer le debit d'un fichier direct (taille / duree).
    const durationSeconds = await runtimeSeconds(type, tmdbId).catch(() => null);

    // Budget commun a TOUTE la phase de mesure. Une sonde lente n'est pas grave en soi;
    // ce qui l'est, c'est qu'elle retarde la liste entiere. Passe ce delai, les liens
    // restants sont rendus sans debit plutot que de faire attendre l'ouverture de la fiche
    // -- et rien n'est mis en cache, la mesure sera retentee au prochain passage.
    const probeDeadline = config.PROBE_PHASE_BUDGET_MS > 0 ? Date.now() + config.PROBE_PHASE_BUDGET_MS : 0;

    // Ce qu'un scan precedent avait trouve et qui ne ressort pas cette fois. Une source
    // peut etre muette un tour (502, timeout, changement de domaine) sans que ses liens
    // soient morts pour autant: les perdre donnerait une liste qui RETRECIT quand on
    // demande a la rafraichir, exactement l'inverse de ce qu'on cherchait.
    // Ils gardent leurs mesures, et disparaitront d'eux-memes a l'expiration du cache.
    // Meme cle que la deduplication: sinon un lien fusionne a ce scan reviendrait par ici.
    //
    // Seulement pour une source MUETTE ce tour-ci: une source qui a repondu a dit ce qu'elle
    // a. Reprendre ses anciens liens accumulait des doublons a chaque rescan (une URL a jeton
    // change d'un scan a l'autre) et gardait pour toujours ceux qu'elle ne sert plus.
    const found = new Set(deduped.map(sameFileKey));
    const answered = new Set(deduped.map((r) => r.sourceName));
    const carried = (previous || []).filter((p) => !found.has(sameFileKey(p)) && !answered.has(p.sourceName));
    if (carried.length > 0) {
      console.log(`[streamBuilder] ${carried.length} lien(s) conserve(s) du scan precedent`);
    }

    // Chaque lien est d'abord decrit SANS mesure, puis sa case est remplacee des que sa
    // sonde repond. La liste est donc lisible a tout instant, complete ou non.
    const slots = deduped.map((r) => describe(r, {}));
    const measuring = mapLimit(deduped, config.PROBE_CONCURRENCY, async (r, index) => {
      const measured = r.externalUrl
        ? {}
        : await probe(r.url, {
            durationSeconds,
            refererUrl: r.embedUrl,
            deadline: probeDeadline,
            refresh,
            // Le libelle du lien dit deja "1080p": inutile d'aller ouvrir le flux pour le
            // reapprendre. La sonde de definition ne sert qu'aux liens dont PERSONNE ne
            // connait la definition -- un simple "HD" n'en dit pas assez (announcedQuality).
            knownHeight: announcedQuality(r.quality, r.player, r.sourceName, r.lang),
          }).catch(() => ({}));
      slots[index] = describe(r, measured);
    });

    if (unplayable.length > 0) {
      const hosts = [...new Set(unplayable.map((u) => {
        try { return new URL(u.url).hostname; } catch { return u.url.slice(0, 40); }
      }))];
      console.warn(`[streamBuilder] ${unplayable.length} embed(s) sans extracteur: ${hosts.join(', ')}`);
    }

    // Reponse en deux temps: on n'attend les mesures que le temps qu'on s'est donne, puis
    // on rend ce qu'on a. Les sondes restantes CONTINUENT, et remplacent l'entree de cache
    // quand elles ont fini -- l'ouverture suivante de la fiche aura tout.
    //
    // Nuvio redemande /stream a chaque ouverture: le debit manquant au premier affichage
    // est la au second, sans qu'on ait fait attendre qui que ce soit.
    const waited = config.STREAM_FIRST_ANSWER_MS > 0 && !wait;
    if (waited) await Promise.race([measuring, delay(config.STREAM_FIRST_ANSWER_MS)]);
    else await measuring;

    const complete = measuring.then(() => {
      const finished = sortStreams([...slots, ...carried]);
      cache.set(cacheKey, finished, config.STREAM_TTL_MS);
      completing.delete(cacheKey);
      return finished;
    });
    completing.set(cacheKey, complete);
    complete.catch(() => completing.delete(cacheKey));

    const enriched = sortStreams([...slots, ...carried]);
    const mesures = enriched.filter((r) => r.bitrate).length;

    console.log(
      `[streamBuilder] tmdbId=${tmdbId} type=${type} S${season ?? '-'}E${episode ?? '-'} -- ` +
        `${raw.length} lien(s) brut(s) (${direct.length} direct, ${embeds.length} embed), ` +
        `${extracted.filter(Boolean).length}/${embeds.length} embed(s) extrait(s), ` +
        `${mesures}/${enriched.length} debit(s) mesure(s)` +
        `${mesures < enriched.length && waited ? ' -- le reste continue en arriere-plan' : ''}`,
    );

    return enriched;
  });

  // `wait`: /debug/streams doit voir la mesure ACHEVEE, sinon il decrirait un etat
  // transitoire et on diagnostiquerait un debit manquant qui n'en est pas un.
  if (wait && completing.has(cacheKey)) {
    await completing.get(cacheKey);
    return cache.get(cacheKey) || first;
  }
  return first;
}

async function buildStreams({ tmdbId, type, season, episode, refresh = false, group = null }) {
  const [enriched, original] = await Promise.all([
    resolveStreams({ tmdbId, type, season, episode, refresh }),
    group ? originalLanguage(type, tmdbId) : null,
  ]);

  // Elagage APRES le tri, et seulement ici: /debug/streams doit continuer a montrer TOUT
  // ce qui a ete resolu et mesure, sans quoi il ne servirait plus a diagnostiquer.
  // Plancher avant l'elagage, pour qu'un 480p n'occupe pas une place de MAX_STREAMS_PER_SOURCE.
  // Palier inconnu (0) = garde: on ne sait pas ce qu'il vaut.
  const watchable = enriched.filter((r) => !(tierOf(r) > 0 && tierOf(r) < config.MIN_STREAM_QUALITY));
  const kept = config.keepAllStreams()
    ? watchable
    : capPerSource(pruneDominated(watchable), config.MAX_STREAMS_PER_SOURCE);

  if (kept.length < enriched.length) {
    console.log(`[streamBuilder] ${enriched.length - kept.length} lien(s) redondant(s) masque(s) (${kept.length} affiche(s))`);
  }

  const built = kept.map((r) => {
    const quality = formatQuality(tierOf(r));
    const label = tidySourceName(r.sourceName);
    // N'ajouter que ce qui n'est pas deja dans le libelle de la source (PurStream renvoie
    // par exemple "pulse | 1080p | MULTI", inutile de repeter la langue et la qualite).
    // La definition est deja en gras au-dessus: on la retire des morceaux ("Lisbon 4K HDR"
    // -> "Lisbon HDR"), puis on ecarte ceux qu'un autre contient deja ("Lisbon").
    const parts = [r.lang, r.variant, r.hoster || r.player]
      .map((part) => String(part || '').replace(/\b(4k|\d{3,4}p)\b/gi, '').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    const details = parts
      .filter((part, i) => {
        const lower = part.toLowerCase();
        if (label.toLowerCase().includes(lower)) return false;
        return !parts.some((other, j) => j !== i && other.toLowerCase().includes(lower) && (other.length > part.length || j < i));
      })
      .join(' · ');
    // Le debit mesure sur un fichier est une estimation (taille/duree): le "~" evite
    // de le faire passer pour une valeur annoncee par la source.
    // A defaut de debit (duree inconnue), la taille du fichier reste comparable.
    const bitrate = formatBitrate(r.bitrate);
    const bitrateLabel = bitrate ? `${r.bitrateEstimated ? '~' : ''}${bitrate}` : formatSize(r.bytes);

    // Deux lignes, aucune repetition. Nuvio regroupe DEJA les streams sous le nom de
    // l'addon: reecrire "Movix" sur chaque ligne et repeter le debit en gras puis en gris
    // remplissait quatre lignes pour deux informations utiles -- ce qui est exactement ce
    // qui rend une liste de dix liens penible a parcourir.
    const stream = {
      name: [quality, bitrateLabel].filter(Boolean).join('\n') || 'Movix',
      title: [label, details].filter(Boolean).join(' · '),
      behaviorHints: { bingeGroup: `movix-${r.sourceName || 'source'}-${tierOf(r) || 'na'}` },
    };

    if (r.unreachable) {
      stream.name = `⚠ ${stream.name}`;
      stream.title = `${stream.title}\n⚠ injoignable au dernier test (${r.unreachable === 'timeout' ? 'délai dépassé' : `HTTP ${r.unreachable}`})`;
    }

    if (r.externalUrl) {
      stream.externalUrl = r.externalUrl;
      stream.title = `${stream.title}\n(ouvrir dans le navigateur)`;
    } else {
      stream.url = r.url;
      stream.behaviorHints.notWebReady = true;
    }

    // Sous-titres fournis par la source elle-meme (KissKH, Movy): ils viennent du meme
    // fichier que la video, donc cales par construction, et couvrent souvent des langues
    // qu'OpenSubtitles n'a pas pour ce titre.
    if (Array.isArray(r.subtitles) && r.subtitles.length > 0) stream.subtitles = r.subtitles;

    return stream;
  });

  return group ? built.filter((_, index) => langGroupsOf(kept[index], original).includes(group)) : built;
}

/**
 * Prepare l'episode suivant, en arriere-plan.
 *
 * Quand une fiche d'episode s'ouvre, la suite du visionnage est previsible: c'est l'episode
 * d'apres. Le resoudre pendant qu'on regarde celui-ci rend son ouverture immediate, pour
 * une seule resolution de plus -- la ou precharger tout un catalogue en couterait des
 * dizaines pour rien.
 *
 * Silencieux et sans await: un echec de prechauffage ne doit jamais peser sur la reponse
 * qui vient d'etre rendue.
 */
function prefetchNextEpisode({ tmdbId, type, season, episode }) {
  if (!config.PREFETCH_NEXT_EPISODE || type !== 'series') return;
  if (season == null || episode == null) return;

  const next = Number(episode) + 1;
  const cacheKey = `resolved:${type}:${tmdbId}:${season}:${next}`;
  // Deja en cache ou deja en cours: rien a faire.
  if (cache.get(cacheKey) !== undefined || completing.has(cacheKey)) return;

  setTimeout(async () => {
    try {
      // L'episode existe-t-il seulement? Sans cette verification, une fin de saison
      // declencherait un tour complet de scraping pour un episode qui n'existe pas.
      const details = await cache.wrap(
        `season:${tmdbId}:${season}`,
        config.CACHE_TTL_MS,
        config.CACHE_EMPTY_TTL_MS,
        () => tmdbClient.season(tmdbId, season),
      );
      const exists = (details?.episodes || []).some((ep) => ep.episode_number === next);
      if (!exists) return;

      await resolveStreams({ tmdbId, type, season, episode: next, wait: true });
      console.log(`[streamBuilder] S${season}E${next} prepare a l'avance`);
    } catch (err) {
      console.warn(`[streamBuilder] prechauffage S${season}E${next} abandonne: ${err.message}`);
    }
  }, config.PREFETCH_DELAY_MS).unref();
}

module.exports = { buildStreams, resolveStreams, collectRawLinks, prefetchNextEpisode };
// Exposes pour les bancs d'essai: regles de langue et de limite, sans tout le pipeline.
Object.assign(module.exports, { capPerSource, normalizeLang, langGroupsOf });
