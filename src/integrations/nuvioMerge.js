const nuvio = require('./nuvioCloud');
const ids = require('./contentIds');

/**
 * Fusion des entrees Nuvio vers la forme configuree par ID_FORMAT.
 *
 * Le probleme repare: le `content_id` etait fabrique a trois endroits avec deux
 * politiques (voir contentIds.js), donc la meme serie existait en double dans Nuvio --
 * `tt0903747` et `tmdb:1396` pour Breaking Bad -- avec une progression differente dans
 * chaque exemplaire. Les nouveaux ecrits ne peuvent plus diverger; restent les lignes
 * deja enregistrees, que cette operation ramene sur une seule cle.
 *
 * La CIBLE suit le reglage: en mode imdb ce sont les entrees `tmdb:` qui sont fusionnees
 * vers `tt`, et l'inverse en mode tmdb. Changer ID_FORMAT et relancer bascule le compte.
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
  return group.rows.some((row) => ids.isForeign(row.content_id));
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

/**
 * TOUTES les voies plausibles, pas seulement la premiere.
 *
 * Une RPC qui existe n'est pas une RPC qui supprime: `sync_delete_watched_items` accepte
 * ses appels sans rien retirer tant qu'on ne lui donne pas la cle qu'elle attend, et rien
 * n'indique laquelle. Le DELETE direct sur la table, lui, filtre sur des colonnes qu'on
 * peut VOIR. On essaie donc les deux, et la relecture tranche.
 */
async function deleteStrategies(kind) {
  const { rpcs, tables } = await nuvio.listEndpoints();
  const matches = new RegExp(kind === 'progress' ? 'progress' : 'watched', 'i');
  const out = [];

  for (const name of rpcs) {
    if (/(delete|remove)/i.test(name) && matches.test(name)) out.push({ via: `rpc:${name}`, rpcName: name });
  }
  for (const table of TABLE_HINTS[kind]) {
    if (tables.includes(table)) out.push({ via: `table:${table}`, table });
  }
  return out;
}

/**
 * Corps d'appel construit depuis la signature annoncee.
 *
 * Seuls deux parametres sont renseignes: celui du profil et celui des cles. Tout le
 * reste part a `null` -- et c'est essentiel. `sync_delete_watched_items` est declaree
 * `(p_keys, p_origin_client_id, p_profile_id)`: remplir p_origin_client_id avec le
 * tableau de cles, comme le faisait la regle "tout ce qui n'est pas le profil recoit les
 * cles", faisait accepter l'appel sans rien supprimer. Un parametre dont on ignore le
 * sens se laisse vide, il ne s'invente pas.
 */
const isProfileParam = (param) => /profile/i.test(param);

/**
 * Le parametre qui porte les cles: celui qui le dit dans son nom, sinon le seul restant
 * une fois le profil ecarte. Sans ce repli, une signature sans "key" ne recevrait aucune
 * cle et l'appel ne supprimerait rien.
 */
function keyParamOf(params) {
  return params.find((p) => /key/i.test(p)) || params.find((p) => !isProfileParam(p)) || null;
}

function buildBody(params, profileId, keys) {
  const keyParam = keyParamOf(params);
  const body = {};
  for (const param of params) {
    if (isProfileParam(param)) body[param] = profileId;
    else if (param === keyParam) body[param] = keys;
    else body[param] = null;
  }
  return body;
}

const wantsBatch = (params) => /s$/i.test(keyParamOf(params) || '');

/**
 * Formes de cle a essayer, de la plus specifique a la plus large.
 *
 * Deux raisons de ne pas se contenter des champs bruts:
 *  - `row.id` est un UUID technique, alors que la cle logique d'une entree ressemble a
 *    `tt0903747_s1e5`, qui n'existe comme champ sur aucune ligne -- il faut la batir;
 *  - un champ peut etre renseigne pour les series et NUL pour les films (`video_id`),
 *    auquel cas il faut un repli pour les lignes qu'il laisse de cote.
 *
 * Une forme n'est retenue que si la relecture confirme la disparition des lignes: une
 * RPC peut accepter un appel sans rien supprimer.
 */
