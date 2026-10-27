import { html, useState, useMemo } from '../../vendor/preact-htm.js';
import { api, useResource, useLocalState, timeAgo, plural } from '../lib.js';
import { Badge, Button, Callout, Card, CopyButton, Dot, Empty, ErrorBox, Icon, Modal, Segmented, Skeleton, Stat, toast } from '../ui.js';
import { Player } from '../player.js';

const FILTERS = [
  { value: 'visible', label: 'Dans la playlist' },
  { value: 'hidden', label: 'Masquées' },
  { value: 'merged', label: 'Fusionnées' },
  { value: 'noguide', label: 'Sans guide' },
  { value: 'dead', label: 'Sans flux vivant' },
  { value: 'all', label: 'Toutes' },
];

const HIDDEN_LABEL = { user: 'masquée', group: 'thème masqué', dead: 'aucun flux vivant' };

function aliveCount(channel) {
  return channel.streams.filter((s) => s.ok === true).length;
}

function matches(channel, filter) {
  switch (filter) {
    case 'visible': return !channel.hidden;
    case 'hidden': return !!channel.hidden;
    case 'merged': return (channel.aliases || []).length > 0;
    case 'noguide': return !channel.tvgId;
    case 'dead': return channel.streams.every((s) => s.ok === false);
    default: return true;
  }
}

