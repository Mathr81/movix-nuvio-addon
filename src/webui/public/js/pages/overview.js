import { html } from '../../vendor/preact-htm.js';
import { api, useResource, useTick, timeAgo, formatDuration, formatBytes, formatInterval, formatDate, navigate } from '../lib.js';
import { Card, Badge, Dot, Stat, Button, Skeleton, ErrorBox, KeyValue, CopyButton, Icon, Empty, JsonView } from '../ui.js';

/**
 * Verifications derivees de /ui/api/overview. Chaque point dit ce qui ne va pas ET ce
 * qu'il faut faire: c'est la difference avec le JSON brut de /health.
 */
function checksOf(o) {
  const checks = [];
  const add = (tone, title, detail, link) => checks.push({ tone, title, detail, link });

  for (const service of o.services) {
    if (!service.ok) add('error', `${service.name} injoignable`, service.error || `HTTP ${service.status}`);
    else if (service.ms > 2500) add('warn', `${service.name} lent`, `${service.ms} ms pour répondre`);
  }
  if (!o.config.tmdbKeyConfigured) add('error', 'TMDB_API_KEY manquant', 'Catalogues et fiches ne fonctionneront pas.');
  if (!o.movix.mainApi) add('error', 'MAIN_API_BASE_URL manquant', 'Aucune source Movix ne peut répondre.');
  if (!o.movix.vipKeyConfigured) {
    add('error', 'Clé VIP absente', 'Movix ne résout plus aucun flux : seuls voe, darkibox et oneupload restent lisibles.');
  } else if (!o.movix.serverResolve) {
    add('warn', 'Résolution serveur désactivée', 'MOVIX_RESOLVE=false alors qu’une clé VIP est présente.');
  }
  if (!o.config.publicUrl) add('warn', 'PUBLIC_URL vide', 'Sous-titres proxifiés et proxy de flux inutilisables depuis un autre appareil.');
  if (o.streamProxy.enabled && !o.streamProxy.secretConfigured) {
    add('warn', 'STREAM_PROXY_SECRET vide', 'Le proxy de flux utilise un secret éphémère : les liens expirent au redémarrage.');
  }

  const breakers = { ...o.breakers.extraction, ...o.breakers.sonde };
  const open = Object.keys(breakers);
  if (open.length) add('warn', `${open.length} service(s) mis de côté par le disjoncteur`, open.join(', '));

  for (const addon of o.addons) {
    if (!addon.enabled && addon.reason === 'configuration incomplete') {
      add('warn', `Addon ${addon.name} inactif`, 'Configuration incomplète dans .env.');
    }
  }
  if (o.subtitles.enabled && o.subtitles.autosync && !o.subtitles.ffmpeg) {
    add('warn', 'ffmpeg introuvable', 'Le calage automatique des sous-titres est désactivé de fait.');
  }
  if (o.liveTv.enabled && o.liveTv.error) add('warn', 'TV en direct indisponible', o.liveTv.error);

  const { simkl, trakt } = o.trackers;
  if (simkl.configured && !simkl.authenticated) add('warn', 'Simkl non connecté', 'Lance la connexion depuis Synchro.', '/synchro');
  if (simkl.paused) add('warn', 'Simkl en pause', simkl.reason || `jusqu'à ${formatDate(simkl.pausedUntil)}`, '/synchro');
  if (trakt.configured && !trakt.authenticated) add('warn', 'Trakt non connecté', 'Lance la connexion depuis Synchro.', '/synchro');

  const last = o.hub.lastRun;
  if (o.hub.enabled && last?.summary?.ok === false) {
    const errors = Object.entries(last.summary.errors || {});
    add('error', 'Le dernier cycle du hub a échoué', errors.map(([k, v]) => `${k}: ${v}`).join(' — ') || 'voir le journal', '/synchro');
  }
  return checks;
}

function Hero({ data, checks, onRefresh, loading, at }) {
  const errors = checks.filter((c) => c.tone === 'error').length;
  const warnings = checks.length - errors;
  const tone = errors ? 'error' : warnings ? 'warn' : 'ok';
  const title = errors
    ? `${errors} problème${errors > 1 ? 's' : ''} à corriger`
    : warnings
      ? `${warnings} point${warnings > 1 ? 's' : ''} d'attention`
      : 'Tout fonctionne';
  return html`<div class=${`hero hero-${tone}`}>
    <div class="hero-glow"></div>
    <div class="hero-main">
      <div class="hero-status"><${Dot} tone=${tone} pulse /> <span>${title}</span></div>
      <p class="hero-sub">
        Addon v${data.process.version} · en ligne depuis ${formatDuration(data.process.uptimeSeconds)} · Node ${data.process.node}
      </p>
    </div>
    <div class="hero-actions">
      <span class="muted small">Actualisé ${timeAgo(at)}</span>
      <${Button} icon="refresh" loading=${loading} onClick=${onRefresh}>Actualiser</${Button}>
    </div>
  </div>`;
}

