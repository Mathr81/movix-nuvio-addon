const fs = require('fs');
const path = require('path');
const config = require('../core/config');
const paths = require('../core/paths');
const { libKey, watchedKey, progressKey } = require('./model');

/**
 * Instantane persiste d'un cycle a l'autre.
 *
 * Methode: comparaison a un instantane du tour precedent, pas d'horodatage. Movix
 * n'estampille pas ses cles `progress_*`, donc "qui est le plus recent" est indecidable
 * par les donnees; en revanche "qu'est-ce qui a change depuis le dernier tour" est exact
 * des deux cotes. Un premier tour sans instantane traite tout comme nouveau, ce qui
 * produit exactement l'union voulue.
 */
const STATE_FILE = config.HUB_STATE_FILE || paths.inData('hub-state.json');

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
}

function clearState() {
  try {
    fs.unlinkSync(STATE_FILE);
    return true;
  } catch {
    // Absent: rien a faire, le prochain cycle repartira d'une union complete.
    return false;
  }
}

/**
 * Empreinte comparable d'un modele: c'est elle qui est persistee entre deux tours.
 *
 * `additions` / `removals` projettent ce que le cycle vient d'ECRIRE dans la source.
 * Sans cette projection, l'instantane refleterait l'etat d'AVANT nos propres ecritures,
 * et le tour suivant les relirait comme des nouveautes venues de la source -- ce qui
 * relance une propagation inutile et, pire, annule une vraie suppression faite entre
 * temps (notre echo compterait comme un ajout concurrent).
 */
function snapshot(model, additions, removals, readable = ['library', 'watched', 'progress']) {
  const library = new Set(model.library.keys());
  const watched = new Set(model.watched.keys());
  // La position arrondie a la seconde suffit a detecter une lecture; la garder brute
  // ferait diverger l'empreinte a chaque tour pour cause d'arrondi flottant.
  const progress = Object.fromEntries([...model.progress].map(([k, v]) => [k, Math.round(v.position)]));

  if (additions) {
    // On ne projette que ce que la source sait relire. Projeter une categorie ecrite
    // mais jamais relue (les positions cote Simkl, envoyees en scrobble et absentes de
    // /sync/all-items) la ferait passer pour disparue au tour suivant -- et le hub
    // propagerait cette fausse disparition en suppression chez les deux autres.
    if (readable.includes('library')) for (const e of additions.library) library.add(libKey(e.type, e.id));
    if (readable.includes('watched')) {
      for (const e of additions.watched) watched.add(watchedKey(e.type, e.id, e.season, e.episode));
    }
    if (readable.includes('progress')) {
      for (const e of additions.progress) progress[progressKey(e.type, e.id, e.season, e.episode)] = Math.round(e.position);
    }
  }
  if (removals) {
    for (const key of removals.library) library.delete(key);
    for (const key of removals.watched) watched.delete(key);
    for (const key of removals.progress) delete progress[key];
  }

  return { library: [...library], watched: [...watched], progress };
}

module.exports = { STATE_FILE, loadState, saveState, clearState, snapshot };
