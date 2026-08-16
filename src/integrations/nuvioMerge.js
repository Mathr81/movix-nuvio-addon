const nuvio = require('./nuvioCloud');
const ids = require('./nuvioIds');

/**
 * Fusion des entrees Nuvio identifiees par un id IMDb vers la forme canonique `tmdb:`.
 *
 * Le probleme repare: deux ecrivains fabriquaient leur `content_id` chacun de son cote
 * (voir nuvioIds.js), donc la meme serie existait en double dans Nuvio -- `tt0903747` et
 * `tmdb:1396` pour Breaking Bad -- avec une progression differente dans chaque
 * exemplaire. Les nouveaux ecrits ne peuvent plus diverger; restent les lignes deja
 * enregistrees, que cette operation ramene sur une seule cle.
 *
 * Regle de fusion: quand les deux formes portent le MEME episode, on garde la position
 * la plus avancee. C'est la meme regle que le hub applique a ses conflits, et la seule
 * qui ne fasse jamais reculer une reprise de lecture.
 *
 * L'operation est idempotente: relancee sans rien a fusionner, elle n'ecrit pas.
 */

/** Cle canonique d'une ligne de progression / d'un element vu. */
function entryKey(type, tmdbId, season, episode) {
  return season ? `${type}:${tmdbId}:${season}:${episode}` : `${type}:${tmdbId}`;
}

