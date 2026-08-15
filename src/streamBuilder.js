const movixSources = require('./sources');
const addons = require('./addons');
const { extractDirectUrl } = require('./hosterExtract');
const config = require('./config');
const cache = require('./cache');
const tmdbClient = require('./tmdb');
const { probe, formatBitrate, formatSize } = require('./probe');

const MAX_CONCURRENT_EXTRACTIONS = 6;

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
      results[index] = await fn(items[index]);
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
  if (/\b1080p?\b|\bfhd\b/i.test(haystack)) return 1080;
  if (/\b720p?\b|\bhd\b/i.test(haystack)) return 720;
  if (/\b480p?\b/i.test(haystack)) return 480;
  if (/\b360p?\b/i.test(haystack)) return 360;
  return 0;
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

// Paliers auxquels on pense en choisissant un stream. Les masters HLS annoncent parfois
// des hauteurs exotiques (1036, 468: recadrages, encodages anamorphiques) qui n'apportent
// aucune information de plus que le palier, et donnent une liste difficile a parcourir.
const QUALITY_TIERS = [2160, 1440, 1080, 720, 480, 360, 240];

function formatQuality(height) {
  if (!height) return null;
  // 10% de tolerance: 1036 se lit "1080p", mais un vrai 720p reste un 720p.
  const tier = QUALITY_TIERS.find((value) => height >= value * 0.9);
  if (!tier) return `${height}p`;
  return tier >= 2160 ? '4K' : `${tier}p`;
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
      if (other.sourceName !== candidate.sourceName || other.langRank !== candidate.langRank) return false;
      // Sans debit mesure des deux cotes, la comparaison n'a pas de sens: on garde.
      if (!other.bitrate || !candidate.bitrate) return false;
      const betterOrEqual = other.height >= candidate.height && other.bitrate >= candidate.bitrate;
      const strictlyBetter = other.height > candidate.height || other.bitrate > candidate.bitrate;
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

/** Au plus N liens par source, les meilleurs d'abord (la liste est deja triee). */
function capPerSource(streams, max) {
  if (!max || max <= 0) return streams;
  const kept = new Map();
  return streams.filter((stream) => {
    const key = stream.sourceName || 'source';
    const count = kept.get(key) || 0;
    if (count >= max) return false;
    kept.set(key, count + 1);
    return true;
  });
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
  const settled = await Promise.allSettled(sources.map((s) => s.getStreams({ tmdbId, type, season, episode })));

  settled.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.warn(`[streamBuilder] source "${sources[i].name}" a rejete sa promesse: ${r.reason?.message || r.reason}`);
    }
  });

  return settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
}

/**
 * Liens resolus et mesures, avant mise en forme Stremio. Expose pour /debug/streams:
 * c'est a ce niveau qu'on voit la difference entre "aucun debit mesure" et "debit mesure
 * mais aberrant", ce que le libelle final ne dit plus.
 */
