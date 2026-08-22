const crypto = require('crypto');
const config = require('../../core/config');
const cache = require('../../core/cache');
const align = require('./align');
const speech = require('./speech');
const audio = require('./audio');
const { parseCues, retime } = require('./cues');

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
    const listen = (url) =>
      mapLimit(windows, Math.max(1, config.SUBTITLE_AUTOSYNC_CONCURRENCY), (w) =>
        speech.speechIn(url, {
          start: w.t0,
          duration: w.duration,
          headers: source.headers,
          timeoutMs: config.SUBTITLE_AUTOSYNC_WINDOW_TIMEOUT_MS,
        }),
      );

    let parts = await listen(source.url);

    // La variante choisie ne portait que de la video. Certains masters annoncent pourtant un
    // codec audio sur chaque variante -- ils mentent, et il n'y a aucun moyen de le savoir
    // avant d'essayer. Le master, lui, sait assembler l'image et le son.
    if (parts.every((p) => p.reason === 'sans-audio') && source.fallbackUrl) {
      console.log('[subsync] cette variante n\'a pas de piste audio -- reprise depuis le master');
      parts = await listen(source.fallbackUrl);
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

/**
 * Calage d'une piste sur un flux: `t_flux = scale · t_soustitre + offset`.
 *
 * @returns {Promise<{scale,offset,confidence,...}|{refused:true}>}
 */
async function planFor({ streamUrl, streamKey, subtitleKey, vtt, refererUrl, durationHint }) {
  if (!(await enabled())) return null;

  const cues = parseCues(vtt).map((c) => [c.start, c.end]);
  // Une piste de quelques repliques (chansons, pancartes -- ou fichier tronque, ce qui
  // arrive chez les fournisseurs) ne porte pas de quoi correler quoi que ce soit. Le dire:
  // sans ce message, une piste non calee ne se distingue pas d'un calage rate.
  if (cues.length < config.SUBTITLE_AUTOSYNC_MIN_CUES) {
    console.log(
      `[subsync] piste trop courte pour etre calee (${cues.length} repliques, minimum ` +
        `${config.SUBTITLE_AUTOSYNC_MIN_CUES}) -- servie telle quelle`,
    );
    return null;
  }

  const key = `subsync:plan:${shortHash(streamKey)}:${shortHash(subtitleKey)}`;
  // Un refus est memorise moins longtemps qu'un succes (CACHE_EMPTY_TTL_MS, via `wrap`):
  // il vient souvent d'un CDN qui n'a pas repondu, pas d'une piste inadaptee pour toujours.
  return cache.wrap(key, config.SUBTITLE_AUTOSYNC_TTL_MS, config.CACHE_EMPTY_TTL_MS, async () => {
    const signal = await speechOf({
      streamUrl,
      streamKey,
      refererUrl,
      // La piste couvre a peu de chose pres la duree du film: c'est un repli honnete quand
      // ni la playlist ni TMDB ne donnent la duree.
      durationHint: durationHint || cues[cues.length - 1][1],
    });
    if (!signal) return null;

    const solved = align.solve(signal.speech, cues, signal.windows, {
      maxShift: config.SUBTITLE_AUTOSYNC_MAX_SHIFT,
    });

    // Deux verrous, pas un: la confiance resume la qualite des sommets, le nombre de
    // fenetres dit combien d'endroits differents du film sont d'accord. Un faux calage
    // peut avoir l'un ou l'autre, jamais les deux.
    const refus =
      !solved
        ? 'aucun accord entre les fenetres'
        : solved.windows < config.SUBTITLE_AUTOSYNC_MIN_WINDOWS
          ? `seules ${solved.windows}/${solved.windowsTotal} fenetres s'accordent (minimum ${config.SUBTITLE_AUTOSYNC_MIN_WINDOWS})`
          : solved.reach < config.SUBTITLE_AUTOSYNC_MIN_REACH
            ? `accord limite a ${Math.round(solved.reach * 100)} % du film (minimum ${Math.round(config.SUBTITLE_AUTOSYNC_MIN_REACH * 100)} %) -- montage different?`
            : solved.confidence < config.SUBTITLE_AUTOSYNC_MIN_CONFIDENCE
              ? `confiance ${solved.confidence.toFixed(2)} < ${config.SUBTITLE_AUTOSYNC_MIN_CONFIDENCE}`
              : null;

    if (refus) {
      console.log(`[subsync] calage refuse (${refus}) -- piste servie telle quelle`);
      return null;
    }

    const plan = {
      scale: solved.scale,
      offset: solved.offset,
      confidence: Number(solved.confidence.toFixed(3)),
      rms: Number(solved.rms.toFixed(3)),
      windows: solved.windows,
      windowsTotal: solved.windowsTotal,
      reach: solved.reach,
      measures: solved.measures,
    };
    console.log(`[subsync] ${describe(plan)}`);
    return plan;
  });
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

module.exports = { enabled, planFor, apply, describe, isMeaningful, placeWindows, snapToSegments, speechOf };
