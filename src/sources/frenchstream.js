const { mainApi } = require('../movixClient');
const tmdbClient = require('../tmdb');
const log = require('../log');

// FrenchStream ("Omega" cote site), monte sur /api/imdb/:type/:id (Mainapi/routes/tmdb.js:553).
// ATTENTION: cette route attend un id IMDB (ttXXXXXXX), pas un id TMDB -- le frontend resout
// d'abord l'imdb_id via TMDB (WatchMovie.tsx:759-762). Passer un id TMDB renvoie
// systematiquement {message:'Contenu non disponible'}.
//
// Film: {iframe_src, player_links}. Serie: series[].seasons[].episodes[].versions.<lang>.players[].

function collectMoviePlayers(data) {
  const results = (data.player_links || [])
    .filter((p) => p.link || p.url)
    .map((p) => ({
      url: p.link || p.url,
      player: p.player || p.name,
      quality: p.is_hd ? '1080p' : undefined,
      sourceName: 'FrenchStream',
    }));
  if (data.iframe_src) results.push({ url: data.iframe_src, sourceName: 'FrenchStream' });
  return results;
}

function collectEpisodePlayers(data, season, episode) {
  const seriesList = Array.isArray(data.series) ? data.series : [];
  const results = [];

  for (const serie of seriesList) {
    const seasons = serie.seasons || [];
    const seasonData =
      seasons.find((s) => Number(s.season_number ?? s.number ?? s.season) === Number(season)) ||
      seasons[Number(season) - 1];
    if (!seasonData) continue;

    const episodes = seasonData.episodes || [];
    const ep =
      episodes.find((e) => Number(e.episode_number ?? e.number ?? e.episode) === Number(episode)) ||
      episodes[Number(episode) - 1];
    if (!ep?.versions) continue;

    for (const [lang, versionData] of Object.entries(ep.versions)) {
      for (const p of versionData?.players || []) {
        if (p.link || p.url) {
          results.push({ url: p.link || p.url, player: p.name || p.player, lang, sourceName: 'FrenchStream' });
        }
      }
    }
  }
  return results;
}

async function getStreams({ tmdbId, type, season, episode }) {
  try {
    const imdbId = await tmdbClient.getImdbId(type, tmdbId);
    if (!imdbId) {
      log.ok('FrenchStream', tmdbId, 'pas d\'id IMDB sur TMDB -- source ignoree');
      return [];
    }

    const mediaType = type === 'series' ? 'tv' : 'movie';
    const { data } = await mainApi.get(`/api/imdb/${mediaType}/${imdbId}`);

    if (data.message === 'Contenu non disponible') {
      log.ok('FrenchStream', tmdbId, `indisponible sur FrenchStream (imdb=${imdbId})`);
      return [];
    }

    const results = mediaType === 'movie' ? collectMoviePlayers(data) : collectEpisodePlayers(data, season, episode);
    log.ok('FrenchStream', tmdbId, `${results.length} lien(s) (imdb=${imdbId}, cles: ${Object.keys(data).join(',')})`);
    return results;
  } catch (err) {
    log.fail('FrenchStream', tmdbId, err);
    return [];
  }
}

module.exports = { name: 'FrenchStream', getStreams };
