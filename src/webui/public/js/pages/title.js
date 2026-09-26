import { html, useState, useEffect, useRef } from '../../vendor/preact-htm.js';
import { api, useResource, navigate, formatBitrate, formatBytes, plural } from '../lib.js';
import {
  Card, Badge, Button, Skeleton, ErrorBox, Empty, Segmented, Icon, JsonView, KeyValue, Meter, CopyButton, Spinner, Callout,
} from '../ui.js';

const DIRECT_ID = /^(tt\d{5,}|tmdb:\d+)$/i;

// --- Recherche -----------------------------------------------------------------------
function SearchBar({ initial, type, onSearch }) {
  const [query, setQuery] = useState(initial || '');
  const inputRef = useRef(null);
  useEffect(() => setQuery(initial || ''), [initial]);
  useEffect(() => {
    if (!initial) inputRef.current?.focus();
  }, []);

  const submit = (e) => {
    e.preventDefault();
    onSearch(query.trim(), type);
  };
  return html`<form class="searchbar" onSubmit=${submit}>
    <div class="search-input">
      <${Icon} name="search" />
      <input ref=${inputRef} value=${query} onInput=${(e) => setQuery(e.target.value)}
        placeholder="Titre, id IMDb (tt0816692) ou TMDB (tmdb:157336)…" aria-label="Rechercher un titre" />
    </div>
    <${Segmented} value=${type} onChange=${(t) => onSearch(query.trim(), t)} options=${[
      { value: 'all', label: 'Tout' },
      { value: 'movie', label: 'Films', icon: 'film' },
      { value: 'series', label: 'Séries', icon: 'tv' },
    ]} />
    <${Button} type="submit" variant="primary" icon="search">Chercher</${Button}>
  </form>`;
}

function Results({ query, type }) {
  const { data, error, loading, reload } = useResource(
    () => api('search', { query: { q: query, type: type === 'all' ? undefined : type } }),
    [query, type],
  );
  if (DIRECT_ID.test(query)) {
    const kinds = type === 'all' ? ['movie', 'series'] : [type];
    return html`<${Card}>
      <div class="direct-id">
        <div><strong>Identifiant direct</strong> <code>${query}</code></div>
        <div class="row gap">
          ${kinds.map((k) => html`<${Button} variant="primary" icon=${k === 'movie' ? 'film' : 'tv'}
            onClick=${() => navigate('/titre', { type: k, id: query.toLowerCase().startsWith('tt') ? query : query.toLowerCase() })}>
            Diagnostiquer comme ${k === 'movie' ? 'film' : 'série'}</${Button}>`)}
        </div>
      </div>
    </${Card}>`;
  }
  if (error) return html`<${ErrorBox} error=${error} onRetry=${reload} />`;
  if (loading && !data) {
    return html`<div class="poster-grid">${Array.from({ length: 12 }, () => html`<div class="poster skeleton-poster"></div>`)}</div>`;
  }
  if (!data?.length) return html`<${Empty} icon="search" title="Aucun résultat">Essaie un autre titre, ou un id IMDb/TMDB.</${Empty}>`;
  return html`<div class="poster-grid">
    ${data.map(
      (item) => html`<button class="poster" onClick=${() => navigate('/titre', { type: item.type, id: item.id })} title=${item.title}>
        <div class="poster-img">
          ${item.poster ? html`<img src=${item.poster} alt="" loading="lazy" />` : html`<div class="poster-fallback"><${Icon} name=${item.type === 'movie' ? 'film' : 'tv'} size=${28} /></div>`}
          <span class="poster-type">${item.type === 'movie' ? 'Film' : 'Série'}</span>
          ${item.rating && html`<span class="poster-rating">★ ${item.rating}</span>`}
        </div>
        <div class="poster-title">${item.title}</div>
        <div class="poster-year">${item.year || '—'}</div>
      </button>`,
    )}
  </div>`;
}

// --- Fiche + choix de l'episode --------------------------------------------------------
function tmdbIdOf(id) {
  const match = /^tmdb:(\d+)/i.exec(id);
  return match ? match[1] : null;
}

