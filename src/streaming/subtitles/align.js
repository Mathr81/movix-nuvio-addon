/**
 * Calage d'une piste de sous-titres sur un flux, par correlation.
 *
 * Le principe tient en une phrase: **les sous-titres apparaissent quand quelqu'un parle**.
 * Deux signaux binaires -- "il y a du dialogue a l'ecran" (deduit des repliques) et "il y a
 * de la parole dans l'audio" (mesure sur le flux, cf. speech.js) -- decrivent donc la meme
 * chose. S'ils ne se superposent pas, c'est exactement du decalage, et la correlation
 * croisee dit de combien.
 *
 * Aucun texte n'intervient: une piste allemande calerait aussi bien qu'une francaise, ce
 * qui est heureux -- c'est le meme code qui sert quelle que soit la langue demandee.
 *
 * Deux inconnues, pas une seule:
 *  - le DECALAGE constant (logo de distributeur present dans un release et pas dans
 *    l'autre, montage different): une piste avancee de 8 s du debut a la fin;
 *  - la DERIVE (conversion PAL: un master a 23,976 im/s accelere a 25 pour la television
 *    europeenne): parfaitement calee sur la premiere replique, cinq minutes d'ecart sur la
 *    derniere. C'est celle-la que le reglage de delai d'un lecteur ne rattrape PAS, et
 *    c'est elle qui oblige a recaler toutes les dix minutes.
 *
 * D'ou la methode en deux temps (`solve`): une fenetre du DEBUT donne le decalage, ou la
 * derive n'a pas encore eu le temps de s'accumuler; les fenetres suivantes sont ensuite
 * cherchees LA OU CHAQUE RAPPORT D'IMAGES/SECONDE CONNU les predit. Celui qui tombe juste
 * partout gagne.
 *
 * L'ordre compte: une recherche large sur une fenetre de fin devrait balayer +/- 5 min
 * pour couvrir une derive PAL, et y trouverait surtout des sommets tires au sort.
 */

// Resolution du signal. 20 ms est bien en deca de ce qu'un spectateur percoit (~100 ms) et
// garde des tableaux courts: une fenetre d'une minute tient en 3000 cases.
const BIN_MS = 20;
const BIN = BIN_MS / 1000;

/**
 * Duree de l'impulsion posee au DEBUT de chaque prise de parole et de chaque replique.
 *
 * C'est le reglage qui a fait la difference sur des films reels. Correler les intervalles
 * ENTIERS revient a comparer des durees: or une replique ne dure pas ce que dure la phrase
 * -- elle reste affichee apres, elle en regroupe parfois deux, une traduction condense.
 * Les DEBUTS, eux, coincident: le sous-titre apparait quand l'acteur ouvre la bouche.
 *
 * Mesure sur trois films: en intervalles, un titre ne trouvait aucun accord et un autre
 * s'accordait a 1,6 s pres; en impulsions de debut, les deux trouvent le meme decalage a
 * moins d'une seconde pres, et le nombre de faux calages sur des paires de films sans
 * rapport tombe a zero. Plus court (0,3 s) et le sommet devient trop etroit pour tolerer
 * le jeu naturel entre parole et affichage; plus long (1 s) et les faux calages reviennent.
 */
const ONSET_SECONDS = 0.5;

/** Intervalles -> impulsions posees sur leurs debuts. */
function toOnsets(intervals, width = ONSET_SECONDS) {
  return intervals.map(([start]) => [start, start + width]);
}

/**
 * Rapports d'images/seconde qui produisent les derives observees en pratique.
 *
 * Ce ne sont pas des valeurs approchees a affiner: une conversion PAL multiplie EXACTEMENT
 * par 25 / (24000/1001). Chercher le calage sur cette liste plutot que sur une pente libre
 * enleve tout le bruit de mesure -- et interdit d'inventer une derive de 0,3 % qui
 * n'existe pas.
 */
