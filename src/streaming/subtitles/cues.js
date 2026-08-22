/**
 * Lecture et reecriture des horodatages d'un WebVTT.
 *
 * `vtt.js` fait de la chirurgie sur le TEXTE (conversion SRT, retrait des publicites);
 * ici on raisonne sur les REPLIQUES: leurs bornes en secondes, et l'application d'une
 * correction de calage. Deux besoins distincts, deux modules -- melanger les deux
 * donnerait un fichier ou une regex de nettoyage cotoie de l'arithmetique de temps.
 */

// Une ligne d'horodatage WebVTT: "00:01:23.456 --> 00:01:25.900 line:90% align:center".
// Les reglages qui suivent la seconde borne sont conserves tels quels: ils portent le
// placement a l'ecran, qu'un recalage ne doit pas toucher.
const TIMING_LINE = /^([\d:.,]+)\s*-->\s*([\d:.,]+)(.*)$/;

/** "00:01:23.456" ou "01:23.456" -> secondes. Accepte la virgule (SRT mal converti). */
function parseTimestamp(text) {
  const parts = String(text).trim().replace(',', '.').split(':');
  if (parts.length === 0 || parts.length > 3) return null;

  let seconds = 0;
  for (const part of parts) {
    const value = Number(part);
    if (!Number.isFinite(value)) return null;
    seconds = seconds * 60 + value;
  }
  return seconds;
}

/** Secondes -> "HH:MM:SS.mmm". WebVTT tolere "MM:SS.mmm", mais la forme longue est lue partout. */
function formatTimestamp(seconds) {
  const clamped = Math.max(0, seconds);
  const ms = Math.round(clamped * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const rest = ms % 1000;
  const pad = (n, size = 2) => String(n).padStart(size, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(rest, 3)}`;
}

/**
 * Bornes des repliques, en secondes, dans l'ordre du fichier.
 *
 * Seules les bornes comptent: c'est le SIGNAL de presence de dialogue qu'on va correler a
 * l'audio du flux, pas le texte. Un sous-titre allemand cale aussi bien qu'un francais,
 * puisque les deux parlent quand les acteurs parlent.
 */
function parseCues(vtt) {
  const cues = [];
  for (const raw of String(vtt).replace(/\r\n/g, '\n').split('\n')) {
    const match = TIMING_LINE.exec(raw.trim());
    if (!match) continue;
    const start = parseTimestamp(match[1]);
    const end = parseTimestamp(match[2]);
    if (start === null || end === null || end < start) continue;
    cues.push({ start, end });
  }
  return cues;
}

/** Duree couverte par la piste (derniere borne). Sert a comparer a celle du flux. */
function span(cues) {
  return cues.length === 0 ? 0 : cues[cues.length - 1].end;
}

/**
 * Applique une correction affine `t' = scale * t + offset` a tous les horodatages.
 *
 * `scale` traite la derive (un fichier PAL a 25 im/s cale sur un flux a 23,976 avance de
 * 4 % du debut a la fin: parfait sur la premiere replique, trente secondes d'ecart sur la
 * derniere). `offset` traite le decalage constant (logo de distributeur, montage).
 *
 * Une replique qui remonterait avant zero est ramenee a zero plutot que supprimee: elle
 * appartient au generique, et la faire disparaitre serait une perte silencieuse.
 */
function retime(vtt, { scale = 1, offset = 0 } = {}) {
  if (scale === 1 && offset === 0) return String(vtt);

  return String(vtt)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      const match = TIMING_LINE.exec(line.trim());
      if (!match) return line;
      const start = parseTimestamp(match[1]);
      const end = parseTimestamp(match[2]);
      if (start === null || end === null) return line;
      return `${formatTimestamp(start * scale + offset)} --> ${formatTimestamp(end * scale + offset)}${match[3]}`;
    })
    .join('\n');
}

module.exports = { parseCues, retime, span, parseTimestamp, formatTimestamp };
