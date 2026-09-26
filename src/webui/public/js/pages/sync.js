import { html, useState } from '../../vendor/preact-htm.js';
import { api, useResource, useTick, timeAgo, formatDate, formatInterval, plural } from '../lib.js';
import { Card, Badge, Dot, Button, Skeleton, ErrorBox, Empty, KeyValue, Callout, Icon, Spinner, JsonView, Segmented } from '../ui.js';
import { useActions } from '../actions.js';

const KINDS = { library: 'Bibliothèque', watched: 'Vus', progress: 'Reprises' };
const TARGETS = { movix: 'Movix', nuvio: 'Nuvio', simkl: 'Simkl' };

function sumOf(counts) {
  return Object.values(counts || {}).reduce((n, v) => n + (typeof v === 'number' ? v : 0), 0);
}

function ActionButtons({ names, actions, runner }) {
  return html`<div class="row gap wrap">
    ${names.map((name) => {
      const action = actions[name];
      if (!action) return null;
      return html`
        ${action.dryRun && html`<${Button} size="sm" icon="flask" variant="ghost"
          loading=${runner.isRunning(name, true)} onClick=${() => runner.run(action, { dryRun: true })}>Simuler</${Button}>`}
        <${Button} size="sm" icon="play" variant="primary" loading=${runner.isRunning(name)} onClick=${() => runner.run(action)}>
          ${action.label}
        </${Button}>`;
    })}
  </div>`;
}

/** Une ligne par action: son nom a gauche, simulation et execution a droite. */
function ActionRows({ names, actions, runner }) {
  return html`<div class="action-rows">
    ${names.map((name) => {
      const action = actions[name];
      if (!action) return null;
      const isAuth = name.endsWith('auth');
      return html`<div class="action-row">
        <span class="action-label">${action.label}</span>
        <span class="row gap">
          ${action.dryRun && html`<${Button} size="sm" icon="flask" variant="ghost" title="Simuler sans rien écrire"
            loading=${runner.isRunning(name, true)} onClick=${() => runner.run(action, { dryRun: true })}>Simuler</${Button}>`}
          <${Button} size="sm" icon=${isAuth ? 'key' : name.endsWith('resync') ? 'refresh' : 'play'} variant=${isAuth ? 'primary' : 'default'}
            loading=${runner.isRunning(name)} onClick=${() => runner.run(action)}>${isAuth ? 'Connecter' : 'Lancer'}</${Button}>
        </span>
      </div>`;
    })}
  </div>`;
}

// --- Hub --------------------------------------------------------------------------------
function Flow({ label, delta, tone = 'accent' }) {
  const total = sumOf(delta);
  return html`<div class=${`flow${total ? ` flow-${tone}` : ''}`}>
    <span class="flow-label">${label}</span>
    <span class="flow-value">${total}</span>
    ${total > 0 && html`<span class="muted small">${Object.entries(delta).filter(([, v]) => v).map(([k, v]) => `${v} ${KINDS[k]?.toLowerCase() || k}`).join(' · ')}</span>`}
  </div>`;
}

function CycleSummary({ summary }) {
  if (!summary) return null;
  const errors = Object.entries(summary.errors || {});
  return html`<div class="cycle-summary">
    <div class="side-counts">
      ${['movix', 'nuvio', 'simkl'].map(
        (side) => summary[side] && html`<div class="side">
          <div class="side-name">${TARGETS[side]}</div>
          ${Object.entries(summary[side]).map(([k, v]) => html`<div class="side-row"><span class="muted">${KINDS[k] || k}</span><strong>${v}</strong></div>`)}
        </div>`,
      )}
    </div>
    <div class="flows">
      <${Flow} label="→ Nuvio" delta=${summary.versNuvio} />
      <${Flow} label="→ Movix" delta=${summary.versMovix} />
      <${Flow} label="→ Simkl" delta=${summary.versSimkl} />
      ${summary.retraits && Object.entries(summary.retraits).map(([side, delta]) => html`<${Flow} label=${`✕ ${TARGETS[side] || side}`} delta=${delta} tone="warn" />`)}
    </div>
    ${errors.length > 0 && html`<${Callout} tone="error" title="Erreurs">
      ${errors.map(([step, message]) => html`<div class="err-line"><code>${step}</code> ${message}</div>`)}
    </${Callout}>`}
  </div>`;
}

function HubCard({ hub, actions, runner }) {
  const last = hub.lastRun;
  return html`<${Card} title="Hub de synchronisation" icon="sync" class="span-full"
    actions=${html`<${ActionButtons} names=${['hub-sync']} actions=${actions} runner=${runner} />`}>
    <div class="row gap wrap">
      <${Badge} tone=${hub.enabled ? 'ok' : 'neutral'}>${hub.enabled ? `actif · ${formatInterval(hub.intervalMs)}` : 'désactivé (HUB_ENABLED)'}</${Badge}>
      ${hub.running && html`<${Badge} tone="info"><${Spinner} size=${10} /> cycle en cours</${Badge}>`}
      ${last && html`<${Badge} tone=${last.summary?.ok === false ? 'error' : 'ok'}>dernier cycle ${timeAgo(last.at)}</${Badge}>`}
      ${last?.summary?.dryRun && html`<${Badge} tone="warn">simulation</${Badge}>`}
    </div>
    ${last ? html`<${CycleSummary} summary=${last.summary} />` : html`<${Empty} icon="clock" title="Aucun cycle depuis le démarrage">Le journal ci-dessous garde les cycles précédents.</${Empty}>`}
  </${Card}>`;
}

