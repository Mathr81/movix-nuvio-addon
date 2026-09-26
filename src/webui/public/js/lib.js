import { useState, useEffect, useRef, useCallback } from '../vendor/preact-htm.js';

// --- Appels API -----------------------------------------------------------------
// Chemins relatifs: la page est servie sous /ui/, l'API sous /ui/api.
export async function api(path, { method = 'GET', body, query } = {}) {
  const url = new URL(`api/${path.replace(/^\//, '')}`, document.baseURI);
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
  }
  const response = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await response.json();
  } catch {
    // corps vide ou non JSON
  }
  if (!response.ok) {
    const error = new Error(data?.error || `HTTP ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

/**
 * Charge une ressource, et la recharge toutes les `interval` ms si demande. Le
 * rafraichissement est suspendu quand l'onglet est masque.
 */
export function useResource(loader, deps = [], { interval = 0 } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: true, at: null });
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const reload = useCallback(async () => {
    setState((s) => ({ ...s, loading: true }));
    try {
      const data = await loaderRef.current();
      setState({ data, error: null, loading: false, at: Date.now() });
    } catch (error) {
      setState((s) => ({ ...s, error, loading: false, at: Date.now() }));
    }
  }, []);

  useEffect(() => {
    setState({ data: null, error: null, loading: true, at: null });
    reload();
    if (!interval) return undefined;
    const timer = setInterval(() => {
      if (!document.hidden) reload();
    }, interval);
    return () => clearInterval(timer);
  }, deps);

  return { ...state, reload };
}

/** Re-rendu periodique, pour les "il y a 12 s". */
export function useTick(ms = 1000) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), ms);
    return () => clearInterval(timer);
  }, [ms]);
}

export function useLocalState(key, initial) {
  const [value, setValue] = useState(() => {
    try {
      const stored = localStorage.getItem(`movix-ui:${key}`);
      return stored === null ? initial : JSON.parse(stored);
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(`movix-ui:${key}`, JSON.stringify(value));
    } catch {
      // stockage indisponible (navigation privee): la preference reste en memoire
    }
  }, [key, value]);
  return [value, setValue];
}

// --- Routage par hash -------------------------------------------------------------
export function useHashRoute() {
  const read = () => {
    const [path, query = ''] = (location.hash.replace(/^#/, '') || '/').split('?');
    return { path, params: Object.fromEntries(new URLSearchParams(query)) };
  };
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const onChange = () => setRoute(read());
    addEventListener('hashchange', onChange);
    return () => removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export function navigate(path, params) {
  const query = params ? new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString() : '';
  location.hash = query ? `${path}?${query}` : path;
}

// --- Mise en forme ------------------------------------------------------------------
export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return '—';
  const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`;
}

export function formatBitrate(bps) {
  if (!bps) return '—';
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(bps >= 1e7 ? 0 : 1)} Mb/s`;
  return `${Math.round(bps / 1e3)} kb/s`;
}

export function formatDuration(seconds) {
  if (seconds === null || seconds === undefined) return '—';
  const s = Math.max(0, Math.round(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d} j ${h} h`;
  if (h > 0) return `${h} h ${String(m).padStart(2, '0')}`;
  if (m > 0) return `${m} min`;
  return `${s} s`;
}

export function formatInterval(ms) {
  if (!ms) return 'désactivé';
  return `toutes les ${formatDuration(ms / 1000)}`;
}

export function timeAgo(value) {
  if (!value) return 'jamais';
  const date = typeof value === 'number' ? value : Date.parse(value);
  const seconds = Math.round((Date.now() - date) / 1000);
  if (seconds < 5) return "à l'instant";
  if (seconds < 60) return `il y a ${seconds} s`;
  if (seconds < 3600) return `il y a ${Math.floor(seconds / 60)} min`;
  if (seconds < 86400) return `il y a ${Math.floor(seconds / 3600)} h`;
  return `il y a ${Math.floor(seconds / 86400)} j`;
}

export function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('fr-FR', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function formatTime(value) {
  return new Date(value).toLocaleTimeString('fr-FR', { hour12: false });
}

export function plural(n, one, many = `${one}s`) {
  return `${n} ${n > 1 ? many : one}`;
}

export async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // http sans contexte securise: repli sur une zone de texte temporaire
    const area = document.createElement('textarea');
    area.value = text;
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}
