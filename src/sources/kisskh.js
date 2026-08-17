const { mainApi } = require('../integrations/movixClient');
const config = require('../core/config');
const log = require('../core/log');

/**
 * KissKH -- dramas et films asiatiques (coreens, chinois, japonais, thai).
 *
 *   /api/kisskh/movie/<tmdbId>
 *   /api/kisskh/tv/<tmdbId>?season=<n>&episode=<n>
 *
 * Deux particularites par rapport aux autres sources Movix:
 *
 *  - l'`url` renvoyee est DEJA proxifiee par le site (proxiesembed/kisskh-proxy) et
 *    pointe sur un master HLS: rien a extraire, c'est un lien direct;
 *  - la reponse porte ses propres sous-titres, souvent la seule piste francaise
 *    disponible pour ce catalogue -- OpenSubtitles couvre mal les dramas asiatiques.
 *    On les rattache au stream plutot que de les jeter.
 *
 * La piste audio est la version originale. On n'annonce "VOSTFR" que si la reponse
 * contient effectivement une piste francaise, sinon "VO": promettre du francais sur un
 * episode qui n'en a pas fausserait le tri par PREFERRED_LANGS.
 */

// Les sous-titres Stremio attendent un code ISO 639-2, la reponse donne du 639-1.
const ISO_639_1_TO_2 = {
  fr: 'fre',
  en: 'eng',
  ar: 'ara',
  id: 'ind',
  ms: 'msa',
  km: 'khm',
  ko: 'kor',
  zh: 'zho',
  ja: 'jpn',
  th: 'tha',
  vi: 'vie',
  es: 'spa',
  pt: 'por',
  de: 'ger',
  it: 'ita',
  ru: 'rus',
  tr: 'tur',
};

function toSubtitles(raw) {
  const out = [];
  const seen = new Set();

  for (const sub of Array.isArray(raw) ? raw : []) {
    // `proxyUrl` porte les en-tetes que le CDN de sous-titres exige; `sourceUrl` est
    // servi tel quel et se fait refuser hors du site.
    const url = sub?.proxyUrl || sub?.sourceUrl;
    if (!url) continue;
    // `cipher.mode` autre que "none" = piste chiffree par KissKH, illisible telle quelle.
    if (sub?.cipher && sub.cipher.mode && sub.cipher.mode !== 'none') continue;

    const lang = ISO_639_1_TO_2[String(sub.lang || '').toLowerCase()] || sub.lang;
    if (!lang || seen.has(lang)) continue; // une piste par langue suffit
    seen.add(lang);

    out.push({ id: sub.id || `kisskh-${lang}`, url, lang });
  }
  return out;
}

function toStreams(data, tmdbId) {
  const subtitles = toSubtitles(data?.subtitles);
  const hasFrench = subtitles.some((s) => s.lang === 'fre');
  const lang = hasFrench ? config.KISSKH_LANG_VOSTFR : config.KISSKH_LANG;

  return (Array.isArray(data?.sources) ? data.sources : [])
    .filter((s) => s?.url)
    .map((s) => ({
      url: s.url,
      direct: true,
      lang,
      variant: s.label && s.label !== 'KissKH' ? s.label : undefined,
      sourceName: 'KissKH',
      // `type: 'hls'` cote API; la sonde de debit sait lire un master HLS.
      quality: s.type === 'hls' ? undefined : s.type,
      subtitles: subtitles.length > 0 ? subtitles : undefined,
      tmdbId,
    }));
}

async function getStreams({ tmdbId, type, season, episode }) {
  try {
    const { data } =
      type === 'movie'
        ? await mainApi.get(`/api/kisskh/movie/${tmdbId}`)
        : await mainApi.get(`/api/kisskh/tv/${tmdbId}`, { params: { season, episode } });

    const results = toStreams(data, tmdbId);
    const subs = results[0]?.subtitles?.length || 0;
    log.ok(
      'KissKH',
      tmdbId,
      `${results.length} source(s) directe(s), ${subs} sous-titre(s)` +
        (data?.match?.kisskhDramaId ? ` (drama ${data.match.kisskhDramaId})` : ''),
    );
    return results;
  } catch (err) {
    // 404 = ce titre n'est pas dans le catalogue KissKH, cas normal et majoritaire
    // (il ne couvre que les productions asiatiques).
    if (err.response?.status === 404) {
      log.ok('KissKH', tmdbId, 'absent du catalogue KissKH');
      return [];
    }
    log.fail('KissKH', tmdbId, err);
    return [];
  }
}

module.exports = { name: 'KissKH', getStreams };