const FILM = 24000 / 1001; // 23,976
const KNOWN_SCALES = [1, 25 / FILM, FILM / 25, 25 / 24, 24 / 25, 24 / FILM, FILM / 24];

/** Intervalles [debut, fin] -> tableau binaire de cases de 20 ms couvrant [from, to). */
function toBins(intervals, from, to) {
  const size = Math.max(0, Math.round((to - from) / BIN));
  const bins = new Uint8Array(size);
  for (const [start, end] of intervals) {
    if (end < from || start > to) continue;
    const a = Math.max(0, Math.floor((start - from) / BIN));
    const b = Math.min(size, Math.ceil((end - from) / BIN));
    for (let i = a; i < b; i += 1) bins[i] = 1;
  }
  return bins;
}

/** Sommes prefixes, pour obtenir moyenne et variance de n'importe quelle tranche en O(1). */
function prefixSums(bins) {
  const sums = new Int32Array(bins.length + 1);
  for (let i = 0; i < bins.length; i += 1) sums[i + 1] = sums[i] + bins[i];
  return sums;
}

/**
 * Sommet d'une parabole passant par les trois points autour du maximum.
 *
 * Sans cela la mesure serait quantifiee a 20 ms; l'interpolation ramene la precision bien
 * en dessous, pour trois multiplications.
 */
function refinePeak(at, before, after) {
  const denominator = before - 2 * at + after;
  if (denominator >= 0) return 0;
  const delta = (0.5 * (before - after)) / denominator;
  return Math.abs(delta) <= 1 ? delta : 0;
}

/**
 * Une "couche" de comparaison: un signal binaire cote audio, un cote sous-titre, prets a
 * etre correles. Les sommes prefixes rendent moyenne et variance de n'importe quelle
 * tranche calculables en temps constant.
 */
function layer(audioIntervals, cueIntervals, { t0, duration, min, max }) {
  const audio = toBins(audioIntervals, t0, t0 + duration);
  const subs = toBins(cueIntervals, t0 - max, t0 + duration - min);
  const n = audio.length;

  const ones = [];
  for (let i = 0; i < n; i += 1) if (audio[i]) ones.push(i);
  const mean = ones.length / n;
  // Une fenetre presque muette (plan silencieux, sequence musicale) ou presque entierement
  // parlee ne porte aucune information: sa correlation est plate quel que soit le decalage.
  if (mean < 0.02 || mean > 0.95) return null;

  return { subs, sums: prefixSums(subs), ones, n, mean, variance: mean - mean * mean };
}

/** Correlation de Pearson d'une couche au decalage d'indice k. */
function correlate(l, k) {
  if (k < 0 || k + l.n >= l.subs.length) return 0;
  const subMean = (l.sums[k + l.n] - l.sums[k]) / l.n;
  if (subMean <= 0.01 || subMean >= 0.99) return 0;
  let dot = 0;
  for (let i = 0; i < l.ones.length; i += 1) dot += l.subs[l.ones[i] + k];
  // Signal binaire: E[S²] = E[S], la variance se lit donc directement sur la moyenne.
  return (dot / l.n - l.mean * subMean) / Math.sqrt(l.variance * (subMean - subMean * subMean));
}

/**
 * Courbe de correlation d'une fenetre, sur TOUTE la plage de decalages exploree.
 *
 * On garde la courbe entiere plutot que son seul sommet, et c'est ce qui change tout: la
 * qualite d'un decalage ne se juge qu'en le comparant a ses rivaux. Une premiere version
 * remesurait chaque fenetre dans une bande etroite autour du decalage attendu -- ou, par
 * construction, il n'y a plus de rival a battre. Deux fenetres tombant d'accord sur un faux
 * decalage y paraissaient donc irreprochables, et l'emportaient sur quatre fenetres justes
 * mesurees au large. Une meme courbe, une meme reference: le probleme disparait.
 *
 * Le pas de balayage vaut plusieurs cases: un sommet fait plus d'une seconde de large, le
 * chercher a 20 ms pres serait payer douze mille evaluations pour retrouver le meme. La
 * precision est reprise ensuite autour du seul sommet retenu (`peakNear`).
 */
