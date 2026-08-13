module.exports = {
  id: 'personal.movix.addon',
  version: '1.0.0',
  name: 'Movix (perso)',
  description: 'Catalogue et flux Movix agreges pour usage personnel -- non destine a etre partage ou publie.',
  logo: 'https://movix.cash/favicon.ico',
  resources: ['catalog', 'meta', 'stream', 'subtitles'],
  types: ['movie', 'series'],
  idPrefixes: ['tmdb', 'tt'],
  catalogs: [
    { type: 'movie', id: 'movix-trending', name: 'Movix - Tendances', extra: [{ name: 'skip' }] },
    { type: 'movie', id: 'movix-popular', name: 'Movix - Films populaires', extra: [{ name: 'search' }, { name: 'skip' }] },
    { type: 'series', id: 'movix-trending', name: 'Movix - Tendances', extra: [{ name: 'skip' }] },
    { type: 'series', id: 'movix-popular', name: 'Movix - Series populaires', extra: [{ name: 'search' }, { name: 'skip' }] },
  ],
  behaviorHints: {
    configurable: false,
    p2pNotSupported: true,
  },
};