function fold(text) {
  return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function StreamState({ stream }) {
  if (stream.ok === true) return html`<span class="row gap-sm nowrap"><${Dot} tone="ok" />vivant</span>`;
  if (stream.ok === false) return html`<span class="row gap-sm nowrap"><${Dot} tone="error" />mort</span>`;
  return html`<span class="row gap-sm nowrap muted"><${Dot} />non testé</span>`;
}

/** Definition: ce que le flux annonce, et ce que la sonde a lu quand elle est passee. */
function Definition({ stream }) {
  if (!stream.height) return html`<span class="muted">${stream.announced ? `${stream.announced}p annoncé` : 'inconnue'}</span>`;
  const lied = !!stream.announced && Math.abs(stream.announced - stream.height) > 300;
  return html`<span class="nowrap" title=${lied ? `annoncé ${stream.announced}p` : ''}>
    ${stream.width}×${stream.height}<span class="muted"> ${stream.codec}</span>
    ${lied && html` <${Badge} tone="warn">annoncé ${stream.announced}p</${Badge}>`}
  </span>`;
}

function ChannelModal({ channel, data, act, onClose }) {
  const [target, setTarget] = useState('');
  const [name, setName] = useState(channel.name);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState(null);
  const [watching, setWatching] = useState(null);

  const others = useMemo(() => data.rows.filter((c) => c.key !== channel.key), [data, channel.key]);
  const targetKey = others.find((c) => c.name === target)?.key;
  const detached = data.edits.splits.includes(channel.key);
  const link = data.urls && `${data.urls.play}/${channel.key}.m3u8`;
  const mergedInto = data.edits.merges[channel.key];

  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      setResult(await api('iptv/test', { method: 'POST', body: { key: channel.key } }));
    } catch (error) {
      toast(error.message, { tone: 'error', title: 'Test impossible' });
    }
    setTesting(false);
  };

  // sid absent: la chaine, avec la meme bascule que dans un lecteur IPTV.
  const watch = async (sid) => {
    setWatching({ loading: true, sid });
    try {
      setWatching(await api('iptv/watch', { method: 'POST', body: { key: channel.key, sid } }));
    } catch (error) {
      setWatching(null);
      toast(error.message, { tone: 'error', title: 'Lecture impossible' });
    }
  };

  return html`<${Modal} title=${channel.name} icon="tv" wide onClose=${onClose}>
    <div class="row gap wrap">
      ${channel.hidden
        ? html`<${Badge} tone="warn">${HIDDEN_LABEL[channel.hidden]}</${Badge}>`
        : html`<${Badge} tone="ok">n° ${channel.num}</${Badge}>`}
      <${Badge}>${channel.group}</${Badge}>
      ${channel.tvgId ? html`<${Badge} tone="info">guide ${channel.tvgId}</${Badge}>` : html`<${Badge}>sans guide</${Badge}>`}
      <span class="grow"></span>
      <${Button} size="sm" variant="primary" icon="play" loading=${watching?.loading && !watching.sid} onClick=${() => watch()}>Regarder</${Button}>
      <${Button} size="sm" icon="zap" loading=${testing} onClick=${test}>Tester le zap</${Button}>
      <${Button} size="sm" variant="ghost" icon=${channel.hidden === 'user' ? 'eye' : 'eyeOff'}
        onClick=${() => act('hideChannel', { key: channel.key, hidden: channel.hidden !== 'user' })}>
        ${channel.hidden === 'user' ? 'Remettre dans la playlist' : 'Masquer'}
      </${Button}>
    </div>

    ${link && html`<div class="share-link top-gap">
      <span class="muted small">Lien de la chaîne, à ouvrir dans VLC ou un lecteur IPTV : il bascule seul sur un flux vivant.</span>
      <div class="row gap-sm">
        <code class="url grow">${link}</code>
        <${CopyButton} text=${link} label="Copier" />
        ${navigator.share && html`<${Button} size="sm" variant="ghost" icon="external"
          onClick=${() => navigator.share({ title: channel.name, url: link }).catch(() => {})}>Partager</${Button}>`}
      </div>
    </div>`}

    ${watching?.url && html`<div class="top-gap">
      <div class="row gap"><span class="muted small">En lecture : ${watching.label}</span><span class="grow"></span>
        <${Button} size="sm" variant="ghost" icon="x" onClick=${() => setWatching(null)}>Fermer le lecteur</${Button}></div>
      <${Player} src=${watching.url} />
    </div>`}

    ${result && html`<${Callout} tone=${result.chosen ? 'ok' : 'error'} title=${result.chosen ? `Flux retenu : ${result.chosen.label}` : 'Aucun flux ne répond'}>
      ${result.ms} ms${result.host ? ` · ${result.host}` : ''} · essais :
      ${result.tried.map((t) => html` <span class=${t.ok ? 'tone-ok' : 'muted'}>${t.ok ? '✓' : '✗'} ${t.label}${t.trusted ? ' (déjà vérifié)' : ''}</span>`)}
    </${Callout}>`}

    <h4 class="subhead top-gap">Flux, dans l'ordre où ils sont essayés</h4>
    <div class="table-wrap">
      <table class="table table-compact streams-table">
        <thead><tr><th>#</th><th>Flux</th><th>Nom d'origine</th><th>Définition</th><th>État</th><th></th></tr></thead>
        <tbody>
          ${channel.streams.map((s, i) => html`<tr key=${s.sid}>
            <td class="muted">${i + 1}</td>
            <td class="nowrap">${s.label}${s.preferred && html` <${Badge} tone="accent">forcé</${Badge}>`}</td>
            <td class="muted">${s.raw}</td>
            <td><${Definition} stream=${s} /></td>
            <td><${StreamState} stream=${s} />${s.checkedAt && html`<div class="muted small">${timeAgo(s.checkedAt)}</div>`}</td>
            <td class="nowrap">
              <${Button} size="sm" variant="ghost" icon="star" title=${s.preferred ? 'Ne plus forcer' : 'Forcer en premier'}
                onClick=${() => act('prefer', { key: channel.key, sid: s.preferred ? null : s.sid })}>
                ${s.preferred ? 'Ne plus forcer' : 'Forcer en premier'}
              </${Button}>
              <${Button} size="sm" variant="ghost" icon="play" title="Regarder ce flux" loading=${watching?.loading && watching.sid === s.sid}
                onClick=${() => watch(s.sid)} />
              ${link && html`<${CopyButton} text=${`${data.urls.play}/${channel.key}/${s.sid}.m3u8`} />`}
            </td>
          </tr>`)}
        </tbody>
      </table>
    </div>

    <div class="channel-edit top-gap">
      <label class="edit-field"><span>Nom</span>
        <input value=${name} onInput=${(e) => setName(e.target.value)} />
        <${Button} size="sm" disabled=${name.trim() === channel.name || !name.trim()}
          onClick=${() => act('rename', { key: channel.key, name: name.trim() })}>Renommer</${Button}>
      </label>
      <label class="edit-field"><span>Thème</span>
        <select value=${channel.group} onChange=${(e) => act('group', { key: channel.key, group: e.target.value })}>
          ${data.groups.map((g) => html`<option value=${g}>${g}</option>`)}
        </select>
      </label>
      <label class="edit-field"><span>Fusionner dans</span>
        <input list="channel-names" value=${target} onInput=${(e) => setTarget(e.target.value)} placeholder="nom d'une autre chaîne…" />
        <datalist id="channel-names">${others.map((c) => html`<option value=${c.name} />`)}</datalist>
        <${Button} size="sm" icon="link" disabled=${!targetKey}
          onClick=${() => act('merge', { key: channel.key, into: targetKey }).then(onClose)}>Fusionner</${Button}>
      </label>
    </div>

    ${(channel.aliases || []).length > 0 && html`
      <h4 class="subhead top-gap">Écritures regroupées dans cette chaîne</h4>
      <div class="chips">
        ${channel.aliases.map((alias) => html`<span class="alias">
          <code>${alias}</code>
          <button class="chip-btn chip-sm" onClick=${() => act('split', { key: alias })} title="En refaire une chaîne à part">détacher</button>
        </span>`)}
      </div>`}

    ${(detached || mergedInto) && html`<${Callout} tone="info" title="Retouche manuelle">
      ${detached && html`Cette chaîne a été détachée à la main : la fusion automatique ne la reprend plus.
        <${Button} size="sm" variant="ghost" icon="undo" onClick=${() => act('unsplit', { key: channel.key }).then(onClose)}>Laisser refusionner</${Button}>`}
    </${Callout}>`}
  </${Modal}>`;
}

