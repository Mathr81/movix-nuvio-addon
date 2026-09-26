import { html, useState, useEffect, useRef, useMemo } from '../../vendor/preact-htm.js';
import { formatTime, useLocalState } from '../lib.js';
import { Button, Dot, Icon, Empty } from '../ui.js';

const MAX_KEPT = 5000;
const MAX_SHOWN = 1500;
const LEVELS = [
  { value: 'info', label: 'Info' },
  { value: 'warn', label: 'Avert.' },
  { value: 'error', label: 'Erreurs' },
];

/**
 * Flux SSE des logs. EventSource se reconnecte seul et renvoie `Last-Event-ID`: le serveur
 * rejoue alors ce qui a ete manque, sans doublon.
 */
function useLogStream(paused) {
  const [lines, setLines] = useState([]);
  const [status, setStatus] = useState('connecting');
  const pending = useRef([]);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    const source = new EventSource(new URL('api/logs/stream', document.baseURI));
    source.onopen = () => setStatus('live');
    source.onerror = () => setStatus(source.readyState === EventSource.CLOSED ? 'closed' : 'reconnecting');
    source.onmessage = (event) => {
      try {
        pending.current.push(JSON.parse(event.data));
      } catch {
        // ligne illisible: ignoree
      }
    };
    // Regroupe les lignes par lots: un cycle du hub en ecrit des centaines d'un coup.
    const flush = setInterval(() => {
      if (!pending.current.length || pausedRef.current) return;
      const batch = pending.current;
      pending.current = [];
      setLines((list) => {
        const merged = list.concat(batch);
        return merged.length > MAX_KEPT ? merged.slice(merged.length - MAX_KEPT) : merged;
      });
    }, 250);
    return () => {
      clearInterval(flush);
      source.close();
    };
  }, []);

  return { lines, setLines, status, pendingCount: () => pending.current.length };
}

function highlight(message, query) {
  if (!query) return message;
  const index = message.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0) return message;
  return html`${message.slice(0, index)}<mark>${message.slice(index, index + query.length)}</mark>${message.slice(index + query.length)}`;
}

export function LogsPage() {
  const [paused, setPaused] = useState(false);
  const { lines, setLines, status } = useLogStream(paused);
  const [levels, setLevels] = useLocalState('logs.levels', ['info', 'warn', 'error']);
  const [tag, setTag] = useState(null);
  const [query, setQuery] = useState('');
  const [follow, setFollow] = useState(true);
  const [wrap, setWrap] = useLocalState('logs.wrap', true);
  const scroller = useRef(null);

  const tags = useMemo(() => {
    const counts = new Map();
    for (const line of lines) if (line.tag) counts.set(line.tag, (counts.get(line.tag) || 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 16);
  }, [lines]);

  const counts = useMemo(() => {
    const c = { info: 0, warn: 0, error: 0 };
    for (const line of lines) c[line.level === 'debug' ? 'info' : line.level] += 1;
    return c;
  }, [lines]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = lines.filter(
      (l) =>
        levels.includes(l.level === 'debug' ? 'info' : l.level) &&
        (!tag || l.tag === tag) &&
        (!q || l.message.toLowerCase().includes(q)),
    );
    return filtered.length > MAX_SHOWN ? filtered.slice(filtered.length - MAX_SHOWN) : filtered;
  }, [lines, levels, tag, query]);

  useEffect(() => {
    if (follow && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [shown, follow]);

  const onScroll = () => {
    const el = scroller.current;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (atBottom !== follow) setFollow(atBottom);
  };

  const toggleLevel = (level) =>
    setLevels((list) => (list.includes(level) ? list.filter((l) => l !== level) : [...list, level]));

  const statusTone = { live: 'ok', connecting: 'info', reconnecting: 'warn', closed: 'error' }[status];
  const statusLabel = { live: 'en direct', connecting: 'connexion…', reconnecting: 'reconnexion…', closed: 'déconnecté' }[status];

  return html`<div class="page page-logs">
    <div class="logs-toolbar">
      <div class="row gap wrap">
        <span class="live-pill"><${Dot} tone=${paused ? 'warn' : statusTone} pulse=${status === 'live' && !paused} />${paused ? 'en pause' : statusLabel}</span>
        <div class="level-toggles">
          ${LEVELS.map(
            (l) => html`<button class=${`level-toggle level-${l.value}${levels.includes(l.value) ? ' active' : ''}`} onClick=${() => toggleLevel(l.value)}>
              ${l.label}<span class="seg-count">${counts[l.value]}</span>
            </button>`,
          )}
        </div>
        <div class="search-input search-sm">
          <${Icon} name="search" size=${15} />
          <input value=${query} onInput=${(e) => setQuery(e.target.value)} placeholder="Filtrer…" aria-label="Filtrer les logs" />
        </div>
        <span class="grow"></span>
        <${Button} size="sm" variant="ghost" icon=${paused ? 'play' : 'pause'} onClick=${() => setPaused(!paused)}>${paused ? 'Reprendre' : 'Pause'}</${Button}>
        <${Button} size="sm" variant="ghost" icon="layers" onClick=${() => setWrap(!wrap)}>${wrap ? 'Sans retour' : 'Retour à la ligne'}</${Button}>
        <${Button} size="sm" variant="ghost" icon="eraser" onClick=${() => setLines([])}>Vider</${Button}>
      </div>
      ${tags.length > 0 && html`<div class="tag-row">
        <${Icon} name="filter" size=${14} class="muted" />
        <button class=${`chip-btn chip-sm${!tag ? ' active' : ''}`} onClick=${() => setTag(null)}>tous</button>
        ${tags.map(([name, n]) => html`<button class=${`chip-btn chip-sm${tag === name ? ' active' : ''}`} onClick=${() => setTag(tag === name ? null : name)}>
          ${name}<span class="muted"> ${n}</span>
        </button>`)}
      </div>`}
    </div>

    <div class=${`logs${wrap ? ' logs-wrap' : ''}`} ref=${scroller} onScroll=${onScroll}>
      ${shown.length === 0
        ? html`<${Empty} icon="terminal" title=${lines.length ? 'Aucune ligne ne correspond aux filtres' : 'En attente de logs…'} />`
        : shown.map(
            (l) => html`<div class=${`log log-${l.level}`} key=${l.id}>
              <span class="log-time">${formatTime(l.at)}</span>
              <span class="log-level">${l.level === 'error' ? 'ERR' : l.level === 'warn' ? 'WRN' : 'INF'}</span>
              <span class="log-msg">${highlight(l.message, query.trim())}</span>
            </div>`,
          )}
    </div>
    ${!follow && html`<button class="follow-btn" onClick=${() => setFollow(true)}><${Icon} name="arrowDown" size=${15} /> Suivre</button>`}
  </div>`;
}
