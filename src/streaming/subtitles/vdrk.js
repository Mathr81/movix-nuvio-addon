const axios = require('axios');
const config = require('../../core/config');
const { parseLabel } = require('./langs');

/**
 * vdrk -- l'index de sous-titres utilise par aether.bar.
 *
 * Trois avantages concrets sur OpenSubtitles, qui en font le fournisseur par defaut:
 *  - les pistes sont deja en **WebVTT**: plus de .gz a decompresser, plus de SRT a
 *    convertir, et surtout plus de devinette d'encodage (OpenSubtitles sert beaucoup de
 *    latin-1, qui casse les accents quand on le lit en UTF-8);
 *  - l'index est adresse par **id TMDB**, donc pas de detour par `/external_ids` pour
 *    obtenir un id IMDb -- un appel de moins, et un titre de moins a perdre quand TMDB
 *    n'a pas la correspondance;
 *  - pas de cle ni de quota.
 *
 *   GET /v1/movie/<tmdbId>
 *   GET /v1/tv/<tmdbId>/<saison>/<episode>
 *   -> [{ label: "French2", file: "https://cache.vdrk.site/.../French2.vtt" }, ...]
 *
 * Les libelles sont des noms de langue anglais, suffixes d'un numero pour les variantes.
 */
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
  Accept: '*/*',
  Origin: config.VDRK_ORIGIN,
  Referer: `${config.VDRK_ORIGIN}/`,
};

/** Les URLs contiennent des espaces ("Portuguese (BR).vtt"): a encoder avant l'appel. */
function safeUrl(url) {
  return /%[0-9a-f]{2}/i.test(url) ? url : encodeURI(url);
}

async function search({ type, tmdbId, season, episode }) {
  const path =
    type === 'series' && season !== undefined && episode !== undefined
      ? `/v1/tv/${tmdbId}/${season}/${episode}`
      : `/v1/movie/${tmdbId}`;

  const { data } = await axios.get(`${config.VDRK_BASE_URL}${path}`, { headers: HEADERS, timeout: 12000 });
  const rows = Array.isArray(data) ? data : [];

  return rows
    .map((row) => {
      const { code, variant } = parseLabel(row?.label);
      if (!code || !row?.file) return null;
      return {
        lang: code,
        url: safeUrl(row.file),
        name: row.label,
        // La piste sans numero est celle que vdrk presente en premier: on garde cet ordre
        // plutot que d'inventer un classement qu'aucune donnee ne soutient.
        score: -variant,
      };
    })
    .filter(Boolean);
}

module.exports = { id: 'vdrk', name: 'vdrk', host: 'vdrk.site', search, headers: HEADERS };