async function resolveStreams({ tmdbId, type, season, episode }) {
  const cacheKey = `resolved:${type}:${tmdbId}:${season ?? '-'}:${episode ?? '-'}`;

  return cache.wrap(cacheKey, config.CACHE_TTL_MS, config.CACHE_EMPTY_TTL_MS, async () => {
    const raw = await collectRawLinks({ tmdbId, type, season, episode });

    const direct = raw.filter((r) => r.direct && r.url);
    const embeds = raw.filter((r) => !r.direct && r.url);

    const unplayable = [];
    const extracted = await mapLimit(embeds, MAX_CONCURRENT_EXTRACTIONS, async (item) => {
      const result = await extractDirectUrl(item.url, item.player);
      // On conserve la page d'embed: c'est elle que le CDN attend en Referer, pas sa
      // propre origine. Sans ca, la mesure de debit repart en 403.
      if (result.ok) return { ...item, url: result.url, hoster: result.hoster, embedUrl: item.url };
      if (result.reason === 'no-extractor') unplayable.push(item);
      return null;
    });

    const resolved = [...direct, ...extracted.filter(Boolean)];

    // Les embeds sans extracteur ne sont pas lisibles nativement; on peut quand meme les
    // proposer en "ouvrir dans le navigateur" (Stremio/Nuvio gerent externalUrl).
    if (config.SHOW_UNPLAYABLE_EMBEDS) {
      for (const item of unplayable) {
        resolved.push({ ...item, externalUrl: item.url });
      }
    }

    // Deduplication sur l'URL FINALE: plusieurs pages d'embed differentes (parfois de
    // sources differentes) pointent souvent vers le meme fichier chez le meme hebergeur.
    // Ce ne sont pas des liens fusionnes, ce sont les memes.
    const seen = new Set();
    const deduped = resolved.filter((r) => {
      const key = r.externalUrl || r.url;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (deduped.length < resolved.length) {
      console.log(`[streamBuilder] ${resolved.length - deduped.length} doublon(s) exact(s) ecarte(s) (meme URL finale)`);
    }

    // La duree sert a estimer le debit d'un fichier direct (taille / duree).
    const durationSeconds = await runtimeSeconds(type, tmdbId).catch(() => null);

    const enriched = await mapLimit(deduped, MAX_CONCURRENT_EXTRACTIONS, async (r) => {
      const labelled = parseQuality(r.quality, r.player, r.sourceName, r.lang);
      // `noProbe`: certaines sources limitent le debit de requetes par demandeur. Y peser
      // 5 segments avant meme que l'utilisateur appuie sur lecture depense le quota, et le
      // lecteur se retrouve ensuite devant un CDN muet. Un debit affiche ne vaut pas ca.
      const measured = r.externalUrl || r.noProbe
        ? {}
        : await probe(r.url, { durationSeconds, refererUrl: r.embedUrl, hoster: r.hoster });
      return {
        ...r,
        // Une RESOLUTION lue dans un master HLS vaut mieux qu'un libelle "HD" approximatif.
        height: measured.height || labelled,
        bitrate: measured.bitrate,
        bytes: measured.bytes,
        bitrateEstimated: measured.estimated,
        // Nombre de segments effectivement peses: c'est lui qui dit si un debit affiche
        // est solide ou tire d'un seul prelevement (cf. /debug/streams).
        bitrateSamples: measured.samples,
        langRank: langScore(r.lang, r.sourceName, r.quality, r.player),
      };
    });

    // Tri: langue preferee, resolution, puis debit -- a resolution egale, c'est le debit
    // qui separe un vrai 1080p d'un upscale compresse. Les liens externes en dernier.
    enriched.sort((a, b) => {
      if (a.langRank !== b.langRank) return a.langRank - b.langRank;
      if (b.height !== a.height) return b.height - a.height;
      if ((b.bitrate || 0) !== (a.bitrate || 0)) return (b.bitrate || 0) - (a.bitrate || 0);
      return (a.externalUrl ? 1 : 0) - (b.externalUrl ? 1 : 0);
    });

    if (unplayable.length > 0) {
      const hosts = [...new Set(unplayable.map((u) => {
        try { return new URL(u.url).hostname; } catch { return u.url.slice(0, 40); }
      }))];
      console.warn(`[streamBuilder] ${unplayable.length} embed(s) sans extracteur: ${hosts.join(', ')}`);
    }

    console.log(
      `[streamBuilder] tmdbId=${tmdbId} type=${type} S${season ?? '-'}E${episode ?? '-'} -- ` +
        `${raw.length} lien(s) brut(s) (${direct.length} direct, ${embeds.length} embed), ` +
        `${extracted.filter(Boolean).length}/${embeds.length} embed(s) extrait(s), ${enriched.length} stream(s) mesure(s)`,
    );

    return enriched;
  });
}

async function buildStreams({ tmdbId, type, season, episode }) {
  const enriched = await resolveStreams({ tmdbId, type, season, episode });

  // Elagage APRES le tri, et seulement ici: /debug/streams doit continuer a montrer TOUT
  // ce qui a ete resolu et mesure, sans quoi il ne servirait plus a diagnostiquer.
  const kept = capPerSource(
    config.PRUNE_DOMINATED ? pruneDominated(enriched) : enriched,
    config.MAX_STREAMS_PER_SOURCE,
  );

  if (kept.length < enriched.length) {
    console.log(`[streamBuilder] ${enriched.length - kept.length} lien(s) redondant(s) masque(s) (${kept.length} affiche(s))`);
  }

  return kept.map((r) => {
    const quality = formatQuality(r.height);
    const label = tidySourceName(r.sourceName);
    // N'ajouter que ce qui n'est pas deja dans le libelle de la source (PurStream renvoie
    // par exemple "pulse | 1080p | MULTI", inutile de repeter la langue et la qualite).
    const details = [r.lang, r.hoster || r.player]
      .filter((part) => part && !label.toLowerCase().includes(String(part).toLowerCase()))
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
      behaviorHints: { bingeGroup: `movix-${r.sourceName || 'source'}-${r.height || 'na'}` },
    };

    if (r.externalUrl) {
      stream.externalUrl = r.externalUrl;
      stream.title = `${stream.title}\n(ouvrir dans le navigateur)`;
    } else {
      stream.url = r.url;
      stream.behaviorHints.notWebReady = true;
    }
    return stream;
  });
}

module.exports = { buildStreams, resolveStreams, collectRawLinks };
