const dotenv = require('dotenv');

/**
 * Formulaire de la page Config, tire de `.env.example`: ses blocs `# --- Titre ---` font
 * les categories, le commentaire juste au-dessus d'une variable sa description, et sa
 * valeur d'exemple le defaut affiche. Une variable commentee (`# CLE=valeur`) est un
 * reglage facultatif dont l'exemple vaut defaut.
 */
const SECTION = /^#\s*---\s*(.+?)\s*-{3,}\s*$/;
const VARIABLE = /^(#\s*)?([A-Z][A-Z0-9_]*)=(.*)$/;
const SECRET = /(KEY|SECRET|PASSWORD|TOKEN|JWT)(_|$)/;

function kindOf(key, example) {
  if (SECRET.test(key)) return 'secret';
  if (/^(true|false)$/i.test(example)) return 'bool';
  if (/^\d+$/.test(example)) return 'number';
  return 'text';
}

function parseSchema(example) {
  const sections = [{ title: 'Général', intro: '', vars: [] }];
  const seen = new Set();
  let doc = [];

  for (const raw of example.split('\n')) {
    const line = raw.trimEnd();
    const section = SECTION.exec(line);
    if (section) {
      sections.push({ title: section[1], intro: '', vars: [] });
      doc = [];
      continue;
    }
    const current = sections[sections.length - 1];
    const variable = VARIABLE.exec(line);
    if (variable) {
      const [, commented, key, value] = variable;
      // Une meme cle reprise plus bas (second exemple commente): la premiere fait foi.
      if (!seen.has(key)) {
        seen.add(key);
        current.vars.push({ key, doc: doc.join('\n'), example: value, optional: !!commented, kind: kindOf(key, value) });
      }
      doc = [];
    } else if (line.startsWith('#')) {
      doc.push(line.replace(/^#\s?/, ''));
    } else if (!line.trim()) {
      // Commentaire suivi d'une ligne vide, avant toute variable: c'est l'intro du bloc.
      if (doc.length && current.vars.length === 0) current.intro += `${current.intro ? '\n' : ''}${doc.join('\n')}`;
      doc = [];
    }
  }
  return sections.filter((s) => s.vars.length > 0);
}

// dotenv coupe une valeur nue a ` #` et rogne les espaces: on cite ce qui en souffrirait.
function quote(value) {
  if (!/[#'"`]|^\s|\s$/.test(value)) return value;
  return value.includes("'") ? `"${value.replace(/"/g, '\\"')}"` : `'${value}'`;
}

/**
 * Applique `{CLE: valeur | null}` au texte du .env, ligne par ligne: le reste du fichier
 * (commentaires, ordre) ne bouge pas. `null` commente la ligne -- la variable reprend son
 * defaut, et l'ancienne valeur reste lisible dans le fichier.
 */
function applyChanges(text, changes) {
  const lines = text.split('\n');
  const added = [];
  for (const [key, value] of Object.entries(changes || {})) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw Object.assign(new Error(`cle invalide: ${key}`), { status: 400 });
    if (value !== null && (typeof value !== 'string' || /[\r\n]/.test(value))) {
      throw Object.assign(new Error(`valeur invalide pour ${key}`), { status: 400 });
    }
    const active = lines.findIndex((l) => l.startsWith(`${key}=`));
    if (value === null) {
      if (active >= 0) lines[active] = `# ${lines[active]}`;
      continue;
    }
    const line = `${key}=${quote(value)}`;
    const commented = active >= 0 ? -1 : lines.findIndex((l) => new RegExp(`^#\\s*${key}=`).test(l));
    if (active >= 0) lines[active] = line;
    else if (commented >= 0) lines[commented] = line;
    else added.push(line);
  }
  if (added.length) {
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    lines.push(...added, '');
  }
  return lines.join('\n');
}

const parseValues = (text) => dotenv.parse(text);

module.exports = { parseSchema, applyChanges, parseValues, kindOf };
