import { html, useState, useEffect, useRef } from '../vendor/preact-htm.js';
import { copy } from './lib.js';

// --- Icones (traces inspires de Lucide, ISC) ------------------------------------------
const ICONS = {
  activity: ['M22 12h-4l-3 9L9 3l-3 9H2'],
  search: ['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z', 'm21 21-4.3-4.3'],
  refresh: ['M21 12a9 9 0 1 1-3-6.7L21 8', 'M21 3v5h-5'],
  sync: ['M17 1l4 4-4 4', 'M3 11V9a4 4 0 0 1 4-4h14', 'M7 23l-4-4 4-4', 'M21 13v2a4 4 0 0 1-4 4H3'],
  terminal: ['m4 17 6-6-6-6', 'M12 19h8'],
  check: ['M20 6 9 17l-5-5'],
  x: ['M18 6 6 18', 'M6 6l12 12'],
  alert: ['m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3', 'M12 9v4', 'M12 17h.01'],
  info: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M12 16v-4', 'M12 8h.01'],
  copy: [
    'M9 9h11a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2z',
    'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1',
  ],
  play: ['M6 3l14 9-14 9z'],
  pause: ['M6 4h4v16H6z', 'M14 4h4v16h-4z'],
  sun: [
    'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
    'M12 2v2',
    'M12 20v2',
    'm4.9 4.9 1.4 1.4',
    'm17.7 17.7 1.4 1.4',
    'M2 12h2',
    'M20 12h2',
    'm6.3 17.7-1.4 1.4',
    'm19.1 4.9-1.4 1.4',
  ],
  moon: ['M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z'],
  server: [
    'M4 3h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z',
    'M4 13h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2z',
    'M6 7h.01',
    'M6 17h.01',
  ],
  film: ['M3 3h18v18H3z', 'M7 3v18', 'M17 3v18', 'M3 7.5h4', 'M3 12h18', 'M3 16.5h4', 'M17 7.5h4', 'M17 16.5h4'],
  tv: ['M2 7h20v13H2z', 'm17 2-5 5-5-5'],
  undo: ['M3 7v6h6', 'M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13'],
  flask: ['M9 3h6', 'M10 3v6L4.5 19a1.5 1.5 0 0 0 1.3 2h12.4a1.5 1.5 0 0 0 1.3-2L14 9V3'],
  link: [
    'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71',
    'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
  ],
  zap: ['M13 2 3 14h9l-1 8 10-12h-9z'],
  shield: ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10'],
  captions: ['M3 5h18v14H3z', 'M7 15h4', 'M15 15h2', 'M7 11h2', 'M13 11h4'],
  plug: ['M12 22v-5', 'M9 8V2', 'M15 8V2', 'M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z'],
  chevronRight: ['m9 18 6-6-6-6'],
  chevronDown: ['m6 9 6 6 6-6'],
  external: ['M15 3h6v6', 'M10 14 21 3', 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'],
  database: [
    'M3 5c0-1.7 4-3 9-3s9 1.3 9 3-4 3-9 3-9-1.3-9-3z',
    'M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5',
    'M3 12c0 1.7 4 3 9 3s9-1.3 9-3',
  ],
  clock: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M12 6v6l4 2'],
  trash: ['M3 6h18', 'M8 6V4h8v2', 'M19 6l-1 14H6L5 6'],
  key: ['M15.5 7.5 19 4', 'M21 2l-2 2', 'M11.4 11.6a5.5 5.5 0 1 1-7.8 7.8 5.5 5.5 0 0 1 7.8-7.8z', 'M11.4 11.6 15.5 7.5l3 3L22 7l-3-3'],
  arrowDown: ['M12 5v14', 'm19 12-7 7-7-7'],
  layers: ['m12 2 10 5-10 5L2 7z', 'm2 17 10 5 10-5', 'm2 12 10 5 10-5'],
  gauge: ['m12 14 4-4', 'M3.3 19a10 10 0 1 1 17.4 0'],
  cpu: ['M5 5h14v14H5z', 'M9 9h6v6H9z', 'M9 1v4', 'M15 1v4', 'M9 19v4', 'M15 19v4', 'M1 9h4', 'M1 15h4', 'M19 9h4', 'M19 15h4'],
  radio: ['M4.9 19.1a10 10 0 0 1 0-14.2', 'M7.8 16.2a6 6 0 0 1 0-8.4', 'M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z', 'M16.2 7.8a6 6 0 0 1 0 8.4', 'M19.1 4.9a10 10 0 0 1 0 14.2'],
  history: ['M3 12a9 9 0 1 0 3-6.7L3 8', 'M3 3v5h5', 'M12 7v5l4 2'],
  filter: ['M22 3H2l8 9.5V19l4 2v-8.5z'],
  eraser: ['m7 21-4.3-4.3a1 1 0 0 1 0-1.4l10-10a1 1 0 0 1 1.4 0l5.6 5.6a1 1 0 0 1 0 1.4L11 21', 'M22 21H7', 'm5 11 9 9'],
};

export function Icon({ name, size = 18, class: className = '' }) {
  const paths = ICONS[name] || ICONS.info;
  return html`<svg class=${`icon ${className}`} width=${size} height=${size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    ${paths.map((d) => html`<path d=${d} />`)}
  </svg>`;
}

// --- Briques de base -----------------------------------------------------------------
export function Card({ title, icon, actions, children, class: className = '', pad = true }) {
  return html`<section class=${`card ${className}`}>
    ${(title || actions) &&
    html`<header class="card-head">
      <h2>${icon && html`<${Icon} name=${icon} size=${16} />`}${title}</h2>
      ${actions && html`<div class="card-actions">${actions}</div>`}
    </header>`}
    <div class=${pad ? 'card-body' : 'card-body flush'}>${children}</div>
  </section>`;
}

/** tone: ok | warn | error | info | neutral | accent */
export function Badge({ tone = 'neutral', children, title }) {
  return html`<span class=${`badge badge-${tone}`} title=${title}>${children}</span>`;
}

export function Dot({ tone = 'neutral', pulse = false }) {
  return html`<span class=${`dot dot-${tone}${pulse ? ' pulse' : ''}`}></span>`;
}

export function Stat({ label, value, hint, icon, tone }) {
  return html`<div class=${`stat${tone ? ` stat-${tone}` : ''}`}>
    <div class="stat-label">${icon && html`<${Icon} name=${icon} size=${14} />`}${label}</div>
    <div class="stat-value">${value}</div>
    ${hint && html`<div class="stat-hint">${hint}</div>`}
  </div>`;
}

export function Button({ children, icon, variant = 'default', size, loading, disabled, onClick, title, type = 'button' }) {
  const classes = ['btn', `btn-${variant}`, size && `btn-${size}`, loading && 'is-loading'].filter(Boolean).join(' ');
  return html`<button type=${type} class=${classes} disabled=${disabled || loading} onClick=${onClick} title=${title}>
    ${loading ? html`<${Spinner} size=${14} />` : icon && html`<${Icon} name=${icon} size=${15} />`}
    ${children && html`<span>${children}</span>`}
  </button>`;
}

export function Spinner({ size = 18 }) {
  return html`<span class="spinner" style=${`width:${size}px;height:${size}px`} aria-label="chargement"></span>`;
}

export function Skeleton({ lines = 3, height }) {
  return html`<div class="skeleton-group">
    ${Array.from({ length: lines }, (_, i) => html`<div class="skeleton" style=${`${height ? `height:${height}px;` : ''}width:${100 - ((i * 17) % 40)}%`}></div>`)}
  </div>`;
}

export function Empty({ icon = 'info', title, children }) {
  return html`<div class="empty">
    <div class="empty-icon"><${Icon} name=${icon} size=${22} /></div>
    ${title && html`<div class="empty-title">${title}</div>`}
    ${children && html`<div class="empty-text">${children}</div>`}
  </div>`;
}

export function ErrorBox({ error, onRetry }) {
  if (!error) return null;
  return html`<div class="callout callout-error">
    <${Icon} name="alert" />
    <div class="callout-body">
      <strong>${error.status ? `Erreur ${error.status}` : 'Erreur'}</strong>
      <div>${error.message}</div>
    </div>
    ${onRetry && html`<${Button} size="sm" icon="refresh" onClick=${onRetry}>Réessayer</${Button}>`}
  </div>`;
}

export function Callout({ tone = 'info', icon, title, children }) {
  return html`<div class=${`callout callout-${tone}`}>
    <${Icon} name=${icon || (tone === 'error' || tone === 'warn' ? 'alert' : 'info')} />
    <div class="callout-body">
      ${title && html`<strong>${title}</strong>`}
      <div>${children}</div>
    </div>
  </div>`;
}

export function Segmented({ value, options, onChange, size }) {
  return html`<div class=${`segmented${size ? ` segmented-${size}` : ''}`} role="tablist">
    ${options.map(
      (o) => html`<button type="button" role="tab" aria-selected=${o.value === value}
        class=${o.value === value ? 'active' : ''} onClick=${() => onChange(o.value)}>
        ${o.icon && html`<${Icon} name=${o.icon} size=${14} />`}${o.label}
        ${o.count !== undefined && html`<span class="seg-count">${o.count}</span>`}
      </button>`,
    )}
  </div>`;
}

export function CopyButton({ text, label, size = 'sm' }) {
  const [done, setDone] = useState(false);
  const onClick = async () => {
    if (await copy(text)) {
      setDone(true);
      setTimeout(() => setDone(false), 1400);
    }
  };
  return html`<${Button} size=${size} variant="ghost" icon=${done ? 'check' : 'copy'} onClick=${onClick} title="Copier">
    ${label}
  </${Button}>`;
}

export function KeyValue({ rows }) {
  return html`<dl class="kv">
    ${rows
      .filter(Boolean)
      .map(([key, value]) => html`<div class="kv-row"><dt>${key}</dt><dd>${value}</dd></div>`)}
  </dl>`;
}

// --- JSON brut -------------------------------------------------------------------------
function highlight(json) {
  const escaped = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return escaped.replace(
    /("(\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
    (match) => {
      let cls = 'j-num';
      if (/^"/.test(match)) cls = /:$/.test(match) ? 'j-key' : 'j-str';
      else if (/true|false/.test(match)) cls = 'j-bool';
      else if (/null/.test(match)) cls = 'j-null';
      return `<span class="${cls}">${match}</span>`;
    },
  );
}

export function JsonView({ data, label = 'Réponse brute', open = false }) {
  const text = JSON.stringify(data, null, 2) ?? 'null';
  return html`<details class="json" open=${open}>
    <summary><${Icon} name="chevronRight" size=${14} class="json-caret" />${label}
      <span class="json-copy" onClick=${(e) => e.preventDefault()}><${CopyButton} text=${text} /></span>
    </summary>
    <pre dangerouslySetInnerHTML=${{ __html: highlight(text) }}></pre>
  </details>`;
}

// --- Modale ------------------------------------------------------------------------------
export function Modal({ title, icon, onClose, children, footer, wide }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose?.();
    addEventListener('keydown', onKey);
    document.body.classList.add('no-scroll');
    return () => {
      removeEventListener('keydown', onKey);
      document.body.classList.remove('no-scroll');
    };
  }, []);
  return html`<div class="modal-backdrop" onClick=${(e) => e.target === e.currentTarget && onClose?.()}>
    <div class=${`modal${wide ? ' modal-wide' : ''}`} role="dialog" aria-modal="true">
      <header class="modal-head">
        <h3>${icon && html`<${Icon} name=${icon} />`}${title}</h3>
        <button class="icon-btn" onClick=${onClose} aria-label="Fermer"><${Icon} name="x" /></button>
      </header>
      <div class="modal-body">${children}</div>
      ${footer && html`<footer class="modal-foot">${footer}</footer>`}
    </div>
  </div>`;
}

// --- Toasts --------------------------------------------------------------------------------
const toastListeners = new Set();
let toastId = 0;

export function toast(message, { tone = 'info', title, timeout = 4500 } = {}) {
  const item = { id: ++toastId, message, tone, title };
  for (const listener of toastListeners) listener({ type: 'add', item });
  if (timeout) setTimeout(() => toastListeners.forEach((l) => l({ type: 'remove', id: item.id })), timeout);
}

export function Toasts() {
  const [items, setItems] = useState([]);
  useEffect(() => {
    const listener = (event) =>
      setItems((list) => (event.type === 'add' ? [...list, event.item] : list.filter((i) => i.id !== event.id)));
    toastListeners.add(listener);
    return () => toastListeners.delete(listener);
  }, []);
  return html`<div class="toasts" aria-live="polite">
    ${items.map(
      (t) => html`<div class=${`toast toast-${t.tone}`} key=${t.id}>
        <${Icon} name=${t.tone === 'ok' ? 'check' : t.tone === 'error' || t.tone === 'warn' ? 'alert' : 'info'} />
        <div>${t.title && html`<strong>${t.title}</strong>`}<div>${t.message}</div></div>
        <button class="icon-btn" onClick=${() => setItems((l) => l.filter((i) => i.id !== t.id))}><${Icon} name="x" size=${14} /></button>
      </div>`,
    )}
  </div>`;
}

/** Barre de proportion (x sur total), avec couleur selon le ratio. */
export function Meter({ value, total, tone }) {
  const ratio = total > 0 ? value / total : 0;
  const auto = ratio >= 0.66 ? 'ok' : ratio > 0 ? 'warn' : 'error';
  return html`<div class="meter" title=${`${value}/${total}`}>
    <div class=${`meter-fill meter-${tone || auto}`} style=${`width:${Math.round(ratio * 100)}%`}></div>
  </div>`;
}

export function useOutsideClick(onOutside) {
  const ref = useRef(null);
  useEffect(() => {
    const handler = (e) => ref.current && !ref.current.contains(e.target) && onOutside();
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);
  return ref;
}
