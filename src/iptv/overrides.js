const fs = require('fs');
const paths = require('../core/paths');

/**
 * Retouches manuelles de la grille, faites depuis la WebUI.
 *
 * La fusion automatique a raison la plupart du temps, pas toujours, et ce qu'on veut voir
 * dans sa playlist est affaire de gout. Ces retouches vivent a part de la grille: celle-ci
 * est reconstruite toutes les heures a partir des sources, et doit pouvoir l'etre sans
 * rien oublier de ce qui a ete regle a la main.
 *
 *   hiddenChannels / hiddenGroups   retires de la playlist (toujours jouables par leur URL)
 *   preferred   { cle: sid }        flux force en tete d'une chaine
 *   merges      { cle: cible }      fusion manuelle de deux chaines
 *   splits      [cle]               ecriture que la fusion automatique ne doit plus absorber
 *   groups      { cle: theme }      changement de categorie
 *   names       { cle: nom }        renommage
 */

const FILE = () => paths.inData('iptv-overrides.json');

const EMPTY = () => ({ hiddenChannels: [], hiddenGroups: [], preferred: {}, merges: {}, splits: [], groups: {}, names: {} });

let state = EMPTY();
let version = 0;
let loaded = false;

function load() {
  if (loaded) return;
  loaded = true;
  try {
    state = { ...EMPTY(), ...JSON.parse(fs.readFileSync(FILE(), 'utf8')) };
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[iptv] retouches illisibles, ignorees: ${err.message}`);
  }
}

function save() {
  try {
    fs.mkdirSync(paths.DATA_DIR, { recursive: true });
    fs.writeFileSync(`${FILE()}.tmp`, JSON.stringify(state, null, 2));
    fs.renameSync(`${FILE()}.tmp`, FILE());
  } catch (err) {
    console.warn(`[iptv] retouches non sauvegardees: ${err.message}`);
  }
}

function get() {
  load();
  return state;
}

const toggle = (list, value, on) => (on ? [...new Set([...list, value])] : list.filter((item) => item !== value));
const assign = (map, key, value) => {
  const next = { ...map };
  if (value === null || value === undefined || value === '') delete next[key];
  else next[key] = value;
  return next;
};

/**
 * Applique une retouche. Rend `true` si la FUSION est touchee: la grille doit alors etre
 * refondue, les autres retouches ne changeant que sa presentation.
 */
function apply(action, payload = {}) {
  load();
  const { key, group, sid, into, name, hidden } = payload;
  let remerge = false;

  switch (action) {
    case 'hideChannel':
      state.hiddenChannels = toggle(state.hiddenChannels, key, hidden !== false);
      break;
    case 'hideGroup':
      state.hiddenGroups = toggle(state.hiddenGroups, group, hidden !== false);
      break;
    case 'prefer':
      state.preferred = assign(state.preferred, key, sid);
      break;
    case 'group':
      state.groups = assign(state.groups, key, group);
      break;
    case 'rename':
      state.names = assign(state.names, key, name);
      break;
    case 'merge':
      if (!key || !into || key === into) throw new Error('fusion: deux chaines distinctes attendues');
      state.merges = assign(state.merges, key, into);
      state.splits = toggle(state.splits, key, false);
      remerge = true;
      break;
    case 'split':
      state.merges = assign(state.merges, key, null);
      state.splits = toggle(state.splits, key, true);
      remerge = true;
      break;
    case 'unsplit':
      state.splits = toggle(state.splits, key, false);
      remerge = true;
      break;
    case 'reset':
      state = EMPTY();
      remerge = true;
      break;
    default:
      throw new Error(`retouche inconnue: ${action}`);
  }

  version += 1;
  save();
  return remerge;
}

module.exports = { get, apply, version: () => version };