function scan(speech, cues, bounds, step = 3) {
  // Une seule couche, et c'est celle des DEBUTS (cf. ONSET_SECONDS). Moyenner en plus la
  // correlation des intervalles entiers a ete essaye: cela DILUE le signal au lieu de le
  // consolider -- un titre qui se calait proprement sur ses debuts ne trouvait plus rien,
  // et une paire de films sans rapport passait le seuil. La duree d'une replique ne dit
  // pas la duree de la phrase; seul son debut est une mesure.
  const layers = [layer(toOnsets(speech), toOnsets(cues), bounds)].filter(Boolean);
  if (layers.length === 0) return null;

  const n = layers[0].n;
  const lags = layers[0].subs.length - n;
  if (n < 50 || lags < 2) return null;

  const count = Math.floor(lags / step) + 1;
  const scores = new Float64Array(count);
  for (let j = 0; j < count; j += 1) {
    scores[j] = layers.reduce((sum, l) => sum + correlate(l, j * step), 0) / layers.length;
  }

  // Niveau de fond de la courbe. La marge d'un sommet se mesure par rapport a LUI, et non
  // par rapport au deuxieme sommet: un decalage juste peut n'etre que le deuxieme sommet
  // d'une fenetre difficile, sans cesser de se detacher franchement du bruit.
  const sorted = Float64Array.from(scores).sort();
  const baseline = sorted[Math.floor(sorted.length * 0.95)];

  return { scores, step, max: bounds.max, baseline, layers };
}

/** Decalage correspondant a l'indice j de la courbe. */
function offsetAt(curve, j) {
  return curve.max - j * curve.step * BIN;
}

/** Correlation exacte (sans sous-echantillonnage) au decalage d'indice k. */
function scoreAtLag(curve, k) {
  return curve.layers.reduce((sum, l) => sum + correlate(l, k), 0) / curve.layers.length;
}

/**
 * Sommet de la courbe, au voisinage d'un decalage attendu (ou le plus haut de tous).
 *
 * @returns {{offset:number, score:number, margin:number}|null}
 *   `margin` = de combien ce sommet depasse le fond de la courbe. C'est la mesure qui
 *   distingue un vrai calage d'un maximum tire au sort: une sequence musicale correle un
 *   peu avec a peu pres n'importe quoi, mais sans jamais se detacher.
 */
function peakNear(curve, target = null, tolerance = Infinity) {
  const { scores, step } = curve;
  let best = -1;
  for (let j = 0; j < scores.length; j += 1) {
    if (target !== null && Math.abs(offsetAt(curve, j) - target) > tolerance) continue;
    if (best === -1 || scores[j] > scores[best]) best = j;
  }
  if (best === -1 || scores[best] <= 0) return null;

  // Reprise a la case pres autour du sommet retenu, puis interpolation parabolique: la
  // precision perdue au balayage est rendue ici, pour quelques dizaines d'evaluations.
  const center = best * step;
  let fine = center;
  let fineScore = scores[best];
  for (let k = Math.max(0, center - step); k <= center + step; k += 1) {
    const value = scoreAtLag(curve, k);
    if (value > fineScore) {
      fineScore = value;
      fine = k;
    }
  }
  const delta = refinePeak(fineScore, scoreAtLag(curve, fine - 1), scoreAtLag(curve, fine + 1));

  return { offset: curve.max - (fine + delta) * BIN, score: fineScore, margin: fineScore - curve.baseline };
}

/** Qualite d'une mesure: une correlation franche ET nettement detachee du fond. */
function quality(m, { minScore, minMargin }) {
  return !!m && m.score >= minScore && m.margin >= minMargin;
}

