const util = require('util');

/**
 * Les dernieres lignes de console du process, pour la page "Logs" de la WebUI.
 *
 * La stdout reste la source de verite (PM2, `docker logs`): on ne fait que la DOUBLER en
 * memoire, dans un tampon circulaire. Rien n'est ecrit sur disque, et un redemarrage
 * repart d'un tampon vide -- l'historique long, c'est le travail de Docker.
 *
 * `install()` doit etre appele AVANT tout autre `require`: config.js parle des son
 * chargement, et ses avertissements sont precisement ceux qu'on veut voir.
 */
const LEVELS = { log: 'info', info: 'info', warn: 'warn', error: 'error', debug: 'debug' };

let capacity = 2000;
const lines = [];
const listeners = new Set();
let nextId = 1;
let installed = false;

// "[simkl] ..." ou "[subtitle:vdrk] ...": le prefixe entre crochets est le seul
// classement que les logs portent deja, on s'en sert comme filtre.
function tagOf(message) {
  const match = /^\[([^\]\s]{1,40})\]/.exec(message);
  return match ? match[1].split(':')[0].toLowerCase() : null;
}

function push(level, args) {
  const message = util.format(...args);
  const entry = { id: nextId++, at: Date.now(), level, tag: tagOf(message), message };
  lines.push(entry);
  if (lines.length > capacity) lines.splice(0, lines.length - capacity);
  for (const listener of listeners) {
    try {
      listener(entry);
    } catch {
      // Un abonne en panne (socket fermee) ne doit jamais casser un console.log.
    }
  }
}

function install() {
  if (installed) return;
  installed = true;
  for (const [method, level] of Object.entries(LEVELS)) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      original(...args);
      push(level, args);
    };
  }
}

/** Taille du tampon, connue seulement une fois la config chargee (donc apres install). */
function setCapacity(size) {
  if (size > 0) capacity = size;
  if (lines.length > capacity) lines.splice(0, lines.length - capacity);
}

/** Les lignes posterieures a `after` (un id), les plus anciennes d'abord. */
function since(after = 0) {
  return after > 0 ? lines.filter((entry) => entry.id > after) : lines.slice();
}

/** Abonnement aux nouvelles lignes; renvoie la fonction de desabonnement. */
function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

module.exports = { install, setCapacity, since, subscribe };
