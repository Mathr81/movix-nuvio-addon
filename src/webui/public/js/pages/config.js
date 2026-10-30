import { html, useState, useEffect, useMemo } from '../../vendor/preact-htm.js';
import { api, useResource, plural } from '../lib.js';
import { Card, Button, Skeleton, ErrorBox, Callout, Segmented, Icon, Empty, toast } from '../ui.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fold = (text) => String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// Le process quitte puis Docker/PM2 le relance: on attend qu'il reponde de nouveau.
async function waitForRestart() {
  await delay(1500);
  for (let i = 0; i < 40; i++) {
    try {
      await api('env');
      return true;
    } catch {
      await delay(1000);
    }
  }
  return false;
}

function Doc({ text }) {
  if (!text) return null;
  const [first, ...rest] = text.split('\n');
  if (!rest.length) return html`<p class="env-doc">${first}</p>`;
  return html`<details class="env-doc"><summary>${first}</summary><p>${rest.join('\n')}</p></details>`;
}

function SecretInput({ value, placeholder, onInput, disabled }) {
  const [shown, setShown] = useState(false);
  return html`<div class="env-secret">
    <input class="env-input" type=${shown ? 'text' : 'password'} autocomplete="off" value=${value} placeholder=${placeholder}
      disabled=${disabled} onInput=${onInput} />
    <${Button} size="sm" variant="ghost" icon=${shown ? 'eyeOff' : 'eye'} title=${shown ? 'Masquer' : 'Afficher'} onClick=${() => setShown(!shown)} />
  </div>`;
}

/** `value`: valeur courante (null = absente du .env, le defaut s'applique). */
function Field({ v, value, changed, onChange, disabled }) {
  const fallback = v.example ? `défaut : ${v.example}` : 'non défini';
  const onInput = (e) => onChange(e.target.value === '' ? null : e.target.value);
  let input;
  if (v.kind === 'bool') {
    input = html`<${Segmented} size="sm" value=${value === null ? '' : /^(1|true|yes|on)$/i.test(value) ? 'true' : 'false'}
      onChange=${(next) => !disabled && onChange(next === '' ? null : next)} options=${[
        { value: '', label: `défaut${v.example ? ` (${/^true$/i.test(v.example) ? 'oui' : 'non'})` : ''}` },
        { value: 'true', label: 'oui' },
        { value: 'false', label: 'non' },
      ]} />`;
  } else if (v.kind === 'secret') {
    input = html`<${SecretInput} value=${value ?? ''} placeholder=${fallback} onInput=${onInput} disabled=${disabled} />`;
  } else {
    input = html`<input class="env-input" type="text" inputmode=${v.kind === 'number' ? 'numeric' : undefined} spellcheck="false"
      value=${value ?? ''} placeholder=${fallback} disabled=${disabled} onInput=${onInput} />`;
  }
  return html`<div class=${`env-row${changed ? ' env-changed' : ''}`} id=${`env-${v.key}`}>
    <div class="env-label">
      <code>${v.key}</code>${changed && html`<span class="env-dot" title="modifié"></span>`}
      <${Doc} text=${v.doc} />
    </div>
    <div class="env-control">${input}</div>
  </div>`;
}

