const simklLibrary = require('../../integrations/simklLibrary');

/**
 * Simkl vu par le hub. Toute la mecanique (activites, deltas `date_from`, anime, cache
 * persistant) vit dans `integrations/simklLibrary.js`; ce lecteur n'en expose que le
 * resultat, sous deux formes:
 *
 *   confirmed  ce qu'une vraie lecture de Simkl a montre. C'est la seule base sur laquelle
 *              on deduit des ajouts ou des RETRAITS venus de Simkl: un titre qu'on vient
 *              d'y ecrire mais que Simkl n'a pas encore rendu ne doit jamais passer pour
 *              "supprime cote Simkl" (c'etait la boucle ajout/retrait de `94245`).
 *   known      ce que Simkl possede ou possedera, pour ne rien lui renvoyer deux fois.
 *
 * `null` quand Simkl n'est pas lisible ce tour-ci (non autorise, en pause, en panne): le
 * hub le met alors de cote au lieu de croire sa bibliotheque videe.
 */
async function readSimkl() {
  return simklLibrary.read();
}

module.exports = { readSimkl };
