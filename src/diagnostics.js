const config = require('./core/config');
const subtitles = require('./streaming/subtitles');
const streamProxy = require('./streaming/streamProxy');
const { resolveId } = require('./catalog/idResolver');
const { collectRawLinks, resolveStreams, buildStreams, langGroupsOf } = require('./streaming/streamBuilder');
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
      // Un lien direct proxifie ne dit rien de ce qu'il sert: sa cible, si.
      cible: streamProxy.targetOf(r.url) || null,
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
//   local        l'addon l'a extrait seul (voe, veev, darkibox, oneupload, sharecloudy)
//   server-only  extractible, mais par Movix seulement -- il manque une cle VIP valide
//                ou l'extraction amont a echoue
async function extraction(type, id) {
  const { tmdbId, season, episode } = await resolveId(type, id);
  const raw = await collectRawLinks({ tmdbId, type, season, episode });
  const embeds = raw.filter((r) => !r.direct && r.url);

  const results = await Promise.all(
    embeds.map(async (item) => {
      const hoster = detectHoster(item.url, item.player);
      // Meme sans hebergeur connu, le lecteur jwplayer generique peut encore le lire.
      const outcome = await extractDirectUrl(item.url, item.player);
      if (!hoster && !outcome.ok) {
        return { source: item.sourceName, url: item.url, hoster: null, issue: 'aucun extracteur' };
      }
      return {
        source: item.sourceName,
        hoster: outcome.hoster || hoster,
        url: item.url,
        extracteur: !hoster || LOCAL_EXTRACTORS.has(hoster) ? 'local' : 'Movix (resolve=1)',
        ok: outcome.ok,
        resultat: outcome.ok ? outcome.url : undefined,
        issue: outcome.ok ? undefined : `${outcome.reason}${outcome.status ? ` (${outcome.status})` : ''}`,
      };
    }),
  );

  return {
    tmdbId,
    // Les liens deja resolus par Movix (`direct`) n'ont rien a extraire et n'apparaissent
    // pas ci-dessous: sans ces deux nombres, "0/30 extraits" se lit comme "aucun flux",
    // alors que les flux jouables sont justement ceux qui ne sont pas ici.
    liensBruts: raw.length,
    resolusParMovix: raw.length - embeds.length,
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
async function streams(type, id, { refresh = false } = {}) {
  const { tmdbId, season, episode } = await resolveId(type, id);
  // `wait`: on veut l'etat FINAL des mesures, pas celui de la premiere reponse.
  const resolved = await resolveStreams({ tmdbId, type, season, episode, wait: true, refresh });
  const built = await buildStreams({ tmdbId, type, season, episode });
  // Ligne telle que Nuvio l'affiche, retrouvee par l'URL: absente = masquee par l'elagage.
  const shown = new Map(built.map((s) => [s.url || s.externalUrl, s]));

  return {
    tmdbId,
    type,
    // Cette liste montre TOUT ce qui a ete resolu; le mode compact en masque une partie
    // a l'affichage. Donner les deux nombres evite de croire a une source perdue.
    mode: config.STREAM_LIST,
    total: resolved.length,
    affichesDansNuvio: built.length,
    // Voies de mesure momentanement ecartees (un service qui ne repond plus).
    ecartes: probeBreakerState(),
    streams: resolved.map((r) => ({
      source: r.sourceName,
      // Hebergeur extrait par l'addon (byse, mixdrop...): la source seule ne dit pas d'ou vient le fichier.
      hebergeur: r.hoster || undefined,
      // Autres sources qui renvoyaient le MEME fichier, fusionnees dans ce lien.
      aussiChez: r.alsoFrom?.length ? r.alsoFrom : undefined,
      // Sous-serveur annonce par la source (lecteur, fournisseur agrege) et langue normalisee.
      serveur: r.player || undefined,
      variante: r.variant || undefined,
      langue: r.lang || null,
      langueDesPistes: r.langFromAudio || undefined,
      pistesAudio: r.audioLangs?.length ? r.audioLangs : undefined,
      // Sous-titres integres au master HLS (distincts de ceux que la source joint au lien).
      sousTitresFlux: r.subtitleLangs?.length ? r.subtitleLangs : undefined,
      groupesLangue: langGroupsOf(r, null),
      sousTitres: r.subtitles?.length ? [...new Set(r.subtitles.map((t) => t.lang))] : undefined,
      externe: !!r.externalUrl,
      libelleNuvio: shown.get(r.url || r.externalUrl)?.title ?? null,
      proxifie: streamProxy.isProxied(r.url),
      injoignable: r.unreachable || undefined,
      cible: streamProxy.targetOf(r.url) || r.url,
      // Lien que le lecteur de la WebUI peut ouvrir: un lien direct passe par le proxy,
      // seul a poser le CORS dont hls.js a besoin. L'indice fait reecrire les playlists
      // servies par un proxy HLS (`...-proxy?url=...m3u8`), sinon leurs URI relatives
      // seraient resolues contre notre proxy.
      lecture: streamProxy.isProxied(r.url) || !config.STREAM_PROXY_ENABLED ? r.url : streamProxy.proxyUrl(r.url, { playlistHints: ['m3u8'] }),
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

// Sous-titres d'un titre: ce que rend chaque fournisseur (interroge sans cache: c'est un
// test), ce que Nuvio recoit -- chaque piste reellement telechargee et convertie -- et ce
// que les sources livrent avec leurs flux (Movy, KissKH).
async function subtitleReport(type, id) {
  const { tmdbId, season, episode } = await resolveId(type, id);
  const publicBaseUrl = config.PUBLIC_URL || `http://127.0.0.1:${config.PORT}`;

  const [fournisseurs, tracks, resolved] = await Promise.all([
    Promise.all(
      subtitles.PROVIDERS.map(async (provider) => {
        const startedAt = Date.now();
        const base = { id: provider.id, nom: provider.name, actif: config.SUBTITLE_PROVIDERS.includes(provider.id) };
        try {
          const found = await provider.search({ type, tmdbId, season, episode, langs: config.SUBTITLE_LANGS });
          return { ...base, ok: true, ms: Date.now() - startedAt, pistes: found.length, langues: [...new Set(found.map((f) => f.lang))] };
        } catch (err) {
          return { ...base, ok: false, ms: Date.now() - startedAt, erreur: err.message };
        }
      }),
    ),
    subtitles.collectTracks({ type, tmdbId, season, episode }),
    resolveStreams({ tmdbId, type, season, episode }).catch(() => []),
  ]);

  const pistes = await Promise.all(
    tracks.map(async (track) => {
      const row = { lang: track.lang, fournisseur: track.provider, url: subtitles.subtitleUrl(publicBaseUrl, track.url) };
      try {
        const vtt = await subtitles.fetchAsVtt(track.url);
        return { ...row, repliques: (vtt.match(/-->/g) || []).length };
      } catch (err) {
        return { ...row, erreur: err.message };
      }
    }),
  );

  const parSource = new Map();
  for (const link of resolved) {
    for (const sub of link.subtitles || []) {
      if (!parSource.has(link.sourceName)) parSource.set(link.sourceName, new Set());
      parSource.get(link.sourceName).add(sub.lang);
    }
  }

  return {
    langues: config.SUBTITLE_LANGS,
    fournisseurs,
    pistes,
    sources: [...parSource].map(([source, langs]) => ({ source, langues: [...langs] })),
  };
}

module.exports = { rawLinks, extraction, streams, subtitleReport };