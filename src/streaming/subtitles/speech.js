const { spawn } = require('child_process');
const https = require('https');
const axios = require('axios');
const config = require('../../core/config');

/**
 * Ou parle-t-on dans ce flux -- mesure par ffmpeg, sur une fenetre.
 *
 * On ne cherche pas a comprendre l'audio, seulement a savoir QUAND il y a de la voix. Cela
 * suffit a caler des sous-titres (cf. align.js), et cela se lit sur l'enveloppe de niveau.
 *
 * Pourquoi pas le filtre `silencedetect`, qui rendrait ces intervalles tout cuits: son seuil
 * est ABSOLU (-30 dB). Un film mixe fort n'a alors aucun silence -- musique, ambiance,
 * bruitages remplissent tout -- et un film mixe bas n'a que ca. Dans les deux cas le signal
 * est plat, donc inutilisable. On releve donc le niveau RMS toutes les 20 ms et on place le
 * seuil DANS la fenetre, d'apres sa propre dynamique. La meme scene, mixee 10 dB plus bas,
 * donne exactement le meme decoupage.
 *
 * La bande passante est limitee a 200-3000 Hz avant la mesure: c'est celle de la voix. Les
 * basses d'une explosion ou d'une nappe de musique ne comptent plus pour de la parole, ce
 * qui est precisement la confusion qu'on veut eviter.
 */

const FFMPEG = () => config.FFMPEG_PATH || 'ffmpeg';

// Pas d'echantillonnage de l'enveloppe. Il doit coller a la resolution d'align.js: mesurer
// plus fin ne servirait a rien, mesurer plus gros perdrait des attaques de syllabe.
const FRAME_MS = 20;
const SAMPLE_RATE = 16000;
const FRAME_SAMPLES = Math.round((SAMPLE_RATE * FRAME_MS) / 1000);

/**
 * Chaine de filtres: mono, bande vocale, trames de 20 ms, niveau RMS de chacune imprime
 * sur la sortie standard.
 */
const FILTERS = [
  `aresample=${SAMPLE_RATE}`,
  'aformat=channel_layouts=mono',
  'highpass=f=200',
  'lowpass=f=3000',
  `asetnsamples=n=${FRAME_SAMPLES}:p=0`,
  'astats=metadata=1:reset=1',
  'ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-',
].join(',');

let availability = null;