function TitleHeader({ info, type, id }) {
  if (!info) {
    return html`<div class="title-hero"><div class="title-hero-body"><${Skeleton} lines=${3} /></div></div>`;
  }
  return html`<div class="title-hero" style=${info.backdrop ? `--backdrop:url('${info.backdrop}')` : ''}>
    <div class="title-hero-body">
      ${info.poster && html`<img class="title-poster" src=${info.poster} alt="" />`}
      <div class="title-meta">
        <div class="row gap wrap">
          <${Badge} tone="accent">${type === 'movie' ? 'Film' : 'Série'}</${Badge}>
          ${info.year && html`<${Badge}>${info.year}</${Badge}>`}
          ${info.runtime && html`<${Badge}>${info.runtime} min</${Badge}>`}
          ${info.rating && html`<${Badge}>★ ${info.rating}</${Badge}>`}
          <${Badge}><code>${id}</code></${Badge}>
        </div>
        <h1>${info.title}</h1>
        ${info.originalTitle && info.originalTitle !== info.title && html`<div class="muted">${info.originalTitle}</div>`}
        ${info.genres?.length > 0 && html`<div class="muted small">${info.genres.join(' · ')}</div>`}
        <p class="title-overview">${info.overview}</p>
      </div>
    </div>
  </div>`;
}

function EpisodePicker({ tmdbId, seasons, season, episode, onPick }) {
  const current = season || seasons[0]?.number;
  const { data: episodes, loading } = useResource(
    () => (current ? api(`tmdb/series/${tmdbId}/season/${current}`) : Promise.resolve([])),
    [tmdbId, current],
  );
  if (!seasons.length) return null;
  return html`<${Card} title="Épisode" icon="tv">
    <div class="season-tabs">
      ${seasons.map(
        (s) => html`<button class=${`chip-btn${s.number === current ? ' active' : ''}`} onClick=${() => onPick(s.number, null)}>
          S${s.number}<span class="muted small"> · ${s.episodes}</span>
        </button>`,
      )}
    </div>
    ${loading && !episodes
      ? html`<${Skeleton} lines=${2} />`
      : html`<div class="episode-grid">
          ${(episodes || []).map(
            (e) => html`<button class=${`episode${Number(episode) === e.number && Number(season) === current ? ' active' : ''}`}
              onClick=${() => onPick(current, e.number)} title=${e.name}>
              <span class="episode-num">E${e.number}</span>
              <span class="episode-name">${e.name}</span>
            </button>`,
          )}
        </div>`}
  </${Card}>`;
}

// --- Diagnostic ------------------------------------------------------------------------
function useDiagnostic(path, enabled) {
  return useResource(() => (enabled ? api(path) : Promise.resolve(null)), [path, enabled]);
}

function tierTone(tier) {
  if (!tier) return 'neutral';
  if (/2160|4k/i.test(tier)) return 'accent';
  if (/1080/.test(tier)) return 'ok';
  if (/720/.test(tier)) return 'info';
  return 'neutral';
}

function StreamsTab({ state }) {
  const { data, error, loading, reload } = state;
  if (error) return html`<${ErrorBox} error=${error} onRetry=${reload} />`;
  if (!data) return html`<div class="loading-block"><${Spinner} /> Résolution et mesure des flux… (peut prendre une trentaine de secondes)</div>`;
  if (!data.streams.length) {
    return html`<${Empty} icon="alert" title="Aucun flux résolu">Regarde les onglets Liens bruts et Extraction pour trouver où ça coince.</${Empty}>`;
  }
  return html`
    <div class="row gap wrap tab-intro">
      <${Badge} tone="ok">${plural(data.total, 'flux résolu', 'flux résolus')}</${Badge}>
      <${Badge} tone="accent">${data.affichesDansNuvio} affichés dans Nuvio</${Badge}>
      <${Badge}>mode ${data.mode}</${Badge}>
      ${Object.keys(data.ecartes || {}).length > 0 && html`<${Badge} tone="warn">sonde : ${Object.keys(data.ecartes).join(', ')} écarté(s)</${Badge}>`}
      <span class="grow"></span>
      <${Button} size="sm" variant="ghost" icon="refresh" loading=${loading} onClick=${reload}>Relancer</${Button}>
    </div>
    <div class="table-wrap">
      <table class="table">
        <thead><tr><th>Source</th><th>Qualité</th><th>Débit</th><th>Taille</th><th>Proxy</th><th>Cible</th></tr></thead>
        <tbody>
          ${data.streams.map(
            (s) => html`<tr>
              <td><strong>${s.source}</strong></td>
              <td>
                <${Badge} tone=${tierTone(s.palier)}>${s.palier ? (/^\d+$/.test(String(s.palier)) ? `${s.palier}p` : s.palier) : s.qualiteAnnoncee || '?'}</${Badge}>
                ${s.resolution && html`<div class="muted small">${s.resolution} · ${s.origineResolution}</div>`}
              </td>
              <td class="nowrap">${formatBitrate(s.debitBps)}<div class="muted small">${s.origineDebit}${s.segmentsPeses ? ` · ${s.segmentsPeses} seg.` : ''}</div></td>
              <td class="nowrap">${s.tailleOctets ? formatBytes(s.tailleOctets) : '—'}</td>
              <td>${s.proxifie ? html`<${Icon} name="shield" size=${15} class="tone-ok" />` : html`<span class="muted">—</span>`}</td>
              <td><div class="cell-url"><span class="url" title=${s.cible}>${s.cible}</span><${CopyButton} text=${s.cible} /></div></td>
            </tr>`,
          )}
        </tbody>
      </table>
    </div>
    <${JsonView} data=${data} />`;
}

