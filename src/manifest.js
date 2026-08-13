const config = require('./config');
const trakt = require('./traktCloud');
const { manifestCatalogs } = require('./catalogs');

const personalEnabled = !!(config.MOVIX_JWT && config.MOVIX_USER_ID);
// Etat lu au demarrage: apres un `npm run trakt:auth`, redemarre l'addon pour que la
// rangee de recommandations apparaisse (Stremio/Nuvio relisent alors le manifest).
const traktEnabled = config.TRAKT_RECOMMENDATIONS && trakt.isAuthenticated();

module.exports = {
  id: 'personal.movix.addon',
  // Stremio/Nuvio mettent le manifest en cache: toute modification visible (nom, logo,
  // catalogues) doit s'accompagner d'un changement de version pour etre reprise.
  version: '1.6.0',
  name: 'Movix (perso)',
  description:
    'Catalogue, flux et sous-titres Movix agreges pour usage personnel -- non destine a etre partage ou publie.',
  logo: config.LOGO_URL,
  resources: ['catalog', 'meta', 'stream', 'subtitles'],
  types: ['movie', 'series'],
  idPrefixes: ['tmdb', 'tt'],
  catalogs: manifestCatalogs({ personalEnabled, traktEnabled }),
  behaviorHints: {
    configurable: false,
    p2pNotSupported: true,
  },
};
