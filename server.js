const { serveHTTP } = require('stremio-addon-sdk');
const addonInterface = require('./src/addon');
const config = require('./src/config');

serveHTTP(addonInterface, { port: config.PORT });

console.log(`Movix addon (perso) demarre sur le port ${config.PORT}`);
console.log(`Manifest: http://localhost:${config.PORT}/manifest.json`);