function Urls({ urls }) {
  if (!urls) return null;
  const rows = [
    ['Xtream · serveur', urls.xtream.server],
    ['Xtream · mot de passe', urls.xtream.password],
    ['Playlist M3U', urls.m3u],
    ['Playlist détaillée', urls.m3uAll],
    ['Guide XMLTV', urls.epg],
  ];
  return html`<div class="url-list">
    ${rows.map(([label, value]) => html`<div class="url-row">
      <span class="muted">${label}</span><code class="url">${value}</code><${CopyButton} text=${value} />
    </div>`)}
    ${!urls.tokenShown && html`<div class="muted small">Le jeton n'est affiché que si la WebUI est protégée par WEBUI_PASSWORD ; il est dans <code>.env</code> (IPTV_TOKEN).</div>`}
  </div>`;
}

export function ChannelsPage({ params }) {
  const { data, error, loading, reload } = useResource(() => api('iptv'), [], { interval: 20000 });
  const [filter, setFilter] = useLocalState('channels.filter', 'visible');
  const [group, setGroup] = useState(null);
  const [query, setQuery] = useState('');
  // `#/chaines?c=tf1` ouvre directement la fiche d'une chaine.
  const [openKey, setOpenKey] = useState(params?.c || null);
  const [busy, setBusy] = useState(null);
  const [limit, setLimit] = useState(150);

  const act = async (action, payload) => {
    try {
      await api('iptv/override', { method: 'POST', body: { action, ...payload } });
      await reload();
    } catch (err) {
      toast(err.message, { tone: 'error', title: 'Retouche refusée' });
    }
  };

  const run = async (name, label) => {
    setBusy(name);
    try {
      await api(`iptv/${name}`, { method: 'POST' });
      toast(label, { tone: 'ok' });
      await reload();
    } catch (err) {
      toast(err.message, { tone: 'error' });
    }
    setBusy(null);
  };

  const rows = data?.rows || [];
  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.value, rows.filter((c) => matches(c, f.value)).length])), [rows]);
  const groupCounts = useMemo(() => {
    const map = new Map();
    for (const c of rows) map.set(c.group, (map.get(c.group) || 0) + 1);
    return map;
  }, [rows]);

  const shown = useMemo(() => {
    const q = fold(query);
    return rows.filter(
      (c) =>
        matches(c, filter) &&
        (!group || c.group === group) &&
        (!q || fold(c.name).includes(q) || c.key.includes(q) || (c.aliases || []).some((a) => a.includes(q))),
    );
  }, [rows, filter, group, query]);

  if (error && !data) return html`<div class="page"><${ErrorBox} error=${error} onRetry=${reload} /></div>`;
  if (loading && !data) return html`<div class="page"><${Card} title="Chaînes" icon="tv"><${Skeleton} lines=${6} /></${Card}></div>`;
  if (!data.enabled) {
    return html`<div class="page"><${Empty} icon="tv" title="Playlist IPTV désactivée">
      Renseigner <code>IPTV_ENABLED=true</code> et <code>IPTV_TOKEN</code> dans <code>.env</code>, puis redémarrer.
    </${Empty}></div>`;
  }

  const sweep = data.sweep;
  const open = openKey && rows.find((c) => c.key === openKey);
  const hiddenGroups = data.edits.hiddenGroups;

  return html`<div class="page">
    <${Card} title="Playlist IPTV" icon="tv" actions=${html`
      <${Button} size="sm" variant="ghost" icon="refresh" loading=${busy === 'refresh'} onClick=${() => run('refresh', 'Sources relues')}>Relire les sources</${Button}>
      <${Button} size="sm" icon="activity" loading=${busy === 'sweep'} disabled=${sweep.running} onClick=${() => run('sweep', 'Ronde lancée')}>
        ${sweep.running ? `Ronde ${sweep.progress ? `${sweep.progress.done}/${sweep.progress.total}` : '…'}` : 'Tester tous les flux'}
      </${Button}>`}>
      <div class="stats">
        <${Stat} label="Chaînes" value=${data.channels} hint=${data.hidden ? plural(data.hidden, 'masquée') : `${data.withGuide} avec guide`} icon="tv" />
        <${Stat} label="Flux" value=${data.streams} hint=${`classés par ${data.rankBy === 'source' ? 'source (IPTV d\'abord)' : 'définition'}`} icon="layers" />
        <${Stat} label="Vivants" value=${data.alive} tone=${data.dead > data.alive ? 'warn' : 'ok'} hint=${`${plural(data.dead, 'mort')} · ${data.streams - data.alive - data.dead} non testés`} icon="activity" />
        <${Stat} label="Définition mesurée" value=${data.measured} hint=${sweep.lastSweepAt ? `dernière ronde ${timeAgo(sweep.lastSweepAt)}` : 'aucune ronde encore'} icon="search" />
      </div>
      <${Urls} urls=${data.urls} />
    </${Card}>

    <${Card} pad=${false}>
      <div class="tabbar channels-toolbar">
        <div class="row gap wrap">
          <${Segmented} size="sm" value=${filter} onChange=${(v) => { setFilter(v); setLimit(150); }}
            options=${FILTERS.map((f) => ({ ...f, count: counts[f.value] }))} />
          <div class="search-input search-sm">
            <${Icon} name="search" size=${15} />
            <input value=${query} onInput=${(e) => { setQuery(e.target.value); setLimit(150); }} placeholder="Chercher une chaîne…" aria-label="Chercher une chaîne" />
          </div>
        </div>
        <div class="chips top-gap-sm">
          <button class=${`chip-btn chip-sm${!group ? ' active' : ''}`} onClick=${() => setGroup(null)}>tous les thèmes</button>
          ${data.groups.filter((g) => groupCounts.has(g)).map((g) => {
            const off = hiddenGroups.includes(g);
            return html`<span class="group-chip">
              <button class=${`chip-btn chip-sm${group === g ? ' active' : ''}${off ? ' is-off' : ''}`} onClick=${() => setGroup(group === g ? null : g)}>
                ${g}<span class="muted"> ${groupCounts.get(g)}</span>
              </button>
              <button class="icon-btn icon-btn-sm" title=${off ? 'Remettre ce thème dans la playlist' : 'Retirer ce thème de la playlist'}
                onClick=${() => act('hideGroup', { group: g, hidden: !off })}>
                <${Icon} name=${off ? 'eyeOff' : 'eye'} size=${14} />
              </button>
            </span>`;
          })}
        </div>
      </div>

      ${shown.length === 0
        ? html`<${Empty} icon="tv" title="Aucune chaîne ne correspond" />`
        : html`<div class="table-wrap table-flush">
          <table class="table table-compact channels-table">
            <thead><tr><th>N°</th><th>Chaîne</th><th class="hide-sm">Thème</th><th class="hide-sm">Guide</th><th>Flux</th><th class="hide-sm">Premier flux</th><th></th></tr></thead>
            <tbody>
              ${shown.slice(0, limit).map((c) => {
                const alive = aliveCount(c);
                const tested = c.streams.filter((s) => s.ok !== null).length;
                const first = c.streams[0];
                return html`<tr key=${c.key} class=${c.hidden ? 'is-hidden' : ''} onClick=${() => setOpenKey(c.key)}>
                  <td class="muted">${c.num || '—'}</td>
                  <td>
                    <div class="channel-cell">
                      ${c.logo ? html`<img src=${c.logo} alt="" loading="lazy" />` : html`<span class="logo-fallback"><${Icon} name="tv" size=${14} /></span>`}
                      <span>
                        <strong>${c.name}</strong>
                        ${c.hidden && html` <${Badge} tone="warn">${HIDDEN_LABEL[c.hidden]}</${Badge}>`}
                        ${(c.aliases || []).length > 0 && html`<div class="muted small">+ ${c.aliases.join(', ')}</div>`}
                      </span>
                    </div>
                  </td>
                  <td class="muted nowrap hide-sm">${c.group}</td>
                  <td class="hide-sm">${c.tvgId ? html`<${Dot} tone="ok" />` : html`<span class="muted">—</span>`}</td>
                  <td class="nowrap">
                    ${c.streams.length}
                    ${tested > 0 && html`<span class=${alive === 0 ? 'err-line' : 'muted'}> · ${plural(alive, 'vivant')}</span>`}
                  </td>
                  <td class="nowrap hide-sm">${first?.label}${first?.preferred && html` <${Badge} tone="accent">forcé</${Badge}>`}</td>
                  <td class="nowrap" onClick=${(e) => e.stopPropagation()}>
                    <button class="icon-btn icon-btn-sm" title=${c.hidden === 'user' ? 'Remettre dans la playlist' : 'Masquer'}
                      onClick=${() => act('hideChannel', { key: c.key, hidden: c.hidden !== 'user' })}>
                      <${Icon} name=${c.hidden === 'user' ? 'eyeOff' : 'eye'} size=${15} />
                    </button>
                  </td>
                </tr>`;
              })}
            </tbody>
          </table>
        </div>`}
      ${shown.length > limit && html`<div class="center pad">
        <${Button} variant="ghost" onClick=${() => setLimit(limit + 300)}>Afficher la suite (${shown.length - limit} restantes)</${Button}>
      </div>`}
    </${Card}>

    ${data.edits.count > 0 && html`<div class="row gap muted small">
      ${plural(data.edits.count, 'retouche manuelle', 'retouches manuelles')} en place.
      <${Button} size="sm" variant="ghost" icon="undo" onClick=${() => confirm('Annuler toutes les retouches manuelles ?') && act('reset', {})}>Tout annuler</${Button}>
    </div>`}

    ${open && html`<${ChannelModal} key=${open.key} channel=${open} data=${data} act=${act} onClose=${() => setOpenKey(null)} />`}
  </div>`;
}
