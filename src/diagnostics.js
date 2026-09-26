const config = require('./core/config');
const subtitles = require('./streaming/subtitles');
const subsync = require('./streaming/subtitles/sync');
const playback = require('./streaming/playback');
const streamProxy = require('./streaming/streamProxy');
const { resolveId } = require('./catalog/idResolver');
const { collectRawLinks, resolveStreams, buildStreams } = require('./streaming/streamBuilder');
const { breakerState: probeBreakerState } = require('./streaming/probe');
const { detectHoster, extractDirectUrl, breakerState, LOCAL_EXTRACTORS } = require('./streaming/hosterExtract');

/**
 * Diagnostics d'un titre, partages par les routes `/debug/*` et la WebUI.
 *
 * Chaque fonction prend le couple (type, id) tel que Stremio l'envoie -- "tmdb:157336",
 * "tt0816692", "tmdb:1396:1:2" -- et rend un objet JSON pret a servir. Les noms de champs
 * sont ceux que les routes `/debug` exposaient deja: des scripts ou des habitudes de `curl`
 * s'appuient dessus.
 */

/** Ce que chaque source a reellement renvoye, avant extraction. */
async function rawLinks(type, id) {
  const { tmdbId, season, episode } = await resolveId(type, id);
  const raw = await collectRawLinks({ tmdbId, type, season, episode });

  return {
    tmdbId,
    type,
    season,
    episode,
    total: raw.length,
    links: raw.map((r) => ({
      source: r.sourceName,
      url: r.url,
      player: r.player,
      lang: r.lang,
      quality: r.quality,
      direct: !!r.direct,
      hoster: r.direct ? 'n/a (lien direct)' : detectHoster(r.url, r.player) || 'AUCUN EXTRACTEUR',
    })),
  };
}

// Depuis que Movix resout ses m3u8 lui-meme (`?resolve=1`), la question utile n'est plus
// "l'extracteur a-t-il marche" mais "qui devait extraire ce lien". Trois issues:
//   resolu       le serveur Movix l'a rendu directement (il n'apparait pas ici, il n'est
//                deja plus un embed)
//   local        l'addon l'a extrait seul (voe, darkibox, oneupload)
//   server-only  extractible, mais par Movix seulement -- il manque une cle VIP valide
//                ou l'extraction amont a echoue
async function extraction(type, id) {
  const { tmdbId, season, episode } = await resolveId(type, id);
  const raw = await collectRawLinks({ tmdbId, type, season, episode });
  const embeds = raw.filter((r) => !r.direct && r.url);

  const results = await Promise.all(
    embeds.map(async (item) => {
      const hoster = detectHoster(item.url, item.player);
      if (!hoster) {
        return { source: item.sourceName, url: item.url, hoster: null, issue: 'aucun extracteur' };
      }
      const outcome = await extractDirectUrl(item.url, item.player);
      return {
        source: item.sourceName,
        hoster,
        url: item.url,
        extracteur: LOCAL_EXTRACTORS.has(hoster) ? 'local' : 'Movix (resolve=1)',
        ok: outcome.ok,
        resultat: outcome.ok ? outcome.url : undefined,
        issue: outcome.ok ? undefined : `${outcome.reason}${outcome.status ? ` (${outcome.status})` : ''}`,
      };
    }),
  );

  return {
    tmdbId,
    total: embeds.length,
    extraits: results.filter((r) => r.ok).length,
    // Hebergeurs momentanement ecartes: sans ca, un "0/3" ressemble a une extraction
    // ratee alors qu'aucune requete n'a ete envoyee.
    ecartes: breakerState(),
    parHebergeur: Object.fromEntries(
      [...new Set(results.map((r) => r.hoster || 'inconnu'))].map((h) => {
        const mine = results.filter((r) => (r.hoster || 'inconnu') === h);
        return [h, `${mine.filter((r) => r.ok).length}/${mine.length}`];
      }),
    ),
    liens: results,
  };
}

