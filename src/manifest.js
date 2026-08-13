const config = require('./config');
const { genreNames } = require('./genres');
const trakt = require('./traktCloud');

const syncEnabled = !!(config.MOVIX_JWT && config.MOVIX_USER_ID);
// Etat lu au demarrage: apres un `npm run trakt:auth`, redemarre l'addon pour que la
// rangee de recommandations apparaisse (Stremio/Nuvio relisent alors le manifest).
const traktEnabled = config.TRAKT_RECOMMENDATIONS && trakt.isAuthenticated();

function genreExtra(type) {
  return { name: 'genre', options: genreNames(type), isRequired: false };
}

function browseCatalogs(type) {
  return [
    { type, id: 'movix-trending', name: 'Movix · Tendances', extra: [{ name: 'skip' }] },
    {
      type,
      id: 'movix-popular',
      name: 'Movix · Populaires',
      extra: [{ name: 'search' }, { name: 'skip' }, genreExtra(type)],
    },
    { type, id: 'movix-toprated', name: 'Movix · Les mieux notés', extra: [{ name: 'skip' }, genreExtra(type)] },
    { type, id: 'movix-new', name: type === 'series' ? 'Movix · En cours de diffusion' : 'Movix · Au cinéma', extra: [{ name: 'skip' }] },
  ];
}

// Les catalogues personnels ne sont declares que si le sync est configure -- sinon ils
// apparaitraient vides dans Nuvio sans explication.
function personalCatalogs(type) {
  if (!syncEnabled) return [];
  return [
    { type, id: 'movix-continue', name: 'Movix · Reprendre', extra: [{ name: 'skip' }] },
    { type, id: 'movix-watchlist', name: 'Movix · Ma liste', extra: [{ name: 'skip' }] },
    { type, id: 'movix-favorites', name: 'Movix · Favoris', extra: [{ name: 'skip' }] },
  ];
}

// Recommandations calculees par Trakt a partir de l'historique importe. C'est la raison
// d'etre du pont Trakt: aucune donnee Movix ne permet de faire ca localement.
function traktCatalogs(type) {
  if (!traktEnabled) return [];
  return [{ type, id: 'movix-trakt-reco', name: 'Movix · Recommandé pour vous', extra: [{ name: 'skip' }] }];
}

module.exports = {
  id: 'personal.movix.addon',
  // Stremio/Nuvio mettent le manifest en cache: toute modification visible (nom, logo,
  // catalogues) doit s'accompagner d'un changement de version pour etre reprise.
  version: '1.4.0',
  name: 'Movix (perso)',
  description:
    'Catalogue, flux et sous-titres Movix agreges pour usage personnel -- non destine a etre partage ou publie.',
  logo: config.LOGO_URL,
  resources: ['catalog', 'meta', 'stream', 'subtitles'],
  types: ['movie', 'series'],
  idPrefixes: ['tmdb', 'tt'],
  catalogs: [
    ...personalCatalogs('movie'),
    ...personalCatalogs('series'),
    ...traktCatalogs('movie'),
    ...traktCatalogs('series'),
    ...browseCatalogs('movie'),
    ...browseCatalogs('series'),
  ],
  behaviorHints: {
    configurable: false,
    p2pNotSupported: true,
  },
};