function rowType(row) {
  return row?.content_type === 'series' ? 'series' : 'movie';
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Resout le tmdbId de chaque ligne et les regroupe par cle canonique. Les lignes dont
 * l'id est irresolvable (IMDb inconnu de TMDB) sont laissees telles quelles: les
 * fusionner "au mieux" reviendrait a inventer une correspondance.
 */
async function groupByCanonical(rows) {
  const groups = new Map();
  const unresolved = [];

  await Promise.all(
    rows.map(async (row) => {
      const type = rowType(row);
      const tmdbId = await ids.toTmdbId(row.content_id, type);
      if (!tmdbId) {
        unresolved.push(row);
        return;
      }
      const season = Number(row.season) || null;
      const episode = Number(row.episode) || null;
      const key = entryKey(type, tmdbId, season, episode);
      if (!groups.has(key)) groups.set(key, { type, tmdbId, season, episode, rows: [] });
      groups.get(key).rows.push(row);
    }),
  );

  return { groups, unresolved };
}

/** La ligne qui fait foi dans un groupe: position la plus avancee, puis la plus recente. */
function bestRow(rows) {
  return rows.reduce((best, row) => {
    if (!best) return row;
    const byPosition = num(row.position) - num(best.position);
    if (byPosition !== 0) return byPosition > 0 ? row : best;
    return num(row.last_watched) > num(best.last_watched) ? row : best;
  }, null);
}

/**
 * Un groupe est a fusionner des qu'il contient au moins une ligne heritee. Un groupe
 * entierement canonique n'a rien a faire ici, meme s'il compte plusieurs lignes.
 */
function needsMerge(group) {
  return group.rows.some((row) => ids.isLegacyId(row.content_id));
}

// --- Suppression des lignes heritees ---------------------------------------

/**
 * L'API Nuvio n'expose que des `sync_push_*` additifs: reecrire l'entree canonique ne
 * fait pas disparaitre l'exemplaire IMDb. On cherche donc, dans ce que PostgREST annonce
 * lui-meme, de quoi supprimer -- une RPC dediee, sinon un DELETE sur la table.
 *
 * Rien n'est devine: si aucune des deux voies n'existe ou n'est autorisee (RLS), on le
 * dit et on laisse les lignes en place plutot que de pretendre les avoir retirees. La
 * fusion des positions, elle, aura de toute facon eu lieu.
 */
const TABLE_HINTS = {
  progress: ['watch_progress', 'user_watch_progress', 'sync_watch_progress'],
  watched: ['watched_items', 'user_watched_items', 'sync_watched_items'],
};

async function deleteStrategy(kind) {
  const { rpcs, tables } = await nuvio.listEndpoints();

  const rpcName = rpcs.find(
    (name) => /(delete|remove)/i.test(name) && new RegExp(kind === 'progress' ? 'progress' : 'watched', 'i').test(name),
  );
  if (rpcName) return { via: `rpc:${rpcName}`, rpcName };

  const table = TABLE_HINTS[kind].find((candidate) => tables.includes(candidate));
  if (table) return { via: `table:${table}`, table };

  return null;
}

/**
 * Corps d'appel construit depuis la signature annoncee, et non depuis une convention
 * supposee: le parametre qui parle du profil recoit le profil, l'autre recoit les cles.
 * Un nom au pluriel (`p_keys`) attend le lot entier, un nom au singulier une cle par appel.
 */
function buildBody(params, profileId, keys) {
  const body = {};
  for (const param of params) {
    body[param] = /profile/i.test(param) ? profileId : keys;
  }
  return body;
}

const wantsBatch = (params) => params.some((p) => !/profile/i.test(p) && /s$/i.test(p));

/**
 * Champs candidats pour la cle attendue.
 *
 * `row.id` est un UUID technique, alors que la cle logique d'une entree ressemble a
 * `tt0903747_s1e5`. Rien n'indique laquelle la fonction veut, donc on essaie -- et on
 * VERIFIE en relisant, plutot que de croire un appel qui n'a pas leve d'erreur.
 */
function keyFieldCandidates(rows) {
  const sample = rows[0] || {};
  const named = ['key', 'entry_key', 'item_key'].filter((f) => sample[f] != null);
  // Repli sans connaitre le nom du champ: celui dont la valeur derive du content_id.
  const derived = Object.keys(sample).filter(
    (f) =>
      !named.includes(f) &&
      typeof sample[f] === 'string' &&
      sample.content_id &&
      sample[f] !== sample.content_id &&
      sample[f].startsWith(String(sample.content_id)),
  );
  return [...named, ...derived, 'id'].filter((f, i, all) => all.indexOf(f) === i && sample[f] != null);
}

/** Un seul essai de suppression, pour un champ de cle donne. */
async function attemptDelete(strategy, profileId, rows, field) {
  const keys = rows.map((row) => row[field]).filter((k) => k !== undefined && k !== null);
  if (keys.length === 0) return { tente: 0 };

  if (strategy.table) {
    for (const key of keys) await nuvio.removeRows(strategy.table, { [field]: `eq.${key}` });
    return { tente: keys.length };
  }

  // La signature vient de la spec; si elle est muette, de l'erreur que PostgREST renvoie.
  let params = (await nuvio.rpcParameters(strategy.rpcName)) || ['p_keys', 'p_profile_id'];
  try {
    await callRpc(strategy.rpcName, params, profileId, keys);
  } catch (err) {
    const fromHint = nuvio.paramsFromHint(err, strategy.rpcName);
    if (!fromHint || fromHint.join() === params.join()) throw err;
    params = fromHint;
    await callRpc(strategy.rpcName, params, profileId, keys);
  }
  return { tente: keys.length, params: params.join(', ') };
}

async function callRpc(rpcName, params, profileId, keys) {
  if (wantsBatch(params)) {
    // Lots bornes: une liste de plusieurs centaines de cles fait grossir le corps sans
    // raison, et une erreur au milieu deviendrait tout ou rien.
    for (let i = 0; i < keys.length; i += 200) {
      await nuvio.rpc(rpcName, buildBody(params, profileId, keys.slice(i, i + 200)));
    }
    return;
  }
  for (const key of keys) await nuvio.rpc(rpcName, buildBody(params, profileId, key));
}

/**
 * Supprime les lignes heritees, en essayant chaque champ de cle plausible et en
 * verifiant apres coup ce qui a REELLEMENT disparu -- une RPC peut accepter un appel
 * sans rien supprimer, et un resume qui annonce 48 suppressions imaginaires est pire
 * qu'un resume qui admet n'avoir rien fait.
 */
async function deleteRows(kind, profileId, rows, recount) {
  if (rows.length === 0) return { supprimees: 0 };

  const strategy = await deleteStrategy(kind);
  if (!strategy) {
    return {
      supprimees: 0,
      restantes: rows.length,
      note:
        "l'API ne publie ni RPC de suppression ni acces direct a la table: les entrees IMDb " +
        'ont ete fusionnees (position a jour sur la cle tmdb) mais restent visibles. ' +
        'Supprime-les depuis Nuvio, ou relance apres avoir verifie /debug/nuvio/api.',
    };
  }

  const avant = rows.length;
  const essais = [];

  for (const field of keyFieldCandidates(rows)) {
    try {
      const { tente, params } = await attemptDelete(strategy, profileId, rows, field);
      if (!tente) continue;
      const restantes = await recount();
      essais.push(`${field}: ${avant - restantes}/${avant} supprimee(s)`);
      if (restantes === 0) {
        return { supprimees: avant, via: strategy.via, cle: field, ...(params ? { signature: params } : {}) };
      }
      if (restantes < avant) {
        return { supprimees: avant - restantes, restantes, via: strategy.via, cle: field, essais };
      }
    } catch (err) {
      essais.push(`${field}: ${err.message.slice(0, 200)}`);
    }
  }

  return {
    supprimees: 0,
    restantes: avant,
    via: strategy.via,
    essais,
    note:
      'la fusion des positions a bien eu lieu (les entrees tmdb sont a jour), mais aucune ' +
      'cle acceptee par la fonction de suppression: les exemplaires IMDb restent visibles. ' +
      'Envoie la sortie de /debug/nuvio/sample pour identifier le champ attendu.',
  };
}

// --- Fusion par collection --------------------------------------------------

/**
 * Bibliotheque: `sync_push_library` REMPLACE la liste entiere, donc supprimer une entree
 * revient a ne pas la renvoyer. Aucune suppression n'est necessaire ici -- il suffit de
 * reecrire chaque ligne sur sa cle canonique et de dedupliquer.
 */
async function mergeLibrary(profileId, dryRun) {
  const rows = await nuvio.pullLibrary(profileId);
  const legacy = rows.filter((row) => ids.isLegacyId(row.content_id));
  if (legacy.length === 0) return { fusionnees: 0 };

  const merged = new Map();
  for (const row of rows) {
    const type = rowType(row);
    const tmdbId = await ids.toTmdbId(row.content_id, type);
    // Irresolvable: on la garde sous sa cle d'origine, la perdre serait pire.
    const contentId = tmdbId ? ids.contentIdFor(tmdbId) : row.content_id;
    const existing = merged.get(contentId);
    // A cle egale, la fiche la plus anciennement ajoutee gagne: c'est la date que
    // l'utilisateur a vue s'afficher, et elle ordonne la bibliotheque.
    if (!existing || num(row.added_at) < num(existing.added_at)) {
      merged.set(contentId, { ...row, content_id: contentId });
    }
  }

  const finalRows = [...merged.values()];
  if (!dryRun) await nuvio.pushLibrary(profileId, finalRows);
  return { fusionnees: legacy.length, avant: rows.length, apres: finalRows.length };
}

async function mergeProgress(profileId, dryRun) {
  const rows = await nuvio.pullWatchProgress(profileId);
  const { groups } = await groupByCanonical(rows);

  const entries = [];
  const toDelete = [];
  for (const group of groups.values()) {
    if (!needsMerge(group)) continue;

    const winner = bestRow(group.rows);
    const contentId = ids.contentIdFor(group.tmdbId);
    entries.push({
      content_id: contentId,
      content_type: group.type === 'series' ? 'series' : 'movie',
      video_id: ids.videoIdFor(contentId, group.season, group.episode),
      position: num(winner.position),
      duration: num(winner.duration),
      last_watched: num(winner.last_watched) || Date.now(),
      ...(group.season ? { season: group.season, episode: group.episode } : {}),
    });
    toDelete.push(...group.rows.filter((row) => ids.isLegacyId(row.content_id)));
  }

  if (entries.length === 0) return { fusionnees: 0 };
  if (dryRun) return { fusionnees: entries.length, aSupprimer: toDelete.length, apercu: entries.slice(0, 3) };

  await nuvio.pushWatchProgress(profileId, entries);
  const recount = async () =>
    (await nuvio.pullWatchProgress(profileId)).filter((row) => ids.isLegacyId(row?.content_id)).length;
  return { fusionnees: entries.length, ...(await deleteRows('progress', profileId, toDelete, recount)) };
}

async function mergeWatched(profileId, dryRun) {
  const rows = await nuvio.pullWatchedItems(profileId);
  const { groups } = await groupByCanonical(rows);

  const items = [];
  const toDelete = [];
  for (const group of groups.values()) {
    if (!needsMerge(group)) continue;

    const winner = bestRow(group.rows);
    items.push({
      content_id: ids.contentIdFor(group.tmdbId),
      content_type: group.type === 'series' ? 'series' : 'movie',
      title: winner.title || `TMDB ${group.tmdbId}`,
      ...(group.season ? { season: group.season, episode: group.episode } : {}),
      watched_at: num(winner.watched_at) || Date.now(),
    });
    toDelete.push(...group.rows.filter((row) => ids.isLegacyId(row.content_id)));
  }

  if (items.length === 0) return { fusionnees: 0 };
  if (dryRun) return { fusionnees: items.length, aSupprimer: toDelete.length };

  await nuvio.pushWatchedItems(profileId, items);
  const recount = async () =>
    (await nuvio.pullWatchedItems(profileId)).filter((row) => ids.isLegacyId(row?.content_id)).length;
  return { fusionnees: items.length, ...(await deleteRows('watched', profileId, toDelete, recount)) };
}

/**
 * Fusionne les trois collections. `dryRun` releve ce qui serait fusionne sans rien
 * ecrire -- a lancer en premier sur un compte deja peuple.
 */
async function mergeLegacyIds(profileId, { dryRun = false } = {}) {
  const summary = { ok: true, dryRun, profileId, errors: {} };

  for (const [name, run] of [
    ['library', mergeLibrary],
    ['progress', mergeProgress],
    ['watched', mergeWatched],
  ]) {
    try {
      summary[name] = await run(profileId, dryRun);
    } catch (err) {
      summary.ok = false;
      summary.errors[name] = err.message;
    }
  }

  if (Object.keys(summary.errors).length === 0) delete summary.errors;
  return summary;
}

/** Nombre d'entrees encore identifiees en IMDb, sans rien modifier. */
async function countLegacy(profileId) {
  const [library, watched, progress] = await Promise.all([
    nuvio.pullLibrary(profileId),
    nuvio.pullWatchedItems(profileId).catch(() => []),
    nuvio.pullWatchProgress(profileId).catch(() => []),
  ]);
  const count = (rows) => rows.filter((row) => ids.isLegacyId(row?.content_id)).length;
  return { library: count(library), watched: count(watched), progress: count(progress) };
}

module.exports = { mergeLegacyIds, countLegacy };