function LinksTab({ state }) {
  const { data, error, reload } = state;
  if (error) return html`<${ErrorBox} error=${error} onRetry=${reload} />`;
  if (!data) return html`<div class="loading-block"><${Spinner} /> Interrogation des sources…</div>`;
  if (!data.links.length) return html`<${Empty} icon="alert" title="Aucune source n'a renvoyé de lien">Le titre est peut-être absent de Movix, ou les sources sont en panne.</${Empty}>`;

  const bySource = new Map();
  for (const link of data.links) {
    if (!bySource.has(link.source)) bySource.set(link.source, []);
    bySource.get(link.source).push(link);
  }
  return html`
    <div class="row gap wrap tab-intro">
      <${Badge} tone="ok">${plural(data.total, 'lien')}</${Badge}>
      <${Badge}>${plural(bySource.size, 'source')}</${Badge}>
      ${data.links.filter((l) => l.hoster === 'AUCUN EXTRACTEUR').length > 0 &&
      html`<${Badge} tone="error">${data.links.filter((l) => l.hoster === 'AUCUN EXTRACTEUR').length} sans extracteur</${Badge}>`}
    </div>
    <div class="source-groups">
      ${[...bySource].map(
        ([source, links]) => html`<details class="source-group" open=${bySource.size <= 4}>
          <summary><${Icon} name="chevronRight" size=${14} class="json-caret" /><strong>${source}</strong><${Badge}>${links.length}</${Badge}></summary>
          <div class="link-rows">
            ${links.map(
              (l) => html`<div class="link-row">
                <${Badge} tone=${l.direct ? 'info' : l.hoster === 'AUCUN EXTRACTEUR' ? 'error' : 'neutral'}>${l.direct ? 'direct' : l.hoster}</${Badge}>
                ${l.lang && html`<${Badge} tone="accent">${l.lang}</${Badge}>`}
                ${l.quality && html`<${Badge}>${l.quality}</${Badge}>`}
                <span class="url" title=${l.url}>${l.url}</span>
                <${CopyButton} text=${l.url} />
              </div>`,
            )}
          </div>
        </details>`,
      )}
    </div>
    <${JsonView} data=${data} />`;
}

function ExtractTab({ state }) {
  const { data, error, reload } = state;
  if (error) return html`<${ErrorBox} error=${error} onRetry=${reload} />`;
  if (!data) return html`<div class="loading-block"><${Spinner} /> Extraction des embeds…</div>`;
  if (!data.total) return html`<${Empty} icon="check" title="Aucun embed à extraire">Tous les liens sont déjà directs ou résolus par Movix.</${Empty}>`;
  return html`
    <div class="row gap wrap tab-intro">
      <${Badge} tone=${data.extraits === data.total ? 'ok' : data.extraits ? 'warn' : 'error'}>${data.extraits}/${data.total} extraits</${Badge}>
      ${Object.entries(data.ecartes || {}).map(([k, v]) => html`<${Badge} tone="warn" title=${v}>${k} écarté</${Badge}>`)}
    </div>
    <div class="hoster-meters">
      ${Object.entries(data.parHebergeur).map(([hoster, ratio]) => {
        const [ok, total] = ratio.split('/').map(Number);
        return html`<div class="hoster-meter"><span>${hoster}</span><${Meter} value=${ok} total=${total} /><span class="muted small">${ratio}</span></div>`;
      })}
    </div>
    <div class="table-wrap">
      <table class="table">
        <thead><tr><th>Source</th><th>Hébergeur</th><th>Extracteur</th><th>Résultat</th></tr></thead>
        <tbody>
          ${data.liens.map(
            (l) => html`<tr>
              <td>${l.source}</td>
              <td>${l.hoster || html`<span class="muted">inconnu</span>`}</td>
              <td>${l.extracteur ? html`<${Badge} tone=${l.extracteur === 'local' ? 'info' : 'accent'}>${l.extracteur}</${Badge}>` : '—'}</td>
              <td>${l.ok
                ? html`<${Badge} tone="ok">ok</${Badge}>`
                : html`<${Badge} tone=${/server-only/.test(l.issue || '') ? 'warn' : 'error'}>${l.issue}</${Badge}>`}</td>
            </tr>`,
          )}
        </tbody>
      </table>
    </div>
    <${Callout} title="Lire les issues">
      <code>server-only</code> : extractible par Movix seulement (clé VIP ou résolution amont en cause) ·
      <code>no-extractor</code> : personne ne sait le lire · <code>cooldown</code> : hébergeur mis de côté par le disjoncteur.
    </${Callout}>
    <${JsonView} data=${data} />`;
}

