const crypto = require('crypto');
const path = require('path');
const express = require('express');
const config = require('../core/config');
const logBuffer = require('./logBuffer');
const api = require('./api');

/**
 * WebUI, servie sous `/ui`: fichiers statiques (Preact + htm vendorises, aucune etape
 * de build) et API JSON sous `/ui/api`. Tout vit sous le meme prefixe pour qu'une seule
 * regle de reverse proxy suffise a la proteger.
 */
const PUBLIC_DIR = path.join(__dirname, 'public');

function sameSecret(given, expected) {
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

// HTTP Basic: le navigateur gere seul la saisie et la memorisation, y compris pour le
// flux SSE des logs (EventSource ne sait pas poser d'en-tete lui-meme). Le nom
// d'utilisateur est libre, seul le mot de passe compte.
function basicAuth(req, res, next) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const password = decoded.slice(decoded.indexOf(':') + 1);
    if (sameSecret(password, config.WEBUI_PASSWORD)) return next();
  }
  res.setHeader('WWW-Authenticate', 'Basic realm="Movix addon", charset="UTF-8"');
  res.status(401).type('text/plain').send('authentification requise');
}

function mount(app) {
  if (!config.WEBUI_ENABLED) return;
  logBuffer.setCapacity(config.WEBUI_LOG_LINES);

  const ui = express.Router();
  if (config.WEBUI_PASSWORD) ui.use(basicAuth);
  ui.use('/api', api.router());
  ui.use(express.static(PUBLIC_DIR, { index: 'index.html', maxAge: 0 }));

  // `/ui` sans barre finale: les chemins relatifs de index.html seraient resolus depuis
  // la racine du site.
  app.get('/ui', (req, res, next) => (req.originalUrl === '/ui' ? res.redirect(301, '/ui/') : next()));
  app.use('/ui', ui);
  // Rien d'autre n'occupe la racine: y arriver par erreur mene au tableau de bord.
  app.get('/', (_req, res) => res.redirect('/ui/'));

  if (!config.WEBUI_PASSWORD && config.PUBLIC_URL) {
    console.warn(
      '[webui] WEBUI_PASSWORD vide alors que PUBLIC_URL est renseignee: /ui est accessible sans ' +
        'authentification, sauf protection au reverse proxy.',
    );
  }
}

module.exports = { mount };