// --- Trackers ------------------------------------------------------------------------------
function TrackerCard({ name, icon, status, rows, actionNames, actions, runner, note }) {
  const tone = !status.configured ? 'neutral' : status.paused ? 'warn' : status.authenticated === false ? 'warn' : 'ok';
  const label = !status.configured ? 'non configuré' : status.paused ? 'en pause' : status.authenticated === false ? 'non connecté' : 'opérationnel';
  return html`<${Card} title=${name} icon=${icon} actions=${html`<${Dot} tone=${tone} /><span class="small muted">${label}</span>`}>
    <${KeyValue} rows=${rows} />
    ${note}
    ${status.configured && html`<${ActionRows} names=${actionNames} actions=${actions} runner=${runner} />`}
  </${Card}>`;
}

// --- Journal -----------------------------------------------------------------------------
function countsByAction(counts) {
  const out = { add: 0, remove: 0 };
  for (const [key, n] of Object.entries(counts || {})) out[key.split('.')[0]] = (out[key.split('.')[0]] || 0) + n;
  return out;
}

function CycleEntries({ cycle }) {
  const { data, error, loading } = useResource(() => api(`journal/${encodeURIComponent(cycle.id)}`), [cycle.id]);
  const [filter, setFilter] = useState('all');
  if (error) return html`<${ErrorBox} error=${error} />`;
  if (loading || !data) return html`<div class="loading-block"><${Spinner} /> Lecture du journal…</div>`;
  const entries = data.entries.filter((e) => filter === 'all' || e.action === filter);
  return html`<div class="cycle-entries">
    <div class="row gap wrap">
      <${Segmented} size="sm" value=${filter} onChange=${setFilter} options=${[
        { value: 'all', label: 'Tout' },
        { value: 'add', label: 'Ajouts' },
        { value: 'remove', label: 'Retraits' },
      ]} />
      ${data.total > data.entries.length && html`<span class="muted small">${data.entries.length} premières lignes sur ${data.total}</span>`}
    </div>
    <div class="table-wrap">
      <table class="table table-compact">
        <thead><tr><th>Heure</th><th>Action</th><th>Cible</th><th>Type</th><th>Élément</th></tr></thead>
        <tbody>
          ${entries.map(
            (e) => html`<tr>
              <td class="muted">${new Date(e.at).toLocaleTimeString('fr-FR')}</td>
              <td><${Badge} tone=${e.action === 'remove' ? 'warn' : 'ok'}>${e.action === 'remove' ? 'retrait' : 'ajout'}</${Badge}></td>
              <td>${TARGETS[e.target] || e.target}</td>
              <td>${KINDS[e.kind] || e.kind}</td>
              <td><code>${e.key}</code>${e.item?.position ? html` <span class="muted small">${Math.round((e.item.position / (e.item.duration || 1)) * 100)} %</span>` : ''}</td>
            </tr>`,
          )}
        </tbody>
      </table>
    </div>
  </div>`;
}

function Journal({ cycles, enabled, actions, runner }) {
  const [open, setOpen] = useState(null);
  if (!enabled) return html`<${Empty} icon="history" title="Journal désactivé">HUB_JOURNAL=false</${Empty}>`;
  if (!cycles.length) return html`<${Empty} icon="history" title="Journal vide">Aucun cycle n'a encore écrit quoi que ce soit.</${Empty}>`;
  return html`<div class="cycles">
    ${cycles.map((cycle) => {
      const counts = countsByAction(cycle.counts);
      const failed = cycle.summary?.ok === false;
      const isOpen = open === cycle.id;
      return html`<div class=${`cycle${isOpen ? ' open' : ''}`}>
        <button class="cycle-head" onClick=${() => setOpen(isOpen ? null : cycle.id)}>
          <${Icon} name=${isOpen ? 'chevronDown' : 'chevronRight'} size=${16} />
          <span class="cycle-date">${formatDate(cycle.lastAt)}</span>
          <span class="cycle-badges">
            ${cycle.summary ? html`<${Badge} tone=${failed ? 'error' : 'ok'}>${failed ? 'erreurs' : 'ok'}</${Badge}>` : html`<${Badge}>sans résumé</${Badge}>`}
            ${counts.add > 0 && html`<${Badge} tone="info">+${counts.add}</${Badge}>`}
            ${counts.remove > 0 && html`<${Badge} tone="warn">−${counts.remove}</${Badge}>`}
          </span>
          <span class="muted small cycle-ago">${timeAgo(cycle.lastAt)}</span>
        </button>
        ${isOpen && html`<div class="cycle-body">
          ${cycle.summary && html`<${CycleSummary} summary=${cycle.summary} />`}
          ${counts.remove > 0 && actions['hub-undo'] && html`<${Callout} tone="warn" title=${`${plural(counts.remove, 'retrait')} dans ce cycle`}>
            <div class="row gap wrap"><span>Les éléments retirés peuvent être remis en place avec leurs valeurs d'origine.</span>
            <${Button} size="sm" icon="undo" loading=${runner.isRunning('hub-undo')}
              onClick=${() => runner.run(actions['hub-undo'], { params: { cycle: cycle.id }, confirmText: `Restaurer les ${counts.remove} retraits du cycle du ${formatDate(cycle.lastAt)}. L'instantané du hub sera effacé.` })}>
              Annuler ces retraits</${Button}></div>
          </${Callout}>`}
          <${CycleEntries} cycle=${cycle} />
          ${cycle.summary && html`<${JsonView} data=${cycle.summary} label="Résumé brut" />`}
        </div>`}
      </div>`;
    })}
  </div>`;
}