// `colonne: true` = le nom est aussi une colonne reelle, donc utilisable dans un filtre
// PostgREST. Les formes batties (`tt0903747_s1e5`) ne le sont pas: elles n'ont de sens
// que passees a la RPC, qui les interprete comme des cles logiques.
const KEY_FORMS = [
  // Colonnes de cle logique reellement observees: `watch_progress` porte un
  // `progress_key` valant `tt33546863_s1e1`. Les autres tables ont peut-etre leur
  // equivalent sans que la lecture ne le renvoie -- d'ou les formes batties plus bas.
  { nom: 'progress_key', colonne: true, valueOf: (row) => row.progress_key },
  { nom: 'watched_key', colonne: true, valueOf: (row) => row.watched_key },
  { nom: 'key', colonne: true, valueOf: (row) => row.key },
  { nom: 'entry_key', colonne: true, valueOf: (row) => row.entry_key },
  { nom: 'video_id', colonne: true, valueOf: (row) => row.video_id },
  {
    nom: 'content_id_sXeY',
    valueOf: (row) => (row.season ? `${row.content_id}_s${row.season}e${row.episode}` : row.content_id),
  },
  {
    nom: 'content_id:s:e',
    valueOf: (row) => (row.season ? `${row.content_id}:${row.season}:${row.episode}` : row.content_id),
  },
  // `p_keys` peut aussi attendre des objets composites plutot que des chaines: une
  // fonction qui supprime par (contenu, saison, episode) n'a pas besoin de cle plate.
  {
    nom: '{content_id,season,episode}',
    objet: true,
    valueOf: (row) =>
      row.season
        ? { content_id: row.content_id, season: Number(row.season), episode: Number(row.episode) }
        : { content_id: row.content_id },
  },
  // Sans saison ni episode: retire toutes les entrees de ce titre sous l'id a fusionner.
  // Sans danger ici, ces lignes ayant deja leur equivalent dans la forme configuree.
  { nom: 'content_id', colonne: true, valueOf: (row) => row.content_id },
  { nom: 'id', colonne: true, valueOf: (row) => row.id },
];

/**
 * Formes exploitables sur ce lot: au moins une ligne doit produire une valeur, et un
 * DELETE direct ne peut filtrer que sur une vraie colonne.
 */
function keyForms(rows, viaTable) {
  return KEY_FORMS.filter(
    (form) => (!viaTable || (form.colonne && !form.objet)) && rows.some((row) => form.valueOf(row) != null),
  );
}

/** Cles produites par une forme, dedupliquees (plusieurs episodes -> un seul content_id). */
function keysFor(rows, valueOf) {
  const vus = new Set();
  const out = [];
  for (const row of rows) {
    const value = valueOf(row);
    if (value === undefined || value === null) continue;
    // Les formes composites rendent des objets: `Set` ne les dedupliquerait pas.
    const empreinte = typeof value === 'object' ? JSON.stringify(value) : String(value);
    if (vus.has(empreinte)) continue;
    vus.add(empreinte);
    out.push(value);
  }
  return out;
}