function SubtitlesTab({ type, id, state }) {
  const { data, error, reload } = state;
  const [computed, setComputed] = useState(null);
  const [computing, setComputing] = useState(false);
  const [computeError, setComputeError] = useState(null);
  if (error) return html`<${ErrorBox} error=${error} onRetry=${reload} />`;
  if (!data) return html`<div class="loading-block"><${Spinner} /> Recherche des pistes…</div>`;

  const compute = async () => {
    setComputing(true);
    setComputeError(null);
    try {
      setComputed(await api(`title/${type}/${encodeURIComponent(id)}/subsync`, { query: { compute: 1 } }));
    } catch (err) {
      setComputeError(err);
    } finally {
      setComputing(false);
    }
  };
  const shown = computed || data;
  return html`
    <div class="grid grid-tight">
      <${Card} title="Pistes" icon="captions">
        ${shown.pistes.length
          ? html`<div class="chips">${shown.pistes.map((p) => html`<${Badge} tone="accent">${p.lang} <span class="muted">· ${p.fournisseur}</span></${Badge}>`)}</div>`
          : html`<${Empty} title="Aucune piste trouvée" />`}
      </${Card}>
      <${Card} title="Calage automatique" icon="gauge">
        <${KeyValue} rows=${[
          ['Activé', html`<${Badge} tone=${shown.actif ? 'ok' : 'neutral'}>${shown.actif ? 'oui' : 'non'}</${Badge}>`],
          ['ffmpeg', html`<${Badge} tone=${shown.ffmpegDisponible ? 'ok' : 'warn'}>${shown.ffmpegDisponible ? 'disponible' : 'absent'}</${Badge}>`],
          ['Liaison', html`<code>${String(shown.liaison)}</code>`],
          ['Seuil de confiance', html`<code>${String(shown.seuilConfiance)}</code>`],
          ['Flux retenu', shown.fluxRetenu ? html`${shown.fluxRetenu.libelle} ${!shown.fluxRetenu.certain && html`<${Badge} tone="warn">supposé</${Badge}>`}` : '—'],
        ]} />
        <div class="row gap top-gap">
          <${Button} icon="zap" loading=${computing} disabled=${!shown.pistes.length} onClick=${compute}>Calculer le calage</${Button}>
        </div>
        ${computeError && html`<${ErrorBox} error=${computeError} />`}
        ${computed?.calage && html`<${Callout} tone="ok" title=${`Piste ${computed.calage.piste}`}><pre class="pre-wrap">${computed.calage.resume}</pre></${Callout}>`}
        ${computed && !computed.calage && html`<${Callout} tone="warn">Aucun calage calculé (pas de flux ou de piste exploitable).</${Callout}>`}
      </${Card}>
    </div>
    ${shown.fluxConnus.length > 0 && html`<${Card} title="Flux connus pour ce contenu" icon="layers">
      <div class="link-rows">
        ${shown.fluxConnus.map((f) => html`<div class="link-row"><${Badge}>${f.id}</${Badge}><span>${f.libelle}</span></div>`)}
      </div>
    </${Card}>`}
    <${JsonView} data=${shown} />`;
}