function Form({ data, edits, setEdits, query }) {
  const original = (key) => data.values[key] || null;
  const valueOf = (key) => (key in edits ? edits[key] : original(key));
  const change = (key, next) =>
    setEdits((all) => {
      const copy = { ...all };
      if ((next || null) === original(key)) delete copy[key];
      else copy[key] = next;
      return copy;
    });

  const q = fold(query);
  const sections = useMemo(
    () => data.schema
      .map((s) => ({ ...s, vars: q ? s.vars.filter((v) => fold(`${v.key} ${v.doc} ${s.title}`).includes(q)) : s.vars }))
      .filter((s) => s.vars.length > 0),
    [data, q],
  );
  if (!sections.length) return html`<${Empty} icon="search" title="Aucun réglage">Rien ne correspond à « ${query} ».</${Empty}>`;

  return html`
    ${!q && html`<div class="env-nav">
      ${sections.map((s) => html`<button class="chip-btn chip-sm" onClick=${() => document.getElementById(`env-s-${s.title}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
        ${s.title.replace(/\s*\(.*$/, '')}${s.vars.some((v) => v.key in edits) && html`<span class="env-dot"></span>`}
      </button>`)}
    </div>`}
    ${sections.map((s) => html`<div id=${`env-s-${s.title}`} class="env-section">
      <${Card} title=${s.title}>
        ${s.intro && html`<p class="env-intro">${s.intro}</p>`}
        ${s.vars.map((v) => html`<${Field} key=${v.key} v=${v} value=${valueOf(v.key)} changed=${v.key in edits}
          disabled=${!data.writable} onChange=${(next) => change(v.key, next)} />`)}
      </${Card}>
    </div>`)}`;
}

export function ConfigPage() {
  const { data, error, loading, reload } = useResource(() => api('env'), []);
  const [mode, setMode] = useState('form');
  const [edits, setEdits] = useState({});
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(null);
  useEffect(() => {
    if (!data) return;
    setText(data.content);
    setEdits({});
  }, [data]);

  if (error && !data) return html`<div class="page"><${ErrorBox} error=${error} onRetry=${reload} /></div>`;
  if (loading && !data) return html`<div class="page"><${Card} title=".env"><${Skeleton} lines=${8} /></${Card}></div>`;

  const pending = mode === 'form' ? Object.keys(edits).length : text !== data.content ? 1 : 0;
  const discard = () => (mode === 'form' ? setEdits({}) : setText(data.content));
  const switchMode = (next) => {
    if (pending) return toast('Enregistre ou annule les modifications avant de changer de vue.', { tone: 'warn' });
    setMode(next);
  };

  const run = async (kind) => {
    setBusy(kind);
    try {
      if (pending) await api('env', { method: 'PUT', body: mode === 'form' ? { changes: edits } : { content: text } });
      if (kind === 'restart') {
        await api('restart', { method: 'POST' });
        toast('Redémarrage en cours…', { tone: 'info' });
        const back = await waitForRestart();
        toast(back ? 'Addon redémarré, nouveau .env chargé' : 'L’addon ne répond pas encore', { tone: back ? 'ok' : 'warn' });
      } else {
        toast('.env enregistré — redémarrer pour l’appliquer', { tone: 'ok' });
      }
      await reload();
    } catch (err) {
      toast(err.message, { tone: 'error', title: 'Échec' });
    } finally {
      setBusy(null);
    }
  };

  return html`<div class="page">
    <div class="page-intro">
      <h1>Configuration</h1>
      <p class="muted">Réglages de <code>${data.path}</code>, décrits d'après <code>.env.example</code>. Ils ne s'appliquent qu'au redémarrage de l'addon.</p>
    </div>
    ${!data.exists && html`<${Callout} tone="warn" title=".env introuvable dans le process">
      Sous Docker, le <code>.env</code> doit être monté dans le conteneur (voir <code>docker-compose.yml</code>).
    </${Callout}>`}
    ${data.exists && !data.writable && html`<${Callout} tone="warn" title="Lecture seule">
      Le process n'a pas le droit d'écrire ce fichier. Sur l'hôte : <code>sudo chgrp 1000 .env && chmod 660 .env</code>.
    </${Callout}>`}

    <div class="env-toolbar">
      <${Segmented} value=${mode} onChange=${switchMode} options=${[
        { value: 'form', label: 'Réglages', icon: 'layers' },
        { value: 'raw', label: 'Texte brut', icon: 'terminal' },
      ]} />
      ${mode === 'form' && html`<div class="search-input">
        <${Icon} name="search" />
        <input value=${query} onInput=${(e) => setQuery(e.target.value)} placeholder="Chercher un réglage (clé ou description)…" aria-label="Chercher un réglage" />
      </div>`}
      <span class="grow"></span>
      ${pending > 0 && html`<span class="muted small">${mode === 'form' ? plural(pending, 'modification') : 'modifié'}</span>`}
      ${pending > 0 && html`<${Button} size="sm" variant="ghost" icon="undo" onClick=${discard}>Annuler</${Button}>`}
      <${Button} size="sm" icon="check" disabled=${!pending || !data.writable || busy} loading=${busy === 'save'} onClick=${() => run('save')}>Enregistrer</${Button}>
      <${Button} size="sm" variant="primary" icon="refresh" disabled=${(pending && !data.writable) || busy} loading=${busy === 'restart'} onClick=${() => run('restart')}>
        ${pending ? 'Enregistrer et redémarrer' : 'Redémarrer'}
      </${Button}>
    </div>

    ${mode === 'form'
      ? html`<${Form} data=${data} edits=${edits} setEdits=${setEdits} query=${query} />`
      : html`<${Card} title=".env" icon="key">
          <textarea class="env-editor" spellcheck="false" value=${text} readOnly=${!data.writable}
            onInput=${(e) => setText(e.target.value)} aria-label="Contenu du fichier .env"></textarea>
        </${Card}>`}
    ${data.backup && html`<p class="muted small">Copie avant la dernière modification : <code>data/env.bak</code> (${new Date(data.backup.modifiedAt).toLocaleString('fr-FR')})</p>`}
  </div>`;
}
