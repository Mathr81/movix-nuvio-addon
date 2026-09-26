import { html, render, useEffect } from '../vendor/preact-htm.js';
import { useHashRoute, useLocalState } from './lib.js';
import { Icon, Toasts } from './ui.js';
import { OverviewPage } from './pages/overview.js';
import { TitlePage } from './pages/title.js';
import { SyncPage } from './pages/sync.js';
import { LogsPage } from './pages/logs.js';

const ROUTES = [
  { path: '/', label: 'Santé', icon: 'activity', page: OverviewPage },
  { path: '/titre', label: 'Testeur', icon: 'search', page: TitlePage },
  { path: '/synchro', label: 'Synchro', icon: 'sync', page: SyncPage },
  { path: '/logs', label: 'Logs', icon: 'terminal', page: LogsPage },
];

function ThemeToggle() {
  const [theme, setTheme] = useLocalState('theme', 'system');
  useEffect(() => {
    if (theme === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, [theme]);
  const next = { system: 'dark', dark: 'light', light: 'system' }[theme];
  const icon = theme === 'light' ? 'sun' : theme === 'dark' ? 'moon' : 'cpu';
  const label = { system: 'Thème : système', dark: 'Thème : sombre', light: 'Thème : clair' }[theme];
  return html`<button class="nav-item theme-toggle" onClick=${() => setTheme(next)} title=${label}>
    <${Icon} name=${icon} /><span>${label}</span>
  </button>`;
}

function App() {
  const route = useHashRoute();
  const current = ROUTES.find((r) => r.path === route.path) || ROUTES[0];
  const Page = current.page;

  useEffect(() => {
    document.title = `${current.label} · Movix addon`;
    window.scrollTo(0, 0);
  }, [current.path]);

  return html`<div class="shell">
    <aside class="sidebar">
      <a class="brand" href="#/">
        <span class="brand-mark"><${Icon} name="play" size=${16} /></span>
        <span class="brand-text"><strong>Movix</strong><span>addon</span></span>
      </a>
      <nav class="nav">
        ${ROUTES.map(
          (r) => html`<a class=${`nav-item${r === current ? ' active' : ''}`} href=${`#${r.path}`}>
            <${Icon} name=${r.icon} /><span>${r.label}</span>
          </a>`,
        )}
      </nav>
      <div class="sidebar-foot"><${ThemeToggle} /></div>
    </aside>
    <main class="main">
      <${Page} key=${current.path} params=${route.params} />
    </main>
    <${Toasts} />
  </div>`;
}

render(html`<${App} />`, document.getElementById('app'));
