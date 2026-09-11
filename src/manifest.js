const config = require('./core/config');
const trakt = require('./integrations/traktCloud');
const { manifestCatalogs } = require('./catalog/catalogs');

const personalEnabled = !!(config.MOVIX_JWT && config.MOVIX_USER_ID);
// Etat lu au demarrage: apres un `npm run trakt:auth`, redemarre l'addon pour que la
// rangee de recommandations apparaisse (Stremio/Nuvio relisent alors le manifest).
const traktEnabled = config.TRAKT_RECOMMENDATIONS && trakt.isAuthenticated();

module.exports = {
  id: 'personal.movix.addon',
  // Stremio/Nuvio mettent le manifest en cache: toute modification visible (nom, logo,
  // catalogues) doit s'accompagner d'un changement de version pour etre reprise.
  version: '1.8.0',
  name: 'Movix (perso)',
  description:
    'Catalogue, flux, TV en direct et sous-titres (cales automatiquement sur le flux lu) Movix agreges pour usage personnel -- non destine a etre partage ou publie.',
  logo: config.LOGO_URL,
  resources: ['catalog', 'meta', 'stream', 'subtitles'],
  types: ['movie', 'series'],
  idPrefixes: ['tmdb', 'tt'],
  // Les catalogues de TV en direct ne sont PAS ici: ils viennent de Movix et changent en
  // cours de route (les rangees "rencontres" suivent les matchs du moment), alors que ce
  // manifest est fige au demarrage. server.js sert /manifest.json lui-meme et les y ajoute
  // a chaque requete, avec le type `tv` et le prefixe d'id correspondants.
  catalogs: manifestCatalogs({ personalEnabled, traktEnabled }),
  behaviorHints: {
    configurable: false,
    p2pNotSupported: true,
  },
};