// Ce que la sonde a REELLEMENT obtenu par lien, avant mise en forme. C'est la difference
// entre "aucune mesure" et "mesure aberrante", que le libelle affiche dans Nuvio ne
// permet plus de distinguer.
async function streams(type, id) {
  const { tmdbId, season, episode } = await resolveId(type, id);
  // `wait`: on veut l'etat FINAL des mesures, pas celui de la premiere reponse.
  const resolved = await resolveStreams({ tmdbId, type, season, episode, wait: true });

  return {
    tmdbId,
    type,
    // Cette liste montre TOUT ce qui a ete resolu; le mode compact en masque une partie
    // a l'affichage. Donner les deux nombres evite de croire a une source perdue.
    mode: config.STREAM_LIST,
    total: resolved.length,
    affichesDansNuvio: (await buildStreams({ tmdbId, type, season, episode })).length,
    // Voies de mesure momentanement ecartees (un service qui ne repond plus).
    ecartes: probeBreakerState(),
    streams: resolved.map((r) => ({
      source: r.sourceName,
      proxifie: streamProxy.isProxied(r.url),
      cible: streamProxy.targetOf(r.url) || r.url,
      qualiteAnnoncee: r.quality || null,
      // La resolution telle que le master l'annonce, et le palier qui en decoule. Un film
      // en scope (1920x800) doit sortir en 1080p: c'est la largeur qui le dit.
      resolution: r.width && r.height ? `${r.width}x${r.height}` : r.height || null,
      palier: r.tier || null,
      hauteurRetenue: r.height || null,
      debitBps: r.bitrate || null,
      // "declare" = lu dans le master HLS (AVERAGE-BANDWIDTH), "mesure" = calcule sur des
      // segments peses, "aucun" = la sonde n'a rien pu obtenir.
      origineDebit: r.bitrate ? (r.bitrateEstimated ? 'mesure' : 'declare') : 'aucun',
      // "flux" = lue par ffprobe dans le media faute d'etre annoncee, "playlist" = lue ou
      // deduite de la playlist, "libelle" = seule la source l'annonce, "aucune" = inconnue.
      origineResolution: r.resolutionSource || 'aucune',
      segmentsPeses: r.bitrateSamples || null,
      tailleOctets: r.bytes || null,
    })),
  };
}

// Quels flux sont connus pour ce titre, lequel est (ou a ete) lu, et ce que le calage a
// trouve. `compute` force le calcul au lieu de se contenter de ce qui est deja en cache --
// c'est la facon de le tester sans lancer Nuvio.
async function subtitleSync(type, id, { compute = false } = {}) {
  const { tmdbId, season, episode } = await resolveId(type, id);
  const content = `${type}:${tmdbId}:${season ?? ''}:${episode ?? ''}`;

  // Construire la liste garantit que les flux sont enregistres: sans ouverture de fiche
  // prealable, le registre serait vide et le diagnostic ne montrerait rien.
  await buildStreams({ tmdbId, type, season, episode });
  const [tracks, ffmpeg] = await Promise.all([
    subtitles.collectTracks({ type, tmdbId, season, episode }),
    subsync.enabled(),
  ]);

  const known = playback.forContent(content);
  const playing = playback.current(content, { fallbackToFirst: true });

  let calage = null;
  if (compute && playing && tracks.length > 0) {
    const vtt = await subtitles.fetchAsVtt(tracks[0].url);
    const plan = await subsync.planFor({
      streamUrl: playing.record.url,
      streamKey: playing.record.key,
      subtitleKey: tracks[0].url,
      vtt,
      refererUrl: playing.record.refererUrl,
      durationHint: playing.record.durationHint,
    });
    calage = { piste: tracks[0].lang, resume: subsync.describe(plan), plan };
  }

  return {
    content,
    actif: config.SUBTITLE_AUTOSYNC,
    ffmpegDisponible: ffmpeg,
    liaison: config.SUBTITLE_AUTOSYNC_BIND,
    seuilConfiance: config.SUBTITLE_AUTOSYNC_MIN_CONFIDENCE,
    fluxConnus: known.map((r) => ({ id: r.id, libelle: r.label, cle: r.key, dureeTmdb: r.durationHint })),
    // `certain: false` = rien n'a ete observe par le proxy, c'est le mieux classe qui est
    // propose. Le calage ne s'appuie dessus que si SUBTITLE_AUTOSYNC_GUESS_STREAM est actif.
    fluxRetenu: playing ? { libelle: playing.record.label, certain: playing.certain } : null,
    pistes: tracks.map((t) => ({ lang: t.lang, fournisseur: t.provider })),
    calage,
  };
}

module.exports = { rawLinks, extraction, streams, subtitleSync };
