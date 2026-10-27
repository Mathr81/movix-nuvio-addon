import { html, useState, useEffect, useRef } from '../vendor/preact-htm.js';
import { formatBitrate, useTick } from './lib.js';
import { Callout, KeyValue } from './ui.js';

/**
 * Lecteur de diagnostic: la video, et a cote ce que le navigateur en lit (codecs,
 * definition, tampon, images perdues) avec le debit au fil de la lecture.
 *
 * hls.js (vendorise, ~540 Ko) n'est charge qu'a la premiere lecture.
 */
let hlsScript = null;
function loadHls() {
  hlsScript ||= new Promise((done, fail) => {
    const script = document.createElement('script');
    script.src = 'vendor/hls.min.js';
    script.onload = () => done(window.Hls);
    script.onerror = () => {
      hlsScript = null;
      fail(new Error('hls.js introuvable'));
    };
    document.head.append(script);
  });
  return hlsScript;
}

// Playlist ou fichier? On lit le debut: donner un mp4 de 2 Go a hls.js le ferait
// telecharger en entier comme du texte avant d'echouer.
async function isPlaylist(url) {
  const res = await fetch(url, { headers: { Range: 'bytes=0-63' } });
  if (!res.ok) throw new Error(`le flux répond HTTP ${res.status}`);
  if (/mpegurl/i.test(res.headers.get('content-type') || '')) {
    res.body?.cancel();
    return true;
  }
  const reader = res.body.getReader();
  const { value } = await reader.read();
  reader.cancel();
  return new TextDecoder().decode(value || new Uint8Array()).trimStart().startsWith('#EXTM3U');
}

const CODECS = [
  [/^(avc1|avc3)/, 'H.264'],
  [/^(hvc1|hev1)/, 'H.265'],
  [/^av01/, 'AV1'],
  [/^vp0?9/, 'VP9'],
  [/^(mp3|mp4a\.(6b|40\.34))/i, 'MP3'],
  [/^mp4a\.40\.(5|29)/, 'HE-AAC'],
  [/^mp4a/, 'AAC'],
  [/^ac-3/, 'AC-3'],
  [/^ec-3/, 'E-AC-3'],
  [/^opus/i, 'Opus'],
];

function codecName(codec) {
  if (!codec) return '—';
  const hit = CODECS.find(([re]) => re.test(codec));
  return hit ? html`${hit[1]} <span class="muted small">${codec}</span>` : codec;
}

const HLS_ERRORS = {
  bufferAddCodecError: 'codec non pris en charge par ce navigateur',
  bufferIncompatibleCodecsError: 'codec non pris en charge par ce navigateur',
  manifestIncompatibleCodecsError: 'codec non pris en charge par ce navigateur',
  manifestLoadError: 'playlist injoignable',
  levelLoadError: 'playlist de qualité injoignable',
  fragLoadError: 'segment injoignable',
};

const MAX_SAMPLES = 90;

