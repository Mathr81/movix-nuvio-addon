const crypto = require('crypto');
const config = require('../../core/config');
const cache = require('../../core/cache');
const align = require('./align');
const speech = require('./speech');
const audio = require('./audio');
const { parseCues, retime, sharedTimebase } = require('./cues');

/**
 * Calage automatique d'une piste sur LE flux qu'on est en train de lire.
 *
 * Le probleme, tel qu'il se pose reellement: les flux viennent de sources diverses et les
 * sous-titres d'un index qui ne les connait pas. Rien ne garantit qu'ils decrivent le meme
 * montage, ni la meme cadence. Une piste peut donc etre juste, avancee de huit secondes
 * (logo de distributeur), ou -- le cas penible -- calee au debut et fausse de cinq minutes
 * a la fin (conversion PAL). Le reglage de delai d'un lecteur ne rattrape que le deuxieme
 * cas, et seulement tant qu'on ne bouge pas.
 *
 * Ce module assemble les trois briques qui repondent a ca:
 *   audio.js   trouve la voie la moins chere vers la bande son du flux;
 *   speech.js  releve, sur quelques fenetres, quand on y parle;
 *   align.js   compare ces instants a ceux des repliques et en deduit `scale` et `offset`.
 *
 * Et il ajoute ce qui manque pour que ce soit utilisable:
 *  - une MEMOIRE: le signal de parole d'un flux sert a toutes les pistes candidates, et le
 *    calage trouve survit au redemarrage (cache.js persiste sur disque);
 *  - un REFUS: en dessous du seuil de confiance, on sert la piste telle quelle. Un calage
 *    approximatif est pire que pas de calage -- il est faux partout au lieu d'etre faux
 *    d'une quantite constante, que l'oeil corrige tout seul.
 */

function shortHash(value) {
  return crypto.createHash('sha1').update(String(value)).digest('base64url').slice(0, 16);
}

let warnedMissing = false;

/** Le calage est-il possible ici et maintenant? */
async function enabled() {
  if (!config.SUBTITLE_AUTOSYNC) return false;
  if (await speech.available()) return true;
  if (!warnedMissing) {
    warnedMissing = true;
    console.warn(
      '[subsync] ffmpeg est introuvable -- le calage automatique est desactive et les pistes ' +
        'sont servies telles quelles. Installe ffmpeg (paquet `ffmpeg`) ou renseigne FFMPEG_PATH.',
    );
  }
  return false;
}

/**
 * Ou ecouter dans le film.
 *
 * Le generique de debut et celui de fin sont ecartes: on n'y parle pas, ou par-dessus de la
 * musique. Les fenetres restantes sont reparties regulierement -- il en faut aux DEUX bouts,
 * puisque c'est l'ecart entre elles qui revele une derive.
 */
function placeWindows(duration, count, length) {
  const from = duration * 0.05;
  const to = duration * 0.88 - length;
  if (!(duration > 0) || to <= from) {
    return [{ t0: Math.max(0, duration / 2 - length / 2), duration: length }];
  }
  // Jamais plus de fenetres que la zone utile n'en contient sans les faire se chevaucher:
  // ecouter deux fois le meme passage ne demontre rien de plus, et sur un episode court
  // cela revenait a mesurer cinq fois la meme minute.
  const n = Math.max(1, Math.min(count, Math.floor((to - from) / length) + 1));
  const step = n > 1 ? (to - from) / (n - 1) : 0;
  return Array.from({ length: n }, (_, i) => ({ t0: Math.round(from + i * step), duration: length }));
}

/**
 * Ramene chaque fenetre au debut du segment qui la contient.
 *
 * ffmpeg, sur un flux HLS, ne commence pas a la seconde demandee mais au debut du segment
 * -- tout en renumerotant sa sortie a partir de zero. La fenetre croit alors etre a 90 s
 * alors qu'elle porte l'audio de 84 s, et le decalage mesure est faux d'autant, differemment
 * pour chaque fenetre. Sur une frontiere de segment, la question ne se pose plus.
 */