export function SyncPage() {
  const { data, error, reload } = useResource(() => api('sync'), [], { interval: 10000 });
  const runner = useActions({ onDone: reload });
  useTick(5000);

  if (!data && error) return html`<${ErrorBox} error=${error} onRetry=${reload} />`;
  if (!data) return html`<div class="grid">${[1, 2, 3].map(() => html`<${Card}><${Skeleton} lines=${4} /></${Card}>`)}</div>`;

  const actions = Object.fromEntries(data.actions.map((a) => [a.name, a]));
  const { nuvio, trakt, simkl } = data.trackers;

  return html`<div class="page">
    <div class="page-intro">
      <h1>Synchro & trackers</h1>
      <p class="muted">Movix ⇄ Nuvio ⇄ Simkl, et les pushs vers Trakt. Les actions qui écrivent demandent confirmation et peuvent être simulées.</p>
    </div>
    ${error && html`<${ErrorBox} error=${error} onRetry=${reload} />`}
    <div class="grid">
      <${HubCard} hub=${data.hub} actions=${actions} runner=${runner} />

      <${TrackerCard} name="Nuvio" icon="tv" status=${nuvio} actions=${actions} runner=${runner}
        actionNames=${['nuvio-push', 'nuvio-merge']}
        rows=${[
          ['Compte', html`<${Badge} tone=${nuvio.configured ? 'ok' : 'neutral'}>${nuvio.configured ? 'configuré' : 'NUVIO_EMAIL vide'}</${Badge}>`],
          ['Push auto', formatInterval(nuvio.pushIntervalMs)],
          ['Format des ids', html`<code>${nuvio.idFormat}</code>`],
        ]} />

      <${TrackerCard} name="Simkl" icon="history" status=${simkl} actions=${actions} runner=${runner}
        actionNames=${simkl.authenticated ? ['simkl-push', 'simkl-resync'] : ['simkl-auth']}
        rows=${[
          ['Application', html`<${Badge} tone=${simkl.configured ? 'ok' : 'neutral'}>${simkl.configured ? 'configurée' : 'SIMKL_CLIENT_ID vide'}</${Badge}>`],
          ['Connexion', html`<${Badge} tone=${simkl.authenticated ? 'ok' : 'warn'}>${simkl.authenticated ? 'connecté' : 'non connecté'}</${Badge}>`],
          ['Push auto', formatInterval(simkl.pushIntervalMs)],
          simkl.viaProxy && ['Sortie', html`<code>${simkl.viaProxy}</code>`],
          simkl.paused && ['Pause', html`jusqu'à ${formatDate(simkl.pausedUntil)}`],
        ]}
        note=${simkl.paused && simkl.reason && html`<${Callout} tone="warn" title="Simkl en pause">${simkl.reason}</${Callout}>`} />

      <${TrackerCard} name="Trakt" icon="radio" status=${trakt} actions=${actions} runner=${runner}
        actionNames=${trakt.authenticated ? ['trakt-push'] : ['trakt-auth']}
        rows=${[
          ['Application', html`<${Badge} tone=${trakt.configured ? 'ok' : 'neutral'}>${trakt.configured ? 'configurée' : 'TRAKT_CLIENT_ID vide'}</${Badge}>`],
          ['Connexion', html`<${Badge} tone=${trakt.authenticated ? 'ok' : 'warn'}>${trakt.authenticated ? 'connecté' : 'non connecté'}</${Badge}>`],
          ['Push auto', formatInterval(trakt.pushIntervalMs)],
        ]} />

      <${Card} title="Journal du hub" icon="history" class="span-full"
        actions=${html`<span class="muted small">${plural(data.cycles.length, 'cycle')} récents</span>`}>
        <${Journal} cycles=${data.cycles} enabled=${data.journalEnabled} actions=${actions} runner=${runner} />
      </${Card}>
    </div>
    ${runner.modal}
  </div>`;
}
