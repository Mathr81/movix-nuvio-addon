#!/usr/bin/env node
/**
 * Scan des hebergeurs: tire un echantillon varie de titres TMDB (genres x decennies, films
 * et series, contenus francais, anime), recupere tous les liens bruts des sources, et
 * classe les hebergeurs qu'aucun extracteur ne sait lire.
 *
 * Lancer depuis la racine du depot (il lit .env via src/core/config):
 *   node scripts/scanHosters.js [--per-bucket 1] [--concurrency 3] [--out scan-results]
 * Dans le container:
 *   docker exec -i -w /app movix-addon node - --out /tmp/scan < scripts/scanHosters.js
 *
 * Sorties dans --out: links.jsonl (un lien par ligne) et summary.md (classement).
 * Long par nature: compter ~20-60 s par titre, plusieurs titres en parallele.
 */
const fs = require('fs');
const path = require('path');

const src = (p) => path.resolve(process.cwd(), 'src', p);
const tmdb = require(src('integrations/tmdb'));
const diagnostics = require(src('diagnostics'));
const { extractDirectUrl, LOCAL_EXTRACTORS } = require(src('streaming/hosterExtract'));

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const PER_BUCKET = Number(arg('per-bucket', 1));
const CONCURRENCY = Number(arg('concurrency', 3));
const OUT = path.resolve(arg('out', 'scan-results'));
const TITLE_TIMEOUT_MS = Number(arg('timeout', 120000));

const GENRES = {
  movie: { 28: 'action', 35: 'comedie', 18: 'drame', 27: 'horreur', 16: 'animation', 99: 'docu', 878: 'SF', 10749: 'romance', 53: 'thriller', 10751: 'famille' },
  series: { 10759: 'action', 35: 'comedie', 18: 'drame', 16: 'animation', 80: 'crime', 10765: 'SF', 99: 'docu', 10764: 'tele-realite', 9648: 'mystere', 10762: 'enfants' },
};
const DECADES = [[1970, 1989], [1990, 1999], [2000, 2009], [2010, 2019], [2020, new Date().getFullYear()]];

function dateParams(type, [from, to]) {
  const key = type === 'series' ? 'first_air_date' : 'primary_release_date';
  return { [`${key}.gte`]: `${from}-01-01`, [`${key}.lte`]: `${to}-12-31` };
}

async function sample() {
  const picked = new Map();
  const add = (type, results, label, n = PER_BUCKET) => {
    for (const r of results.filter((x) => !picked.has(`${type}:${x.id}`)).slice(0, n)) {
      const year = (r.release_date || r.first_air_date || '').slice(0, 4);
      picked.set(`${type}:${r.id}`, { type, tmdbId: r.id, title: r.title || r.name, year, bucket: label });
    }
  };
  for (const type of ['movie', 'series']) {
    for (const [gid, gname] of Object.entries(GENRES[type])) {
      for (const decade of DECADES) {
        const res = await tmdb
          .discoverWith(type, { with_genres: gid, sort_by: 'popularity.desc', 'vote_count.gte': 50, ...dateParams(type, decade) })
          .catch(() => []);
        add(type, res, `${gname} ${decade[0]}-${decade[1]}`);
      }
    }
    // Les sources sont francaises: les productions francaises y sont surrepresentees.
    add(type, await tmdb.discoverWith(type, { with_original_language: 'fr', sort_by: 'popularity.desc' }).catch(() => []), 'francais', 8);
    add(type, await tmdb.discoverWith(type, { with_original_language: 'ja', with_genres: 16, sort_by: 'popularity.desc' }).catch(() => []), 'anime', 5);
    add(type, await tmdb.nowPlaying(type).catch(() => []), 'nouveautes', 5);
  }
  return [...picked.values()];
}

// Groupe par domaine enregistrable (1.multiup.us, ww547.listeamed.net -> multiup.us...).
function domainOf(url) {
  try {
    const labels = new URL(url).hostname.split('.');
    return labels.slice(-2).join('.');
  } catch {
    return '?';
  }
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}