function Checks({ checks }) {
  if (!checks.length) return null;
  return html`<div class="checks">
    ${checks.map(
      (c) => html`<div class=${`check check-${c.tone}`}>
        <${Icon} name="alert" size=${16} />
        <div class="check-text"><strong>${c.title}</strong><span>${c.detail}</span></div>
        ${c.link && html`<${Button} size="sm" variant="ghost" icon="chevronRight" onClick=${() => navigate(c.link)}></${Button}>`}
      </div>`,
    )}
  </div>`;
}

function Services({ services }) {
  return html`<div class="service-list">
    ${services.map(
      (s) => html`<div class="service">
        <${Dot} tone=${!s.ok ? 'error' : s.ms > 2500 ? 'warn' : 'ok'} />
        <span class="service-name">${s.name}</span>
        <span class="service-meta">${s.ok ? `${s.ms} ms` : s.error || `HTTP ${s.status}`}</span>
      </div>`,
    )}
  </div>`;
}

function supportsOf(supports) {
  const kinds = Array.isArray(supports) ? supports : Object.keys(supports || {}).filter((k) => supports[k]);
  return kinds.map((k) => ({ movie: 'films', series: 'séries' })[k] || k).join(' · ');
}

function Sources({ data }) {
  return html`
    <div class="subhead">Sources Movix <span class="muted">(${data.sources.length})</span></div>
    <div class="chips">${data.sources.map((name) => html`<${Badge} tone="neutral">${name}</${Badge}>`)}</div>
    <div class="subhead">Addons autonomes</div>
    <div class="addon-list">
      ${data.addons.map(
        (a) => html`<div class="addon">
          <${Dot} tone=${a.enabled ? 'ok' : a.reason === 'configuration incomplete' ? 'warn' : 'neutral'} />
          <div class="addon-text">
            <strong>${a.name}</strong>
            <span class="muted small">${a.enabled ? supportsOf(a.supports) : a.reason}</span>
          </div>
          <${Badge} tone=${a.enabled ? 'ok' : 'neutral'}>${a.enabled ? 'actif' : 'inactif'}</${Badge}>
        </div>`,
      )}
    </div>`;
}

function Breakers({ breakers }) {
  const rows = [
    ...Object.entries(breakers.extraction).map(([k, v]) => ['Extraction', k, v]),
    ...Object.entries(breakers.sonde).map(([k, v]) => ['Sonde', k, v]),
  ];
  if (!rows.length) {
    return html`<${Empty} icon="shield" title="Aucun service écarté">Tous les hébergeurs et voies de mesure sont en service.</${Empty}>`;
  }
  return html`<div class="breaker-list">
    ${rows.map(
      ([kind, key, text]) => html`<div class="breaker">
        <${Badge} tone="warn">${kind}</${Badge}><strong>${key}</strong><span class="muted small">${text}</span>
      </div>`,
    )}
  </div>`;
}

function yesNo(value, { yes = 'oui', no = 'non', noTone = 'neutral' } = {}) {
  return html`<${Badge} tone=${value ? 'ok' : noTone}>${value ? yes : no}</${Badge}>`;
}