function Diagnostic({ type, id }) {
  const encoded = encodeURIComponent(id);
  const streams = useDiagnostic(`title/${type}/${encoded}/streams`, true);
  const links = useDiagnostic(`title/${type}/${encoded}/links`, true);
  const extract = useDiagnostic(`title/${type}/${encoded}/extract`, true);
  const subs = useDiagnostic(`title/${type}/${encoded}/subsync`, true);
  const [tab, setTab] = useState('streams');

  const count = (state, pick) => (state.data ? pick(state.data) : state.error ? '!' : '…');
  return html`<${Card} pad=${false} class="diagnostic">
    <div class="tabbar">
      <${Segmented} value=${tab} onChange=${setTab} options=${[
        { value: 'streams', label: 'Flux', icon: 'play', count: count(streams, (d) => d.total) },
        { value: 'links', label: 'Liens bruts', icon: 'link', count: count(links, (d) => d.total) },
        { value: 'extract', label: 'Extraction', icon: 'zap', count: count(extract, (d) => `${d.extraits}/${d.total}`) },
        { value: 'subs', label: 'Sous-titres', icon: 'captions', count: count(subs, (d) => d.pistes.length) },
      ]} />
    </div>
    <div class="tab-body">
      ${tab === 'streams' && html`<${StreamsTab} state=${streams} />`}
      ${tab === 'links' && html`<${LinksTab} state=${links} />`}
      ${tab === 'extract' && html`<${ExtractTab} state=${extract} />`}
      ${tab === 'subs' && html`<${SubtitlesTab} type=${type} id=${id} state=${subs} />`}
    </div>
  </${Card}>`;
}

function TitleView({ type, id, season, episode }) {
  const tmdbId = tmdbIdOf(id);
  const { data: info, error } = useResource(
    () => (tmdbId ? api(`tmdb/${type}/${tmdbId}`) : Promise.resolve(null)),
    [type, tmdbId],
  );
  const needsEpisode = type === 'series' && !(season && episode);
  // Une serie se diagnostique episode par episode: l'id Stremio porte saison et episode.
  const fullId = type === 'series' && season && episode ? `${id.split(':').slice(0, id.startsWith('tt') ? 1 : 2).join(':')}:${season}:${episode}` : id;
  const pick = (s, e) => navigate('/titre', { type, id, s, e: e ?? undefined });

  return html`<div class="page">
    <div class="row gap">
      <${Button} variant="ghost" icon="undo" onClick=${() => history.back()}>Retour</${Button}>
    </div>
    ${error && html`<${ErrorBox} error=${error} />`}
    ${tmdbId ? html`<${TitleHeader} info=${info} type=${type} id=${fullId} />` : html`<${Callout} title=${id}>Identifiant IMDb : la fiche TMDB n'est pas affichée, le diagnostic l'est.</${Callout}>`}
    ${type === 'series' && tmdbId && info && html`<${EpisodePicker} tmdbId=${tmdbId} seasons=${info.seasons} season=${Number(season) || null} episode=${episode} onPick=${pick} />`}
    ${type === 'series' && !tmdbId && html`<${Card} title="Épisode">
      <form class="row gap" onSubmit=${(e) => { e.preventDefault(); const f = new FormData(e.target); pick(f.get('s'), f.get('e')); }}>
        <label class="field">Saison <input name="s" type="number" min="1" value=${season || 1} /></label>
        <label class="field">Épisode <input name="e" type="number" min="1" value=${episode || 1} /></label>
        <${Button} type="submit" variant="primary">Diagnostiquer</${Button}>
      </form>
    </${Card}>`}
    ${needsEpisode
      ? html`<${Empty} icon="tv" title="Choisis un épisode">Le diagnostic porte sur un épisode précis.</${Empty}>`
      : html`<${Diagnostic} key=${`${type}:${fullId}`} type=${type} id=${fullId} />`}
  </div>`;
}

export function TitlePage({ params }) {
  const type = params.type;
  const searchType = params.t || 'all';
  if (params.id && (type === 'movie' || type === 'series')) {
    return html`<${TitleView} type=${type} id=${params.id} season=${params.s} episode=${params.e} />`;
  }
  return html`<div class="page">
    <div class="page-intro">
      <h1>Testeur de titre</h1>
      <p class="muted">Ce que l'addon trouve pour un film ou un épisode : liens par source, extraction, flux mesurés, sous-titres.</p>
    </div>
    <${SearchBar} initial=${params.q} type=${searchType} onSearch=${(q, t) => navigate('/titre', { q, t: t === 'all' ? undefined : t })} />
    ${params.q
      ? html`<${Results} query=${params.q} type=${searchType} />`
      : html`<${Empty} icon="film" title="Cherche un titre pour commencer">Exemple : <a href="#/titre?q=Interstellar">Interstellar</a>, <a href="#/titre?q=tt0903747">tt0903747</a></${Empty}>`}
  </div>`;
}