/** Un seul essai de suppression, pour une forme de cle donnee. */
async function attemptDelete(strategy, profileId, keys, field) {
  if (keys.length === 0) return { tente: 0 };

  if (strategy.table) {
    // `profile_id` en plus de la cle: la RLS borne deja au compte, mais un profil se
    // trompe de voisin sans elle, et ces tables portent plusieurs profils.
    for (const key of keys) {
      await nuvio.removeRows(strategy.table, { [field]: `eq.${key}`, profile_id: `eq.${profileId}` });
    }
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
async function deleteRows(kind, profileId, rows, reload) {
  if (rows.length === 0) return { supprimees: 0 };

  const strategies = await deleteStrategies(kind);
  if (strategies.length === 0) {
    return {
      supprimees: 0,
      restantes: rows.length,
      note:
        "l'API ne publie ni RPC de suppression ni acces direct a la table: les entrees sont " +
        'fusionnees (la forme configuree est a jour) mais leurs doublons restent visibles. ' +
        'Supprime-les depuis Nuvio, ou verifie /debug/nuvio/api.',
    };
  }

  const total = rows.length;
  const essais = [];
  const reussites = [];
  let signature;
  let restants = rows;

  for (const strategy of strategies) {
    if (restants.length === 0) break;
    // Une forme peut ne couvrir qu'une partie du lot (`video_id` est nul sur les films):
    // on enchaine sur les lignes ENCORE presentes plutot que de s'arreter au premier
    // succes partiel, puis on passe a la voie suivante s'il en reste.
    const dejaTentees = new Set();

    for (const { nom: field, valueOf } of keyForms(restants, !!strategy.table)) {
      if (restants.length === 0) break;

      // Sur un film, `content_id_sXeY` et `content_id:s:e` retombent tous deux sur le
      // content_id nu: sans ce garde-fou, la meme requete partirait plusieurs fois.
      const keys = keysFor(restants, valueOf);
      const empreinte = JSON.stringify(keys);
      if (keys.length === 0 || dejaTentees.has(empreinte)) continue;
      dejaTentees.add(empreinte);

      let attempt;
      try {
        attempt = await attemptDelete(strategy, profileId, keys, field);
      } catch (err) {
        essais.push(`${strategy.via} / ${field}: ${err.message.slice(0, 160)}`);
        continue;
      }
      if (!attempt.tente) continue;
      if (attempt.params) signature = attempt.params;

      const avant = restants.length;
      restants = await reload();
      const gagnees = avant - restants.length;
      essais.push(`${strategy.via} / ${field}: ${gagnees}/${avant} supprimee(s)`);
      if (gagnees > 0) reussites.push(`${strategy.via} / ${field}`);
    }
  }

  const supprimees = total - restants.length;
  const result = { supprimees };
  if (reussites.length > 0) result.par = reussites.join(' + ');
  if (signature) result.signature = signature;
  if (restants.length > 0) {
    result.restantes = restants.length;
    result.essais = essais;
    result.voies = strategies.map((s) => s.via);
    result.note =
      'la fusion a bien eu lieu (la forme configuree est a jour), mais aucune voie n\'a fait ' +
      'disparaitre ces lignes. Si aucune table n\'apparait dans `voies`, PostgREST n\'expose ' +
      'que les RPC: leurs doublons doivent alors etre retires depuis Nuvio.';
  }
  return result;
}

// --- Fusion par collection --------------------------------------------------

/**
 * Bibliotheque: `sync_push_library` REMPLACE la liste entiere, donc supprimer une entree
 * revient a ne pas la renvoyer. Aucune suppression n'est necessaire ici -- il suffit de
 * reecrire chaque ligne sur sa cle canonique et de dedupliquer.
 */
async function mergeLibrary(profileId, dryRun) {
  const rows = await nuvio.pullLibrary(profileId);
  const legacy = rows.filter((row) => ids.isForeign(row.content_id));
  if (legacy.length === 0) return { fusionnees: 0 };

  const merged = new Map();
  for (const row of rows) {
    const type = rowType(row);
    const tmdbId = await ids.toTmdbId(row.content_id, type);
    // Irresolvable: on la garde sous sa cle d'origine, la perdre serait pire.
    const contentId = tmdbId ? await ids.contentIdFor(type, tmdbId) : row.content_id;
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
    const contentId = await ids.contentIdFor(group.type, group.tmdbId);
    entries.push({
      content_id: contentId,
      content_type: group.type === 'series' ? 'series' : 'movie',
      video_id: ids.videoIdFor(contentId, group.season, group.episode),
      position: num(winner.position),
      duration: num(winner.duration),
      last_watched: num(winner.last_watched) || Date.now(),
      ...(group.season ? { season: group.season, episode: group.episode } : {}),
    });
    toDelete.push(...group.rows.filter((row) => ids.isForeign(row.content_id)));
  }

  if (entries.length === 0) return { fusionnees: 0 };
  if (dryRun) return { fusionnees: entries.length, aSupprimer: toDelete.length, apercu: entries.slice(0, 3) };

  await nuvio.pushWatchProgress(profileId, entries);
  // Renvoie les lignes heritees ENCORE presentes: c'est sur elles que la forme de cle
  // suivante sera essayee, et c'est ce qui distingue un appel accepte d'un appel utile.
  const reload = async () =>
    (await nuvio.pullWatchProgress(profileId)).filter((row) => ids.isForeign(row?.content_id));
  return { fusionnees: entries.length, ...(await deleteRows('progress', profileId, toDelete, reload)) };
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
      content_id: await ids.contentIdFor(group.type, group.tmdbId),
      content_type: group.type === 'series' ? 'series' : 'movie',
      title: winner.title || `TMDB ${group.tmdbId}`,
      ...(group.season ? { season: group.season, episode: group.episode } : {}),
      watched_at: num(winner.watched_at) || Date.now(),
    });
    toDelete.push(...group.rows.filter((row) => ids.isForeign(row.content_id)));
  }

  if (items.length === 0) return { fusionnees: 0 };
  if (dryRun) return { fusionnees: items.length, aSupprimer: toDelete.length };

  await nuvio.pushWatchedItems(profileId, items);
  const reload = async () =>
    (await nuvio.pullWatchedItems(profileId)).filter((row) => ids.isForeign(row?.content_id));
  return { fusionnees: items.length, ...(await deleteRows('watched', profileId, toDelete, reload)) };
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
  const count = (rows) => rows.filter((row) => ids.isForeign(row?.content_id)).length;
  return { library: count(library), watched: count(watched), progress: count(progress) };
}

module.exports = { mergeLegacyIds, countLegacy };