export function OverviewPage() {
  const { data, error, loading, reload, at } = useResource(() => api('overview'), [], { interval: 15000 });
  useTick(5000);

  if (!data && error) return html`<${ErrorBox} error=${error} onRetry=${reload} />`;
  if (!data) {
    return html`<div class="grid">
      <div class="span-full"><${Skeleton} lines=${2} height=${40} /></div>
      ${[1, 2, 3, 4].map(() => html`<${Card}><${Skeleton} lines=${4} /></${Card}>`)}
    </div>`;
  }

  const checks = checksOf(data);
  const hubLast = data.hub.lastRun;
  const trackers = data.trackers;

  return html`<div class="page">
    <${Hero} data=${data} checks=${checks} onRefresh=${reload} loading=${loading} at=${at} />
    ${error && html`<${ErrorBox} error=${error} onRetry=${reload} />`}
    <${Checks} checks=${checks} />

    <div class="stats">
      <${Stat} icon="layers" label="Sources" value=${data.sources.length + data.addons.filter((a) => a.enabled).length}
        hint=${`${data.sources.length} Movix · ${data.addons.filter((a) => a.enabled).length} addons`} />
      <${Stat} icon="cpu" label="Mémoire" value=${formatBytes(data.process.rssBytes)} hint=${`tas ${formatBytes(data.process.heapBytes)}`} />
      <${Stat} icon="shield" label="Disjoncteurs" value=${Object.keys({ ...data.breakers.extraction, ...data.breakers.sonde }).length}
        hint="services écartés" tone=${Object.keys({ ...data.breakers.extraction, ...data.breakers.sonde }).length ? 'warn' : undefined} />
      <${Stat} icon="sync" label="Hub" value=${data.hub.enabled ? (data.hub.running ? 'en cours' : 'actif') : 'arrêté'}
        hint=${hubLast ? `dernier cycle ${timeAgo(hubLast.at)}` : 'aucun cycle depuis le démarrage'}
        tone=${hubLast?.summary?.ok === false ? 'error' : undefined} />
    </div>

    <div class="grid">
      <${Card} title="Installation" icon="link" class="span-2">
        <div class="manifest">
          <code>${data.config.manifestUrl}</code>
          <div class="manifest-actions">
            <${CopyButton} text=${data.config.manifestUrl} label="Copier" />
            <a class="btn btn-ghost btn-sm" href=${data.config.manifestUrl.replace(/^https?:/, 'stremio:')}>
              <${Icon} name="external" size=${15} /><span>Ouvrir dans Stremio</span>
            </a>
          </div>
        </div>
        <${KeyValue} rows=${[
          ['Format des ids', html`<code>${data.config.idFormat}</code>`],
          ['Liste des flux', html`<code>${data.config.streamList}</code>`],
          ['Langue TMDB', html`<code>${data.config.tmdbLanguage}</code>`],
        ]} />
      </${Card}>

      <${Card} title="Services amont" icon="server">
        <${Services} services=${data.services} />
        <${KeyValue} rows=${[
          ['Clé VIP', yesNo(data.movix.vipKeyConfigured, { yes: 'présente', no: 'absente', noTone: 'error' })],
          ['Résolution serveur', yesNo(data.movix.serverResolve, { yes: 'active', no: 'inactive', noTone: 'warn' })],
          ['Compte Movix', yesNo(data.movix.accountConfigured, { yes: 'configuré', no: 'non configuré' })],
        ]} />
      </${Card}>

      <${Card} title="Sources & addons" icon="layers" class="span-2">
        <${Sources} data=${data} />
      </${Card}>

      <${Card} title="Disjoncteurs" icon="shield">
        <${Breakers} breakers=${data.breakers} />
      </${Card}>

      <${Card} title="Lecture" icon="play">
        <${KeyValue} rows=${[
          ['Proxy de flux', yesNo(data.streamProxy.enabled, { yes: 'actif', no: 'inactif' })],
          data.streamProxy.enabled && ['Secret du proxy', yesNo(data.streamProxy.secretConfigured, { yes: 'fixe', no: 'éphémère', noTone: 'warn' })],
          ['Sous-titres', yesNo(data.subtitles.enabled, { yes: data.subtitles.providers.join(', '), no: 'désactivés' })],
          ['Calage auto', yesNo(data.subtitles.autosync && data.subtitles.ffmpeg, { yes: 'actif', no: data.subtitles.autosync ? 'ffmpeg absent' : 'désactivé', noTone: data.subtitles.autosync ? 'warn' : 'neutral' })],
          ['TV en direct', data.liveTv.enabled
            ? data.liveTv.error
              ? html`<${Badge} tone="warn">${data.liveTv.error}</${Badge}>`
              : html`<${Badge} tone="ok">${data.liveTv.catalogs} catalogues</${Badge}>`
            : html`<${Badge}>désactivée</${Badge}>`],
        ]} />
      </${Card}>

      <${Card} title="Trackers" icon="sync" actions=${html`<${Button} size="sm" variant="ghost" icon="chevronRight" onClick=${() => navigate('/synchro')}>Synchro</${Button}>`}>
        <${KeyValue} rows=${[
          ['Nuvio', trackers.nuvio.configured ? html`<${Badge} tone="ok">configuré</${Badge}> <span class="muted small">push ${formatInterval(trackers.nuvio.pushIntervalMs)}</span>` : html`<${Badge}>non configuré</${Badge}>`],
          ['Trakt', !trackers.trakt.configured ? html`<${Badge}>non configuré</${Badge}>` : yesNo(trackers.trakt.authenticated, { yes: 'connecté', no: 'non connecté', noTone: 'warn' })],
          ['Simkl', !trackers.simkl.configured ? html`<${Badge}>non configuré</${Badge}>` : trackers.simkl.paused ? html`<${Badge} tone="warn">en pause</${Badge}>` : yesNo(trackers.simkl.authenticated, { yes: 'connecté', no: 'non connecté', noTone: 'warn' })],
          trackers.simkl.viaProxy && ['Sortie Simkl', html`<code>${trackers.simkl.viaProxy}</code>`],
          ['Hub', data.hub.enabled ? html`<${Badge} tone="ok">${formatInterval(data.hub.intervalMs)}</${Badge}>` : html`<${Badge}>désactivé</${Badge}>`],
        ]} />
      </${Card}>

      <${Card} title="Stockage" icon="database">
        <${KeyValue} rows=${[
          ['Cache', data.storage.cache ? `${formatBytes(data.storage.cache.size)} · ${timeAgo(data.storage.cache.modifiedAt)}` : 'non persistant'],
          ['Instantané du hub', data.storage.hubState ? `${formatBytes(data.storage.hubState.size)} · ${timeAgo(data.storage.hubState.modifiedAt)}` : 'aucun'],
          ['Journal du hub', data.storage.journal ? `${formatBytes(data.storage.journal.size)} · ${timeAgo(data.storage.journal.modifiedAt)}` : 'aucun'],
          ['Démarré', formatDate(data.process.startedAt)],
        ]} />
      </${Card}>

      <div class="span-full"><${JsonView} data=${data} label="État brut (JSON)" /></div>
    </div>
  </div>`;
}