/**
 * Repliques ramenees a la cadence du flux.
 *
 * C'est ce qui permet de chercher un simple DECALAGE ensuite. Sans cette compensation, une
 * piste PAL derive de 4 % a l'interieur meme d'une fenetre: le sommet de correlation s'etale
 * sur cette largeur, sa position devient imprecise, et deux rapports voisins deviennent
 * indiscernables. Compensee, chaque fenetre retrouve un sommet franc -- et un mauvais
 * rapport se trahit au lieu de passer inapercu.
 */
function rescale(cues, scale) {
  return scale === 1 ? cues : cues.map(([start, end]) => [start * scale, end * scale]);
}

/** Decalage moyen pondere par la qualite des mesures, et dispersion autour de lui. */
function consolidate(measures) {
  const weights = measures.map((m) => Math.max(m.margin, 0.01));
  const total = weights.reduce((sum, x) => sum + x, 0);
  const offset = measures.reduce((sum, m, i) => sum + weights[i] * m.offset, 0) / total;
  const rms = Math.sqrt(measures.reduce((sum, m) => sum + (m.offset - offset) ** 2, 0) / measures.length);
  return { offset, rms };
}

/** Ce que vaut une mesure dans le total d'un candidat: correlation ET detachement. */
function weightOf(m) {
  return Math.min(1, m.score / 0.5) * Math.min(1, m.margin / 0.12);
}

/**
 * Resout le calage: `t_flux = scale · t_soustitre + offset`.
 *
 * Chaque rapport d'images/seconde connu est essaye a fond: repliques ramenees a sa cadence,
 * puis UNE courbe de correlation complete par fenetre. L'ancre est le sommet de la premiere
 * fenetre exploitable -- prise au debut du film a dessein, la ou la derive n'a pas encore eu
 * le temps de s'accumuler. Les autres fenetres sont ensuite relues LA OU CE RAPPORT LES
 * PREDIT, dans la meme courbe, donc jugees a la meme aune.
 *
 * Gagne le rapport qui explique le plus de fenetres, avec les sommets les plus detaches et
 * la dispersion la plus faible. Que quatre fenetres prises a vingt minutes d'intervalle
 * tombent d'accord a deux secondes pres sur une recherche de +/- 120 s n'arrive pas par
 * hasard: c'est cet accord, bien plus que la hauteur d'un sommet, qui demontre un calage.
 *
 * @param {Array<[number,number]>} speech intervalles de parole (temps du flux)
 * @param {Array<[number,number]>} cues   intervalles des repliques (temps du sous-titre)
 * @param {Array<{t0:number,duration:number}>} windows fenetres, dans l'ordre chronologique
 * @returns {{scale:number, offset:number, confidence:number, ...}|null}
 */