async function scanTitle(t) {
  const id = t.type === 'series' ? `tmdb:${t.tmdbId}:1:1` : `tmdb:${t.tmdbId}`;
  const raw = await withTimeout(diagnostics.rawLinks(t.type, id), TITLE_TIMEOUT_MS);
  const rows = [];
  for (const l of raw.links) {
    let status;
    if (l.direct) status = 'direct';
    else if (l.hoster === 'AUCUN EXTRACTEUR') {
      // Le lecteur jwplayer generique lit parfois un hebergeur inconnu: on le verifie.
      const r = await withTimeout(extractDirectUrl(l.url, l.player), 30000).catch((e) => ({ ok: false, reason: e.message }));
      status = r.ok ? 'inconnu-mais-lu' : 'aucun-extracteur';
    } else status = LOCAL_EXTRACTORS.has(l.hoster) ? `local:${l.hoster}` : `server-only:${l.hoster}`;
    rows.push({ ...t, id, source: l.source, player: l.player, quality: l.quality, lang: l.lang, hoster: l.hoster, status, domain: domainOf(l.url), url: l.url });
  }
  return rows;
}

function summarize(rows, titles, failures) {
  const lines = [`# Scan des hebergeurs — ${new Date().toISOString().slice(0, 16)}`, ''];
  lines.push(`${titles.length} titres, ${rows.length} liens, ${failures.length} titres en echec.`, '');

  const group = (filter, key) => {
    const m = new Map();
    for (const r of rows.filter(filter)) {
      const k = key(r);
      const g = m.get(k) || { links: 0, titles: new Set(), sources: new Set(), labels: new Set(), examples: [] };
      g.links++;
      g.titles.add(`${r.type}:${r.tmdbId}`);
      g.sources.add(r.source);
      if (r.quality || r.player) g.labels.add(String(r.quality || r.player).slice(0, 40));
      if (g.examples.length < 3 && !g.examples.some((e) => e.includes(r.title))) g.examples.push(`${r.url} (${r.title} ${r.year})`);
      m.set(k, g);
    }
    return [...m.entries()].sort((a, b) => b[1].titles.size - a[1].titles.size);
  };
  const table = (entries) => {
    lines.push('| Domaine | Titres | Liens | Sources | Libelles | Exemples |', '|---|---|---|---|---|---|');
    for (const [k, g] of entries) {
      lines.push(`| ${k} | ${g.titles.size} | ${g.links} | ${[...g.sources].join(', ')} | ${[...g.labels].slice(0, 3).join(' ; ')} | ${g.examples.join('<br>')} |`);
    }
    lines.push('');
  };

  lines.push('## Sans extracteur (ni dedie, ni jwplayer generique)', '');
  table(group((r) => r.status === 'aucun-extracteur', (r) => r.domain));
  lines.push('## Hebergeurs connus mais extraits par Movix seulement (server-only)', '');
  table(group((r) => r.status.startsWith('server-only:'), (r) => r.hoster));
  lines.push('## Inconnus mais lus par le jwplayer generique', '');
  table(group((r) => r.status === 'inconnu-mais-lu', (r) => r.domain));

  lines.push('## Repartition globale', '', '| Statut | Liens |', '|---|---|');
  const counts = {};
  for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
  for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) lines.push(`| ${k} | ${v} |`);
  if (failures.length) lines.push('', '## Titres en echec', '', ...failures.map((f) => `- ${f.title} (${f.type} ${f.tmdbId}): ${f.error}`));
  return lines.join('\n');
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const titles = await sample();
  console.error(`[scan] ${titles.length} titres a scanner, ${CONCURRENCY} en parallele`);
  const out = fs.createWriteStream(path.join(OUT, 'links.jsonl'));
  const rows = [];
  const failures = [];
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < titles.length) {
      const t = titles[next++];
      try {
        const r = await scanTitle(t);
        rows.push(...r);
        for (const row of r) out.write(`${JSON.stringify(row)}\n`);
        console.error(`[scan] ${++done}/${titles.length} ${t.title} (${t.year}, ${t.bucket}): ${r.length} liens, ${r.filter((x) => x.status === 'aucun-extracteur').length} sans extracteur`);
      } catch (err) {
        failures.push({ ...t, error: err.message });
        console.error(`[scan] ${++done}/${titles.length} ${t.title}: ECHEC ${err.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  out.end();
  const summary = summarize(rows, titles, failures);
  fs.writeFileSync(path.join(OUT, 'summary.md'), summary);
  console.log(summary);
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
