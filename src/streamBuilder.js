const sources = require('./sources');
const { extractDirectUrl } = require('./hosterExtract');

const MAX_CONCURRENT_EXTRACTIONS = 6;

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

async function buildStreams({ tmdbId, type, season, episode }) {
  const settled = await Promise.allSettled(sources.map((s) => s.getStreams({ tmdbId, type, season, episode })));

  settled.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.warn(`[streamBuilder] source "${sources[i].name}" a rejete sa promesse: ${r.reason?.message || r.reason}`);
    }
  });

  const raw = settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));

  const direct = raw.filter((r) => r.direct && r.url);
  const embeds = raw.filter((r) => !r.direct && r.url);

  const extracted = await mapLimit(embeds, MAX_CONCURRENT_EXTRACTIONS, async (item) => {
    const result = await extractDirectUrl(item.url, item.player);
    return result ? { ...item, url: result.url, hoster: result.hoster } : null;
  });

  const resolved = [...direct, ...extracted.filter(Boolean)];

  const seen = new Set();
  const deduped = resolved.filter((r) => {
    if (seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });

  console.log(
    `[streamBuilder] tmdbId=${tmdbId} type=${type} S${season ?? '-'}E${episode ?? '-'} -- ` +
      `${raw.length} lien(s) brut(s) (${direct.length} direct, ${embeds.length} embed), ` +
      `${extracted.filter(Boolean).length}/${embeds.length} embed(s) extrait(s), ${deduped.length} stream(s) final(aux)`,
  );

  return deduped.map((r) => {
    const label = [r.sourceName, r.lang, r.quality, r.hoster].filter(Boolean).join(' · ');
    return {
      name: 'Movix',
      title: label || r.sourceName || 'Movix',
      url: r.url,
      behaviorHints: { notWebReady: true, bingeGroup: `movix-${r.sourceName || 'source'}` },
    };
  });
}

module.exports = { buildStreams };
