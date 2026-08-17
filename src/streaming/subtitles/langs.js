/**
 * Libelles vdrk -> codes ISO 639-2/B.
 *
 * vdrk nomme ses pistes en anglais ("French", "Portuguese (BR)") et suffixe les variantes
 * d'un numero ("French2", "French3"). Le reste de l'addon raisonne en codes ISO 639-2/B,
 * qui sont ceux de SUBTITLE_LANGS et d'OpenSubtitles -- et ceux que Nuvio reconnait.
 *
 * Attention aux codes 639-2/B: c'est la forme "bibliographique", donc `fre` et non `fra`,
 * `ger` et non `deu`, `dut`, `gre`, `rum`, `per`, `cze`, `chi`. Utiliser la forme
 * terminologique ferait afficher "inconnu" par Nuvio, qui normalise ce champ.
 */
const BY_LABEL = {
  arabic: 'ara',
  bulgarian: 'bul',
  chinese: 'chi',
  croatian: 'hrv',
  czech: 'cze',
  danish: 'dan',
  dutch: 'dut',
  english: 'eng',
  estonian: 'est',
  finnish: 'fin',
  french: 'fre',
  german: 'ger',
  greek: 'gre',
  hebrew: 'heb',
  hindi: 'hin',
  hungarian: 'hun',
  indonesian: 'ind',
  italian: 'ita',
  japanese: 'jpn',
  korean: 'kor',
  latvian: 'lav',
  lithuanian: 'lit',
  macedonian: 'mac',
  malay: 'may',
  norwegian: 'nor',
  persian: 'per',
  polish: 'pol',
  portuguese: 'por',
  // Le bresilien a son propre code cote OpenSubtitles, et les deux traductions different
  // assez pour qu'un francophone... enfin, pour qu'un lusophone le remarque.
  'portuguese (br)': 'pob',
  romanian: 'rum',
  russian: 'rus',
  serbian: 'srp',
  slovak: 'slo',
  slovenian: 'slv',
  spanish: 'spa',
  swedish: 'swe',
  thai: 'tha',
  turkish: 'tur',
  ukrainian: 'ukr',
  vietnamese: 'vie',
};

/**
 * "French3" -> { code: 'fre', variant: 3 }. La variante sert a ordonner: la piste sans
 * numero est celle que vdrk presente en premier, donc la plus sure par defaut.
 */
function parseLabel(label) {
  const raw = String(label || '').trim();
  const match = raw.match(/^(.*?)(\d+)?$/);
  const name = (match?.[1] || raw).trim().toLowerCase();
  const variant = Number(match?.[2]) || 1;
  const code = BY_LABEL[name] || null;
  return { code, variant, name };
}

module.exports = { parseLabel, BY_LABEL };
