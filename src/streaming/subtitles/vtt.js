/**
 * Conversion et nettoyage des pistes de sous-titres.
 */

// Conversion alignee sur celle du lecteur du site (HLSPlayer.tsx:4610-4614).
function srtToVtt(srt) {
  const body = srt
    .replace(/\r\n/g, '\n')
    // Numeros de replique: WebVTT les tolere comme identifiants, mais certains lecteurs
    // les affichent a l'ecran. Le site les retire, on fait pareil.
    .replace(/^\s*\d+\s*$/gm, '')
    // Timestamps SRT (virgule) -> WebVTT (point).
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return `WEBVTT\n\n${body}`;
}

/**
 * Decode un Buffer de sous-titres. OpenSubtitles sert beaucoup de fichiers en latin-1/cp1252;
 * les lire en UTF-8 produit des caracteres de remplacement sur les accents francais.
 */
function decodeSubtitle(buffer) {
  const asUtf8 = buffer.toString('utf8');
  if (!asUtf8.includes('�')) return asUtf8;
  return buffer.toString('latin1');
}

/**
 * Publicites et signatures de traduction, a retirer.
 *
 * Ce n'est pas theorique: la piste francaise de Breaking Bad S01E01 chez vdrk s'ouvre sur
 * "Visit hoofoot.ru to watch all sports livestream and highlights for free", affiche
 * pendant six secondes avant la premiere replique. Les deux fournisseurs en ont.
 *
 * Le premier motif exige une forme de DOMAINE (`quelquechose.tld`) plutot qu'une simple
 * extension: chercher `.fr` ou `.tv` nu suffirait a emporter du dialogue legitime.
 */
const PROMO_PATTERNS = [
  /\b[a-z0-9][a-z0-9-]*\.(com|net|org|ru|fr|tv|site|app|io|co|me|info|biz|xyz)\b/i,
  /https?:\/\//i,
  /\b(opensubtitles|addic7ed|sub-?way|forom|hoofoot|tryray|subscene|yify|podnapisi)\b/i,
  /\b(subtitles?\s+(by|par)|sous-?titr(es?|age)\s*(par|:)|traduction\s*:|synchro(nisation)?\s*:|correction\s*:|relu\s+par)/i,
  /\b(downloaded\s+from|telecharge\s+depuis|t[ée]l[ée]charg[ée]\s+depuis|visitez|advertise\s+your\s+product)/i,
];

function isPromo(text) {
  const clean = text.replace(/<[^>]+>/g, ' ').trim();
  if (!clean) return true;
  return PROMO_PATTERNS.some((pattern) => pattern.test(clean));
}

/**
 * Retire les repliques publicitaires d'un WebVTT, en le laissant valide.
 *
 * On raisonne par BLOC (une replique = son horodatage + son texte) et non ligne a ligne:
 * supprimer la ligne de texte en laissant son horodatage produirait une replique vide que
 * certains lecteurs affichent comme un cartouche noir.
 */
function stripPromos(vtt) {
  const text = String(vtt).replace(/\r\n/g, '\n');
  const blocks = text.split(/\n\s*\n/);
  const kept = [];
  let removed = 0;

  for (const block of blocks) {
    const lines = block.split('\n').filter((line) => line.trim());
    if (lines.length === 0) continue;

    // En-tete WEBVTT, NOTE, STYLE: conserves tels quels.
    if (/^(WEBVTT|NOTE|STYLE|REGION)\b/i.test(lines[0])) {
      kept.push(block.trim());
      continue;
    }

    const timingIndex = lines.findIndex((line) => line.includes('-->'));
    if (timingIndex === -1) {
      kept.push(block.trim());
      continue;
    }

    const body = lines.slice(timingIndex + 1).join(' ');
    if (isPromo(body)) {
      removed += 1;
      continue;
    }
    kept.push(block.trim());
  }

  const out = kept.join('\n\n');
  const result = /^WEBVTT/.test(out) ? out : `WEBVTT\n\n${out}`;
  return { vtt: `${result}\n`, removed };
}

/** Texte brut (VTT ou SRT) -> WebVTT nettoye. */
function toCleanVtt(text) {
  const vtt = /^WEBVTT/.test(String(text).trim()) ? text : srtToVtt(text);
  return stripPromos(vtt);
}

module.exports = { srtToVtt, decodeSubtitle, stripPromos, toCleanVtt, isPromo };