function BitrateChart({ samples, unit }) {
  const [hover, setHover] = useState(null);
  if (samples.length < 2) return html`<div class="bitrate-chart bitrate-empty muted small">Débit : en attente de données…</div>`;
  const max = Math.max(...samples) * 1.15;
  const x = (i) => (i / (samples.length - 1)) * 100;
  const y = (v) => 100 - (v / max) * 100;
  const line = samples.map((v, i) => `${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(' ');
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  const onMove = (e) => {
    const box = e.currentTarget.getBoundingClientRect();
    setHover(Math.round(((e.clientX - box.left) / box.width) * (samples.length - 1)));
  };
  const shown = hover ?? samples.length - 1;
  return html`<div class="bitrate-chart">
    <div class="row gap bitrate-head">
      <strong>${formatBitrate(samples[shown])}</strong>
      <span class="muted small">${hover === null ? 'dernier' : `${unit} ${hover + 1}`}</span>
      <span class="grow"></span>
      <span class="muted small">moy. ${formatBitrate(avg)} · max ${formatBitrate(Math.max(...samples))}</span>
    </div>
    <div class="bitrate-plot" onMouseMove=${onMove} onMouseLeave=${() => setHover(null)}>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label=${`Débit par ${unit}, moyenne ${formatBitrate(avg)}`}>
        <line x1="0" x2="100" y1=${y(avg)} y2=${y(avg)} class="bitrate-avg" vector-effect="non-scaling-stroke" />
        <polygon points=${`0,100 ${line} 100,100`} class="bitrate-area" />
        <polyline points=${line} class="bitrate-line" vector-effect="non-scaling-stroke" />
        ${hover !== null && html`<line x1=${x(hover)} x2=${x(hover)} y1="0" y2="100" class="bitrate-cursor" vector-effect="non-scaling-stroke" />`}
      </svg>
    </div>
    <div class="muted small">Débit par ${unit}, ${samples.length} dernier(s) · pointillés : moyenne</div>
  </div>`;
}

export function Player({ src }) {
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const [info, setInfo] = useState({});
  const [samples, setSamples] = useState([]);
  const [error, setError] = useState(null);
  useTick(1000);

  useEffect(() => {
    const video = videoRef.current;
    let timer = null;
    let dead = false;
    const patch = (p) => !dead && setInfo((i) => ({ ...i, ...p }));
    const push = (bps) => !dead && setSamples((s) => [...s.slice(1 - MAX_SAMPLES), bps]);
    setInfo({});
    setSamples([]);
    setError(null);

    const native = (mode) => {
      patch({ mode, unit: 'seconde' });
      video.src = src;
      video.play().catch(() => {});
      // Fichier: octets decodes par seconde de lecture. Compteurs propres a Chromium:
      // ailleurs, pas de graphe.
      let last = null;
      timer = setInterval(() => {
        const bytes = video.webkitVideoDecodedByteCount + video.webkitAudioDecodedByteCount;
        if (Number.isNaN(bytes) || video.paused) return void (last = null);
        if (last !== null && bytes > last) push((bytes - last) * 8);
        last = bytes;
      }, 1000);
    };

    (async () => {
      const playlist = await isPlaylist(src);
      const Hls = playlist ? await loadHls() : null;
      if (dead) return;
      if (!Hls?.isSupported()) return native(playlist ? 'HLS natif' : 'Fichier');

      const hls = new Hls();
      hlsRef.current = hls;
      patch({ mode: 'HLS', unit: 'segment' });
      let recovered = false;
      // Les variantes telles que lues, avant le tri sur ce que le navigateur sait decoder:
      // un flux illisible ici montre quand meme ses codecs.
      hls.on(Hls.Events.MANIFEST_LOADED, (_, d) => patch({ levels: d.levels }));
      hls.on(Hls.Events.MANIFEST_PARSED, () => patch({ levels: hls.levels }));
      hls.on(Hls.Events.LEVEL_SWITCHED, (_, d) => patch({ level: d.level }));
      hls.on(Hls.Events.LEVEL_LOADED, (_, d) => patch({ live: d.details.live }));
      hls.on(Hls.Events.BUFFER_CODECS, (_, d) => patch({
        videoCodec: d.video?.codec || d.audiovideo?.codec,
        audioCodec: d.audio?.codec,
      }));
      hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => patch({ audioTracks: hls.audioTracks }));
      hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, (_, d) => patch({ audioTrack: d.id }));
      // Debit reel du media: octets d'un segment rapportes a sa duree (pas a son temps de
      // telechargement, qui mesurerait le reseau).
      hls.on(Hls.Events.FRAG_LOADED, (_, d) => {
        if (d.frag.type === 'main' && d.frag.duration > 0) push((d.frag.stats.loaded * 8) / d.frag.duration);
      });
      hls.on(Hls.Events.ERROR, (_, d) => {
        if (!d.fatal) return;
        // Un codec que le navigateur ne decode pas ne se recupere pas.
        if (d.type === Hls.ErrorTypes.MEDIA_ERROR && !/Codec/.test(d.details) && !recovered) {
          recovered = true;
          return hls.recoverMediaError();
        }
        setError(`${HLS_ERRORS[d.details] || d.details}${d.response?.code ? ` (HTTP ${d.response.code})` : ''}`);
      });
      hls.loadSource(src);
      hls.attachMedia(video);
      video.play().catch(() => {});
    })().catch((err) => !dead && setError(err.message));

    return () => {
      dead = true;
      clearInterval(timer);
      hlsRef.current?.destroy();
      hlsRef.current = null;
      video.removeAttribute('src');
      video.load();
    };
  }, [src]);

  const video = videoRef.current;
  const hls = hlsRef.current;
  const level = info.levels?.[info.level ?? 0];
  const quality = video?.getVideoPlaybackQuality?.();
  const buffered = video?.buffered.length ? Math.max(0, video.buffered.end(video.buffered.length - 1) - video.currentTime) : 0;
  const mediaError = video?.error && `${['', 'abandon', 'réseau', 'décodage', 'format non lisible par le navigateur'][video.error.code] || ''} ${video.error.message || ''}`.trim();
  const tracks = info.audioTracks || [];

  return html`<div class="player">
    <div class="player-video">
      <video ref=${videoRef} controls playsinline></video>
    </div>
    <aside class="player-info">
      ${(error || mediaError) && html`<${Callout} tone="error" title="Lecture impossible">${error || mediaError}</${Callout}>`}
      <${KeyValue} rows=${[
        ['Format', info.mode ? `${info.mode}${info.live === undefined ? '' : info.live ? ' · direct' : ' · VOD'}` : '…'],
        ['Définition', video?.videoWidth ? `${video.videoWidth}×${video.videoHeight}` : '—'],
        ['Vidéo', codecName(info.videoCodec || level?.videoCodec)],
        ['Audio', codecName(info.audioCodec || level?.audioCodec)],
        level?.bitrate && ['Débit annoncé', formatBitrate(level.bitrate)],
        info.levels?.length > 1 && ['Qualités', info.levels.map((l, i) => html`<span class=${i === info.level ? 'tone-ok' : 'muted'}>${l.height || '?'}p </span>`)],
        tracks.length > 1 && ['Pistes audio', tracks.map((t) => html`<span class=${t.id === info.audioTrack ? 'tone-ok' : 'muted'}>${t.lang || t.name} </span>`)],
        hls?.bandwidthEstimate && ['Bande passante', formatBitrate(hls.bandwidthEstimate)],
        ['Tampon', `${buffered.toFixed(1)} s`],
        quality?.totalVideoFrames > 0 && ['Images perdues', `${quality.droppedVideoFrames} / ${quality.totalVideoFrames}`],
      ]} />
      <${BitrateChart} samples=${samples} unit=${info.unit || 'segment'} />
    </aside>
  </div>`;
}
