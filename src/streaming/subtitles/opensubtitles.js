const axios = require('axios');
const config = require('../../core/config');
const tmdbClient = require('../../integrations/tmdb');

/**
 * OpenSubtitles -- fournisseur de repli.
 *
 * Conserve derriere vdrk parce qu'il reste le plus fourni sur les titres anciens ou
 * confidentiels, mais il coute plus cher a chaque etape: un detour par `/external_ids`
 * pour obtenir l'id IMDb (le seul qu'il indexe), une requete PAR LANGUE, puis un .gz
 * contenant du SRT dont l'encodage n'est pas annonce.
 */
const OS_BASE = 'https://rest.opensubtitles.org';
const HEADERS = { 'User-Agent': 'Movix/1.0' };

/**
 * Cherche les sous-titres d'un titre pour UNE langue.
 *
 * Une seule langue par requete, comme le fait le lecteur du site
 * (HLSPlayer.tsx:4537-4547): l'API ne documente pas de liste separee par virgules, et
 * `sublanguageid-fre,eng` se solde par un 400 -- donc par une absence totale de
 * sous-titres, sans que rien n'indique pourquoi.
 */
async function searchLang({ bareImdb, lang, type, season, episode }) {
  const path =
    type === 'series' && season !== undefined && episode !== undefined
      ? `/search/episode-${episode}/imdbid-${bareImdb}/season-${season}/sublanguageid-${lang}`
      : `/search/imdbid-${bareImdb}/sublanguageid-${lang}`;

  const { data } = await axios.get(`${OS_BASE}${path}`, { headers: HEADERS, timeout: 12000 });
  return Array.isArray(data) ? data : [];
}

async function search({ type, tmdbId, season, episode, langs }) {
  const imdbId = await tmdbClient.getImdbId(type, tmdbId);
  if (!imdbId) return [];

  // OpenSubtitles attend l'id IMDB sans le prefixe "tt".
  const bareImdb = imdbId.replace(/^tt/, '');
  const wanted = langs && langs.length > 0 ? langs : config.SUBTITLE_LANGS;

  // Une langue en echec ne doit pas emporter les autres.
  const settled = await Promise.allSettled(
    wanted.map((lang) => searchLang({ bareImdb, lang, type, season, episode })),
  );

  settled.forEach((result, index) => {
    if (result.status === 'rejected') {
      const status = result.reason?.response?.status;
      console.warn(
        `[subtitles] opensubtitles "${wanted[index]}" a echoue (imdb=${bareImdb}): ` +
          `status=${status ?? 'n/a'} ${result.reason?.message || ''}`,
      );
    }
  });

  const rows = settled.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));

  return rows
    .map((sub) => {
      // Memes champs de repli que le lecteur du site (HLSPlayer.tsx:4592): tous les
      // miroirs ne renseignent pas SubDownloadLink.
      const url = sub.SubDownloadLink || sub.SubDownloadLinkForBrowser || sub.DownloadLink || sub.Link;
      if (!sub.SubLanguageID || !url) return null;
      return {
        lang: sub.SubLanguageID,
        url,
        name: sub.SubFileName || sub.SubLanguageID,
        score: Number(sub.SubDownloadsCnt || 0),
      };
    })
    .filter(Boolean);
}

module.exports = { id: 'opensubtitles', name: 'OpenSubtitles', host: 'opensubtitles.org', search, headers: HEADERS };
