const allSources = require('./sources');
const { extractDirectUrl } = require('./hosterExtract');
const config = require('./config');
const cache = require('./cache');
const tmdbClient = require('./tmdb');
const { probe, formatBitrate } = require('./probe');

const MAX_CONCURRENT_EXTRACTIONS = 6;

const sources = config.ENABLED_SOURCES
  ? allSources.filter((s) => config.ENABLED_SOURCES.some((n) => n.toLowerCase() === s.name.toLowerCase()))
  : allSources;

if (config.ENABLED_SOURCES) {
  console.log(`[streamBuilder] sources actives: ${sources.map((s) => s.name).join(', ') || '(aucune)'}`);
}

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

function formatQuality(height) {
  if (!height) return null;
  return height >= 2160 ? '4K' : `${height}p`;
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

async function buildStreams({ tmdbId, type, season, episode }) {
  const cacheKey = `streams:${type}:${tmdbId}:${season ?? '-'}:${episode ?? '-'}`;

  return cache.wrap(cacheKey, config.CACHE_TTL_MS, config.CACHE_EMPTY_TTL_MS, async () => {
    const raw = await collectRawLinks({ tmdbId, type, season, episode });

    const direct = raw.filter((r) => r.direct && r.url);
    const embeds = raw.filter((r) => !r.direct && r.url);

    const unplayable = [];
    const extracted = await mapLimit(embeds, MAX_CONCURRENT_EXTRACTIONS, async (item) => {
      const result = await extractDirectUrl(item.url, item.player);
      if (result.ok) return { ...item, url: result.url, hoster: result.hoster };
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

    const seen = new Set();
    const deduped = resolved.filter((r) => {
      const key = r.externalUrl || r.url;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // La duree sert a estimer le debit d'un fichier direct (taille / duree).
    const durationSeconds = await runtimeSeconds(type, tmdbId).catch(() => null);

    const enriched = await mapLimit(deduped, MAX_CONCURRENT_EXTRACTIONS, async (r) => {
      const labelled = parseQuality(r.quality, r.player, r.sourceName, r.lang);
      const measured = r.externalUrl ? {} : await probe(r.url, { durationSeconds });
      return {
        ...r,
        // Une RESOLUTION lue dans un master HLS vaut mieux qu'un libelle "HD" approximatif.
        height: measured.height || labelled,
        bitrate: measured.bitrate,
        bitrateEstimated: measured.estimated,
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
        `${extracted.filter(Boolean).length}/${embeds.length} embed(s) extrait(s), ${enriched.length} stream(s) final(aux)`,
    );

    return enriched.map((r) => {
      const quality = formatQuality(r.height);
      const label = r.sourceName || 'Movix';
      // N'ajouter que ce qui n'est pas deja dans le libelle de la source (PurStream renvoie
      // par exemple "pulse | 1080p | MULTI", inutile de repeter la langue et la qualite).
      const details = [r.lang, r.hoster || r.player]
        .filter((part) => part && !label.toLowerCase().includes(String(part).toLowerCase()))
        .join(' · ');
      // Le debit mesure sur un fichier est une estimation (taille/duree): le "~" evite
      // de le faire passer pour une valeur annoncee par la source.
      const bitrate = formatBitrate(r.bitrate);
      const bitrateLabel = bitrate ? `${r.bitrateEstimated ? '~' : ''}${bitrate}` : null;
      const stream = {
        name: `Movix${quality ? `\n${quality}` : ''}${bitrateLabel ? `\n${bitrateLabel}` : ''}`,
        title: [label, [details, bitrateLabel].filter(Boolean).join(' · ')].filter(Boolean).join('\n'),
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
  });
}

module.exports = { buildStreams, collectRawLinks };