function snapToSegments(windows, starts) {
  if (!Array.isArray(starts) || starts.length === 0) return windows;
  return windows.map((w) => {
    let snapped = starts[0];
    for (const start of starts) {
      if (start > w.t0) break;
      snapped = start;
    }
    return { ...w, t0: Number(snapped.toFixed(3)) };
  });
}

/**
 * Segments qui couvrent une fenetre, l'en-tete fMP4 en tete quand il y en a un.
 *
 * Les prendre nous-memes plutot que de demander a ffmpeg de se positionner: il ne sait pas
 * toujours le faire (cf. speech.js), et cela nous donne l'instant EXACT ou la fenetre
 * commence -- celui du premier segment.
 */
function segmentsOf(source, window) {
  if (!Array.isArray(source.segments) || source.segments.length === 0) return null;
  const picked = source.segments.filter(
    (seg) => seg.start + seg.duration > window.t0 && seg.start < window.t0 + window.duration,
  );
  if (picked.length === 0) return null;
  return {
    start: picked[0].start,
    urls: [...(source.init ? [source.init] : []), ...picked.map((seg) => seg.uri)],
  };
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Releve de la parole d'un flux, memoise.
 *
 * C'est LA partie couteuse (quelques dizaines de Mo, quelques dizaines de secondes), et
 * c'est aussi celle qui ne depend pas du sous-titre: trois pistes candidates la partagent.
 */
async function speechOf({ streamUrl, streamKey, refererUrl, durationHint }) {
  const key = `subsync:audio:${shortHash(streamKey)}`;
  return cache.wrap(key, config.CACHE_TTL_MS, config.CACHE_EMPTY_TTL_MS, async () => {
    const source = await audio.locate(streamUrl, { refererUrl });
    if (!source) {
      console.warn('[subsync] aucune voie audio trouvee pour ce flux');
      return null;
    }

    // La duree annoncee par la playlist prime; sinon celle du titre (TMDB), sinon celle que
    // couvre la piste elle-meme -- la derniere replique tombe rarement loin de la fin.
    const duration = source.duration || durationHint || 0;
    if (!(duration > 0)) {
      console.warn('[subsync] duree du flux inconnue: impossible de repartir les fenetres');
      return null;
    }

    const windows = snapToSegments(
      placeWindows(duration, config.SUBTITLE_AUTOSYNC_WINDOWS, config.SUBTITLE_AUTOSYNC_WINDOW_SECONDS),
      source.starts,
    );
    const cost = source.bitrate
      ? ` (~${Math.round((source.bitrate * config.SUBTITLE_AUTOSYNC_WINDOW_SECONDS * windows.length) / 8e6)} Mo)`
      : '';
    console.log(
      `[subsync] ecoute de ${windows.length} fenetre(s) de ${config.SUBTITLE_AUTOSYNC_WINDOW_SECONDS}s ` +
        `sur ${Math.round(duration / 60)} min, voie "${source.kind}"${cost}`,
    );

    const started = Date.now();
    const listen = (url, useSegments) =>
      mapLimit(windows, Math.max(1, config.SUBTITLE_AUTOSYNC_CONCURRENCY), (w) => {
        const picked = useSegments ? segmentsOf(source, w) : null;
        return picked
          ? speech.speechInSegments(picked.urls, {
              start: picked.start,
              duration: w.duration,
              headers: source.headers,
              timeoutMs: config.SUBTITLE_AUTOSYNC_WINDOW_TIMEOUT_MS,
            })
          : speech.speechIn(url, {
              start: w.t0,
              duration: w.duration,
              headers: source.headers,
              timeoutMs: config.SUBTITLE_AUTOSYNC_WINDOW_TIMEOUT_MS,
            });
      });

    let parts = await listen(source.url, true);

    // La variante choisie ne portait que de la video. Certains masters annoncent pourtant un
    // codec audio sur chaque variante -- ils mentent, et il n'y a aucun moyen de le savoir
    // avant d'essayer. Le master, lui, sait assembler l'image et le son.
    if (parts.every((p) => p.reason === 'sans-audio') && source.fallbackUrl) {
      console.log('[subsync] cette variante n\'a pas de piste audio -- reprise depuis le master');
      parts = await listen(source.fallbackUrl, false);
    }

    const usable = windows.filter((_, i) => parts[i].intervals && parts[i].intervals.length > 0);
    if (usable.length === 0) {
      console.warn('[subsync] aucune fenetre exploitable (audio illisible)');
      return null;
    }

    // Arrondi au centieme: ce tableau est persiste sur disque, et la milliseconde de la
    // troisieme decimale ne changera aucun calage.
    const intervals = parts
      .flatMap((p) => p.intervals || [])
      .map(([a, b]) => [Number(a.toFixed(2)), Number(b.toFixed(2))]);

    console.log(
      `[subsync] ${usable.length}/${windows.length} fenetre(s) exploitables, ` +
        `${intervals.length} passage(s) parle(s) releve(s) en ${Math.round((Date.now() - started) / 1000)}s`,
    );
    return { windows: usable, speech: intervals, duration, kind: source.kind };
  });
}

/** Reglages de resolution, tires de la configuration. */
function solveOptions() {
  return {
    maxShift: config.SUBTITLE_AUTOSYNC_MAX_SHIFT,
    driftMargin: config.SUBTITLE_AUTOSYNC_DRIFT_MARGIN,
    driftEvidence: config.SUBTITLE_AUTOSYNC_DRIFT_EVIDENCE,
    ...(config.SUBTITLE_AUTOSYNC_DRIFT ? {} : { scales: [1] }),
  };
}

/** Cle de cache d'un calage. */
function planKey(streamKey, subtitleKey) {
  return `subsync:plan:${shortHash(streamKey)}:${shortHash(subtitleKey)}`;
}

/** Repliques exploitables d'une piste, ou null si elle est trop courte pour porter un calage. */
function usableCues(vtt) {
  const cues = parseCues(vtt).map((c) => [c.start, c.end]);
  // Une piste de quelques repliques (chansons, pancartes -- ou fichier tronque, ce qui
  // arrive chez les fournisseurs) ne porte pas de quoi correler quoi que ce soit.
  if (cues.length < config.SUBTITLE_AUTOSYNC_MIN_CUES) {
    console.log(
      `[subsync] piste trop courte pour etre calee (${cues.length} repliques, minimum ` +
        `${config.SUBTITLE_AUTOSYNC_MIN_CUES}) -- servie telle quelle`,
    );
    return null;
  }
  return cues;
}

/**
 * Ce qui manque a un resultat pour etre applique, ou null s'il ne manque rien.
 *
 * Trois verrous, et il faut les passer tous les trois. La confiance resume la qualite des
 * sommets; le nombre de fenetres dit combien d'endroits differents du film sont d'accord;
 * l'etendue dit s'ils couvrent le film ou seulement son debut. Un faux calage peut avoir
 * l'un de ces trois, jamais les trois.
 */
function missing(solved, minConfidence = config.SUBTITLE_AUTOSYNC_MIN_CONFIDENCE) {
  if (!solved) return 'aucun accord entre les fenetres';
  if (solved.windows < config.SUBTITLE_AUTOSYNC_MIN_WINDOWS) {
    return `seules ${solved.windows}/${solved.windowsTotal} fenetres s'accordent (minimum ${config.SUBTITLE_AUTOSYNC_MIN_WINDOWS})`;
  }
  if (solved.reach < config.SUBTITLE_AUTOSYNC_MIN_REACH) {
    return `accord limite a ${Math.round(solved.reach * 100)} % du film (minimum ${Math.round(config.SUBTITLE_AUTOSYNC_MIN_REACH * 100)} %) -- montage different?`;
  }
  if (solved.confidence < minConfidence) return `confiance ${solved.confidence.toFixed(2)} < ${minConfidence}`;
  return null;
}

/** Instant du flux ou un plan envoie la replique de temps `t`. */
function at(plan, t) {
  return plan.scale * t + plan.offset;
}

/**
 * Deux calages decrivent-ils la MEME correspondance, d'un bout a l'autre du film?
 *
 * Comparer les seuls decalages ne suffirait pas: deux plans peuvent partir du meme point et
 * diverger de cinq minutes a la fin si leurs cadences different. Ce sont les deux bouts qui
 * doivent coincider.
 */
function agree(a, b, duration) {
  const tolerance = config.SUBTITLE_AUTOSYNC_PAIR_TOLERANCE;
  return Math.abs(at(a, 0) - at(b, 0)) < tolerance && Math.abs(at(a, duration) - at(b, duration)) < tolerance;
}

function toPlan(solved) {
  return {
    scale: solved.scale,
    offset: solved.offset,
    confidence: Number(solved.confidence.toFixed(3)),
    rms: Number(solved.rms.toFixed(3)),
    windows: solved.windows,
    windowsTotal: solved.windowsTotal,
    reach: solved.reach,
    measures: solved.measures,
  };
}

/**
 * Calage d'une piste sur un flux: `t_flux = scale · t_soustitre + offset`.
 * @returns {Promise<object|null>} null si aucun calage n'est assez sur pour etre applique
 */
async function planFor({ streamUrl, streamKey, subtitleKey, vtt, refererUrl, durationHint }) {
  if (!(await enabled())) return null;
  const cues = usableCues(vtt);
  if (!cues) return null;

  // Un refus est memorise moins longtemps qu'un succes (CACHE_EMPTY_TTL_MS, via `wrap`):
  // il vient souvent d'un CDN qui n'a pas repondu, pas d'une piste inadaptee pour toujours.
  return cache.wrap(planKey(streamKey, subtitleKey), config.SUBTITLE_AUTOSYNC_TTL_MS, config.CACHE_EMPTY_TTL_MS, async () => {
    const signal = await speechOf({ streamUrl, streamKey, refererUrl, durationHint: durationHint || cues[cues.length - 1][1] });
    if (!signal) return null;

    const solved = align.solve(signal.speech, cues, signal.windows, solveOptions());
    const refus = missing(solved);
    if (refus) {
      console.log(`[subsync] calage refuse (${refus}) -- piste servie telle quelle`);
      return null;
    }
    const plan = toPlan(solved);
    console.log(`[subsync] ${describe(plan)}`);
    return plan;
  });
}

/**
 * Cale PLUSIEURS pistes du meme titre sur le meme flux, d'un seul releve audio.
 *
 * Deux raisons de les traiter ensemble plutot qu'une par une:
 *  - le releve de parole, qui est tout le cout, est partage: la deuxieme piste ne coute
 *    qu'une correlation;
 *  - surtout, elles se CORROBORENT. Le francais et l'anglais d'un meme titre sont deux
 *    fichiers differents, traduits par des gens differents, avec des decoupages differents.
 *    Qu'ils tombent separement sur la meme correspondance a une demi-seconde pres, d'un bout
 *    a l'autre du film, ne s'explique pas par la coincidence -- et cela permet d'accepter
 *    des calages justes que la confiance seule, mesuree piste par piste, ferait rejeter.
 *    Sur le banc d'essai, cet accord ne s'est jamais produit entre pistes d'un autre titre.
 *
 * @param {Array<{key:string, vtt:string}>} tracks
 * @returns {Promise<Map<string, object|null>>} un calage (ou null) par cle de piste
 */
async function plansFor({ streamUrl, streamKey, refererUrl, durationHint, tracks }) {
  const out = new Map();
  if (!(await enabled()) || tracks.length === 0) return out;

  const candidates = [];
  for (const track of tracks) {
    if (cache.get(planKey(streamKey, track.key)) !== undefined) {
      out.set(track.key, cache.get(planKey(streamKey, track.key)));
      continue;
    }
    const cues = usableCues(track.vtt);
    if (cues) candidates.push({ ...track, cues });
  }
  if (candidates.length === 0) return out;

  const signal = await speechOf({
    streamUrl,
    streamKey,
    refererUrl,
    durationHint: durationHint || Math.max(...candidates.map((c) => c.cues[c.cues.length - 1][1])),
  });
  if (!signal) return out;

  const solved = candidates.map((c) => ({
    ...c,
    result: align.solve(signal.speech, c.cues, signal.windows, solveOptions()),
  }));

  for (const entry of solved) {
    const refus = missing(entry.result);
    let plan = refus ? null : toPlan(entry.result);

    // Repechage par corroboration: le verrou de confiance seul est abaisse, jamais ceux qui
    // portent sur le nombre de fenetres et l'etendue couverte.
    if (!plan && !missing(entry.result, config.SUBTITLE_AUTOSYNC_MIN_CONFIDENCE_PAIR)) {
      const temoin = solved.find(
        (other) =>
          other !== entry &&
          !missing(other.result, config.SUBTITLE_AUTOSYNC_MIN_CONFIDENCE_PAIR) &&
          agree(entry.result, other.result, signal.duration) &&
          // ...et que ce soit vraiment un DEUXIEME avis. Deux traductions du meme fichier de
          // temps rendent la meme mesure au centieme pres: les faire se confirmer l'une
          // l'autre revient a compter deux fois la meme chose. Verifie et mesure: c'est ce
          // qui separait un calage douteux a -91 s d'un calage juste.
          sharedTimebase(entry.cues, other.cues) <= config.SUBTITLE_AUTOSYNC_PAIR_MAX_SHARED,
      );
      if (temoin) {
        plan = toPlan(entry.result);
        console.log(`[subsync] calage confirme par une piste independante du meme titre (${describe(plan)})`);
      }
    }

    if (plan && !refus) console.log(`[subsync] ${describe(plan)}`);
    else if (!plan) console.log(`[subsync] calage refuse (${refus}) -- piste servie telle quelle`);

    cache.set(
      planKey(streamKey, entry.key),
      plan,
      plan ? config.SUBTITLE_AUTOSYNC_TTL_MS : config.CACHE_EMPTY_TTL_MS,
    );
    out.set(entry.key, plan);
  }
  return out;
}

/** Ce qu'un calage change, en francais. Sert aux logs et au diagnostic. */
function describe(plan) {
  if (!plan) return 'aucun calage';
  const drift = plan.scale === 1 ? '' : `, derive ${((plan.scale - 1) * 100).toFixed(2)} % (cadence)`;
  return (
    `decalage ${plan.offset >= 0 ? '+' : ''}${plan.offset.toFixed(2)}s${drift} ` +
    `-- confiance ${plan.confidence}, ${plan.windows}/${plan.windowsTotal} fenetres, dispersion ${plan.rms}s`
  );
}

/** Applique un calage a un WebVTT. Sans plan retenu, le fichier ressort intact. */
function apply(vtt, plan) {
  if (!plan) return vtt;
  return retime(vtt, plan);
}

/** Un calage qui ne change rien merite d'etre signale comme tel plutot que d'etre applique. */
function isMeaningful(plan) {
  if (!plan) return false;
  return Math.abs(plan.offset) > 0.15 || plan.scale !== 1;
}

module.exports = { enabled, planFor, plansFor, apply, describe, isMeaningful, placeWindows, snapToSegments, speechOf };