function solve(speech, cues, windows, options = {}) {
  const {
    maxShift = 120,
    // Marge du premier passage: elle absorbe l'erreur de l'ancre, mais laisse passer
    // ensemble les rapports voisins (25/24 et 25/23,976 ne different que de 0,1 %).
    coarseTolerance = 10,
    // Second passage. C'est LUI qui departage ces rapports voisins: sur deux heures, 0,1 %
    // font sept secondes. Assez large, en revanche, pour tolerer la dispersion d'une mesure
    // sur de l'audio de film, qui est de l'ordre de la seconde et demie.
    fineTolerance = 4,
    minScore = 0.22,
    minMargin = 0.04,
  } = options;
  const gate = { minScore, minMargin };
  if (windows.length === 0 || cues.length < 20) return null;

  let winner = null;

  for (const scale of KNOWN_SCALES) {
    const scaled = rescale(cues, scale);
    const curves = windows.map((w) => scan(speech, scaled, { ...w, min: -maxShift, max: maxShift }));

    // Ancre: le sommet de la premiere fenetre exploitable.
    let anchor = null;
    for (const curve of curves) {
      if (!curve) continue;
      const peak = peakNear(curve);
      if (quality(peak, gate)) {
        anchor = peak;
        break;
      }
    }
    if (!anchor) continue;

    const collect = (offset, tolerance) =>
      curves
        .map((curve, i) => {
          if (!curve) return null;
          const peak = peakNear(curve, offset, tolerance);
          return quality(peak, gate) ? { time: windows[i].t0 + windows[i].duration / 2, ...peak } : null;
        })
        .filter(Boolean);

    const coarse = collect(anchor.offset, coarseTolerance);
    if (coarse.length === 0) continue;
    const fine = collect(consolidate(coarse).offset, fineTolerance);
    // Le passage fin peut tout perdre si l'ancre etait mediocre: on ne jette pas les mesures
    // larges pour autant, elles restent la meilleure description disponible.
    const measures = fine.length >= Math.min(2, windows.length) ? fine : coarse;
    const { offset, rms } = consolidate(measures);

    // Somme, et non moyenne: un rapport qui explique QUATRE fenetres vaut mieux qu'un
    // rapport qui en explique une tres bien et perd les autres.
    const strength = measures.reduce((sum, m) => sum + weightOf(m), 0);
    // Une mesure isolee a une dispersion INDETERMINEE, pas nulle. Lui compter rms = 0
    // donnait un avantage decisif aux rapports qui n'expliquent qu'une seule fenetre --
    // exactement les mauvais.
    const dispersion = measures.length >= 2 ? rms : 2;
    const total = strength / (1 + dispersion / 2);

    if (!winner || total > winner.total) winner = { scale, offset, rms, measures, total };
  }

  if (!winner) return null;
  const { scale, offset, rms, measures } = winner;

  // Confiance -- calibree sur de l'audio de FILM, pas sur un signal de laboratoire. Sur un
  // long-metrage reel (musique continue, effets, ambiances), une correlation juste sort
  // autour de 0,3-0,5, la ou un signal synthetique donne 0,8. Rapporter la mesure brute
  // reviendrait a refuser precisement les cas pour lesquels tout ceci existe.
  const strength = measures.reduce((sum, m) => sum + weightOf(m), 0) / measures.length;
  // Exposant > 1: perdre la moitie des fenetres ne coute pas la moitie de la confiance,
  // mais bien davantage. Deux fenetres d'accord ne demontrent pas grand-chose -- il y a
  // deja des paires de faux sommets qui s'accordent par hasard; cinq, non.
  const coverage = (measures.length / windows.length) ** 1.5;
  const tightness = 1 / (1 + rms / 1.5);

  // Etendue REELLEMENT couverte par les fenetres retenues. Un modele valide sur les vingt
  // premieres minutes et nulle part ailleurs n'est pas un modele du film: c'est la signature
  // d'un montage different (coupure publicitaire, version longue), que rien d'affine ne peut
  // decrire. Le calage doit alors etre refuse, pas applique a moitie.
  const times = measures.map((m) => m.time);
  const spanTotal = windows[windows.length - 1].t0 - windows[0].t0;
  const reach = spanTotal > 0 ? (Math.max(...times) - Math.min(...times)) / spanTotal : 1;

  // `reach` eleve a une puissance > 1 pour la meme raison que `coverage`: un modele valide
  // sur les deux premiers tiers seulement n'est pas "un peu moins bon", il est faux la ou il
  // n'a pas ete verifie -- et c'est precisement la signature d'un montage different.
  const confidence = strength * coverage * reach ** 1.5 * (measures.length === 1 ? 0.25 : tightness);

  return {
    scale,
    offset,
    confidence,
    rms,
    reach: Number(reach.toFixed(2)),
    windows: measures.length,
    windowsTotal: windows.length,
    measures: measures.map((m) => ({
      minute: Math.round(m.time / 60),
      offset: Number(m.offset.toFixed(2)),
      score: Number(m.score.toFixed(2)),
      marge: Number(m.margin.toFixed(3)),
    })),
  };
}

module.exports = { BIN_MS, ONSET_SECONDS, KNOWN_SCALES, toBins, toOnsets, scan, peakNear, solve };