/** ffmpeg est-il installe? Verifie une fois, puis memorise pour la duree du process. */
function available() {
  if (availability) return availability;
  availability = new Promise((resolve) => {
    const child = spawn(FFMPEG(), ['-version'], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
  return availability;
}

function run(args, { timeoutMs, feed }) {
  return new Promise((resolve) => {
    const child = spawn(FFMPEG(), args, { stdio: [feed ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    if (feed) {
      // Un ffmpeg qui s'arrete avant d'avoir tout lu (assez de trames, erreur) ferme son
      // entree: l'ecriture qui suit remonte EPIPE. C'est normal, pas une panne.
      child.stdin.on('error', () => {});
      feed(child.stdin).then(
        () => child.stdin.end(),
        () => child.stdin.end(),
      );
    }
    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, timeoutMs).unref();

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    // Borne les diagnostics: un CDN qui refuse chaque segment produit des milliers de
    // lignes dont seules les premieres apprennent quelque chose.
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 8000) stderr += chunk;
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) return resolve({ ok: false, error: `delai depasse (${Math.round(timeoutMs / 1000)}s)`, stdout });
      resolve({ ok: code === 0 || stdout.length > 0, code, stdout, stderr });
    });
  });
}

/** Sortie de `ametadata=print` -> niveaux RMS en dB, un par trame de 20 ms. */
function parseLevels(stdout) {
  const levels = [];
  for (const line of stdout.split('\n')) {
    const match = /RMS_level=(-?[\d.]+|-inf)/.exec(line);
    if (!match) continue;
    // "-inf" = trame numeriquement muette (blanc, fondu). Un plancher fixe la rend
    // comparable aux autres sans fausser les percentiles.
    levels.push(match[1] === '-inf' ? -91 : Math.max(-91, Number(match[1])));
  }
  return levels;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[index];
}

/**
 * A combien de decibels sous les passages les plus forts on cesse de considerer qu'il y a
 * de la parole.
 *
 * Un seuil RELATIF au haut de la dynamique, et non a son milieu. La difference n'est pas
 * theorique: une premiere version placait le seuil a mi-hauteur entre le 5e et le 95e
 * percentile, ce qui, sur un film ou la musique ne s'arrete jamais, marquait 60 a 80 % du
 * temps comme "parle" -- un signal presque constant, dont on ne tire rien.
 *
 * 8 dB est le creux d'une plage large: entre -7 et -9 dB les resultats se tiennent, ce qui
 * est rassurant -- le reglage n'est pas accroche a un titre particulier.
 */
const SPEECH_BELOW_PEAK_DB = 8;

/**
 * Demi-largeur du voisinage sur lequel ce seuil est recalcule.
 *
 * C'est un seuil GLISSANT, et c'est ce qui a le plus rapporte de tout le reglage: une
 * fenetre d'une minute et demie couvre souvent une scene calme ET une scene d'action, et un
 * seuil unique ne convient alors ni a l'une ni a l'autre -- il noie la premiere ou vide la
 * seconde. Sur un banc de vingt pistes reelles, passer au seuil glissant fait passer le
 * nombre de pistes calees de 5 a 11, sans un seul faux calage de plus.
 *
 * Le percentile est calcule sur une grille d'une seconde puis repris tel quel entre deux
 * points: un percentile glissant exact a 20 ms couterait cent fois plus pour le meme
 * decoupage.
 */
const THRESHOLD_WINDOW_SECONDS = 15;

// Silence toleree A L'INTERIEUR d'une prise de parole. Ce qui compte pour le calage, c'est
// l'instant ou l'on COMMENCE a parler: mieux vaut un bloc un peu long qu'un bloc coupe en
// trois par deux respirations, qui inventerait deux debuts la ou il n'y en a qu'un.
const MERGE_GAP_SECONDS = 0.4;

/**
 * Enveloppe de niveau -> intervalles de parole.
 *
 * Deux nettoyages apres le seuillage, ceux que ferait n'importe quel detecteur de voix: on
 * recolle les blocs separes par un court silence, et on jette ceux de moins de 150 ms (un
 * choc, un claquement de porte).
 */
function slidingThreshold(levels) {
  const step = FRAME_MS / 1000;
  const grid = Math.round(1 / step);
  const half = Math.round(THRESHOLD_WINDOW_SECONDS / step);
  const points = [];

  for (let center = 0; center < levels.length; center += grid) {
    const slice = levels.slice(Math.max(0, center - half), Math.min(levels.length, center + half)).sort((a, b) => a - b);
    // 95e percentile plutot que le maximum: une detonation isolee ne doit pas definir a
    // elle seule ce qu'est "fort" ici.
    const high = percentile(slice, 95);
    points.push(Math.max(percentile(slice, 5), high - SPEECH_BELOW_PEAK_DB));
  }

  return (index) => points[Math.min(points.length - 1, Math.round(index / grid))];
}

function toIntervals(levels, { start }) {
  if (levels.length < 20) return [];
  const sorted = [...levels].sort((a, b) => a - b);
  // Fenetre sans dynamique: uniformement bruyante ou uniformement muette. Il n'y a rien a
  // y decouper, et un seuil arbitraire n'y produirait que du bruit.
  if (percentile(sorted, 95) - percentile(sorted, 5) < 6) return [];
  const threshold = slidingThreshold(levels);

  const step = FRAME_MS / 1000;
  const raw = [];
  let from = null;
  for (let i = 0; i < levels.length; i += 1) {
    const loud = levels[i] > threshold(i);
    if (loud && from === null) from = i * step;
    if (!loud && from !== null) {
      raw.push([from, i * step]);
      from = null;
    }
  }
  if (from !== null) raw.push([from, levels.length * step]);

  const merged = [];
  for (const [a, b] of raw) {
    const last = merged[merged.length - 1];
    if (last && a - last[1] < MERGE_GAP_SECONDS) last[1] = b;
    else merged.push([a, b]);
  }

  return merged.filter(([a, b]) => b - a >= 0.15).map(([a, b]) => [start + a, start + b]);
}

/**
 * Intervalles de parole d'une fenetre du flux, en temps ABSOLU du flux.
 *
 * @param {string} url      URL lisible par ffmpeg (deja passee par notre proxy si besoin)
 * @param {{start:number, duration:number, headers?:object, timeoutMs?:number, withLevels?:boolean}} options
 *        `withLevels` renvoie EN PLUS l'enveloppe brute (un niveau toutes les 20 ms). Elle
 *        ne sert pas au calage, mais elle permet de rejouer le seuillage hors ligne sur un
 *        audio deja telecharge -- c'est ce qui rend un banc d'essai possible sans repayer
 *        le reseau a chaque essai de reglage.
 * @returns {Promise<{intervals:Array<[number,number]>}|{error:string, reason?:string}>}
 *   `reason: 'sans-audio'` distingue LA panne qui se rattrape: une variante HLS qui ne
 *   porte que de la video (le master annonce pourtant un codec audio, mais l'audio est
 *   ailleurs). L'appelant peut alors repartir du master au lieu d'abandonner le flux.
 */
async function speechIn(url, { start, duration, headers, timeoutMs = 60000, withLevels = false } = {}) {
  // Options PRIVEES du protocole http: les passer sur une entree qui n'en est pas une fait
  // echouer l'ouverture avec un laconique "Option not found", sans dire laquelle.
  const network = /^https?:\/\//i.test(String(url))
    ? [
        // Coupures de connexion des CDN de hosters: sans reprise, une fenetre sur trois
        // revient tronquee, et une fenetre tronquee est une fenetre perdue.
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '4',
        // Un CDN qui accepte la connexion puis n'envoie rien bloquerait jusqu'au delai global.
        '-rw_timeout', '15000000',
        // Une seule option `-headers`, les en-tetes separes par CRLF: c'est la forme
        // qu'attend le protocole http de ffmpeg.
        ...(headers && Object.keys(headers).length > 0
          ? ['-headers', `${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n`]
          : []),
      ]
    : [];

  const args = [
    '-hide_banner',
    '-nostdin',
    '-loglevel', 'error',
    ...network,
    // `-accurate_seek` (actif par defaut, rendu explicite ici parce que TOUT en depend):
    // ffmpeg se place au point de synchronisation precedent puis DECODE et jette jusqu'a
    // l'instant demande. Une fenetre qui commencerait au debut de son segment fausserait
    // le decalage mesure de plusieurs secondes, silencieusement.
    '-accurate_seek',
    '-ss', String(start),
    '-t', String(duration),
    '-i', url,
    '-vn',
    '-map', '0:a:0',
    '-af', FILTERS,
    '-f', 'null',
    '-',
  ];

  const result = await run(args, { timeoutMs });
  const levels = parseLevels(result.stdout || '');
  if (levels.length < 20) {
    const stderr = result.stderr || '';
    const why = result.error || stderr.split('\n').filter(Boolean).pop() || 'aucune trame audio';
    const reason = /matches no streams|does not contain any stream/i.test(stderr) ? 'sans-audio' : 'illisible';
    console.warn(`[subsync] audio illisible a ${Math.round(start)}s (${reason}): ${why.slice(0, 160)}`);
    return { error: why, reason };
  }
  return { intervals: toIntervals(levels, { start }), ...(withLevels ? { levels } : {}) };
}

// Meme constat que dans probe.js et audio.js: les CDN de hosters ont regulierement des
// certificats invalides.
const insecureAgent = new https.Agent({ rejectUnauthorized: false });

/**
 * Meme mesure, mais en allant chercher SOI-MEME les segments de la fenetre.
 *
 * Pourquoi ne pas laisser ffmpeg s'en charger avec `-ss`, comme le fait `speechIn`: parce
 * qu'il ne SAIT pas toujours le faire. Sur une playlist en segments fragmentes (fMP4,
 * `EXT-X-MAP`), il refuse de se positionner et relit tout depuis le debut -- mesure sur un
 * flux reel: 84 secondes pour lire 20 secondes d'audio situees a la huitieme minute. Or
 * nous connaissons deja les frontieres de segments, puisque nous avons lu la playlist.
 *
 * Les prendre nous-memes regle trois choses d'un coup: on ne telecharge que la fenetre, on
 * sait EXACTEMENT a quel instant du flux elle commence (c'est le debut du premier segment
 * choisi, plus d'incertitude de positionnement), et le resultat ne depend plus du format
 * des segments.
 *
 * @param {Array<string>} urls  segments a lire, dans l'ordre; l'en-tete fMP4 en premier
 * @param {{start:number, duration:number, headers?:object, timeoutMs?:number, maxBytes?:number}} options
 *        `start` = instant du flux ou commence le PREMIER segment fourni.
 */
async function speechInSegments(urls, { start, duration, headers, timeoutMs = 60000, maxBytes = 64 * 1024 * 1024, withLevels = false } = {}) {
  const args = [
    '-hide_banner',
    '-nostdin',
    '-loglevel', 'error',
    // Sur une entree en tuyau, ffmpeg n'a pas de fichier a sonder: on lui laisse de quoi
    // reconnaitre le format avant de decider qu'il n'y arrive pas.
    '-probesize', '10M',
    '-analyzeduration', '10M',
    '-i', 'pipe:0',
    '-t', String(duration),
    '-vn',
    '-map', '0:a:0',
    '-af', FILTERS,
    '-f', 'null',
    '-',
  ];

  let sent = 0;
  const feed = async (stdin) => {
    for (const url of urls) {
      if (sent > maxBytes) break;
      const { data } = await axios.get(url, {
        headers,
        responseType: 'arraybuffer',
        timeout: 20000,
        httpsAgent: insecureAgent,
        maxRedirects: 5,
      });
      sent += data.byteLength;
      if (!stdin.writable) break;
      // Respecter la contre-pression: un segment fait des dizaines de Ko et ffmpeg les
      // consomme au rythme du decodage.
      await new Promise((resolve) => stdin.write(Buffer.from(data), () => resolve()));
    }
  };

  const result = await run(args, { timeoutMs, feed }).catch((err) => ({ error: err.message }));
  const levels = parseLevels(result.stdout || '');
  if (levels.length < 20) {
    const stderr = result.stderr || '';
    const why = result.error || stderr.split('\n').filter(Boolean).pop() || 'aucune trame audio';
    const reason = /matches no streams|does not contain any stream/i.test(stderr) ? 'sans-audio' : 'illisible';
    console.warn(`[subsync] audio illisible a ${Math.round(start)}s (${reason}): ${why.slice(0, 160)}`);
    return { error: why, reason };
  }
  return { intervals: toIntervals(levels, { start }), ...(withLevels ? { levels } : {}) };
}

module.exports = { available, speechIn, speechInSegments, toIntervals, parseLevels, FRAME_MS, SPEECH_BELOW_PEAK_DB, THRESHOLD_WINDOW_SECONDS };
