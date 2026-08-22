const crypto = require('crypto');
const config = require('../core/config');
const cache = require('../core/cache');

/**
 * Quel flux est en train d'etre lu.
 *
 * Le protocole Stremio ne le dit pas: la ressource `subtitles` recoit un type et un id de
 * contenu, jamais le flux choisi. C'est genant des lors qu'on veut CALER les sous-titres,
 * puisque le decalage n'existe pas dans l'absolu -- il depend du release precis qu'on
 * regarde. La meme piste peut etre juste sur le lien Coflix et avancee de huit secondes
 * sur le lien PurStream.
 *
 * Deux facons de retrouver l'information, complementaires:
 *
 *  1. `register` + un identifiant court porte par l'URL du sous-titre. Sans ambiguite,
 *     mais suppose que le lecteur accepte les pistes rattachees a un flux
 *     (`stream.subtitles`), ce que tous ne font pas.
 *
 *  2. `note`, appele par le proxy de flux a chaque requete. Quand le lecteur demande une
 *     piste, la lecture a DEJA commence: le proxy vient de servir la playlist du flux
 *     choisi, quelques secondes plus tot. Le dernier flux servi pour ce titre est donc
 *     celui qu'on regarde -- ce n'est pas une supposition, c'est une observation.
 *     Ne vaut evidemment que pour les flux qui passent par le proxy.
 *
 * Les enregistrements passent par le cache (donc persistes): une URL de sous-titre remise a
 * un lecteur doit continuer a designer son flux apres un redemarrage de l'addon. Les acces,
 * eux, restent en memoire -- "ce qui est en train d'etre lu" n'a aucun sens apres un arret.
 */

const TTL_MS = 24 * 60 * 60 * 1000;
const hits = new Map();
// Index inverse amont -> flux enregistre, pour reconnaitre en O(1) ce qui vient d'etre
// demande: `note` est appele pour CHAQUE segment, il ne peut pas parcourir une liste.
const owners = new Map();
const started = new Set();
let onFirstPlay = null;

function idOf(value) {
  return crypto.createHash('sha1').update(String(value)).digest('base64url').slice(0, 12);
}

/** Repertoire d'une URL: un segment et sa playlist le partagent, pas deux flux distincts. */
function folderOf(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname.replace(/\/[^/]*$/, '/')}`;
  } catch {
    return null;
  }
}

/**
 * Enregistre un flux servi au lecteur.
 * @param {{url:string, target?:string, content:string, key:string, refererUrl?:string, durationHint?:number, label?:string}} record
 * @returns {string} identifiant court, a placer dans l'URL du sous-titre
 */
function register(record) {
  const id = idOf(record.key || record.url);
  cache.set(`play:stream:${id}`, { ...record, id }, TTL_MS);

  const target = record.target || record.url;
  owners.set(target, id);
  const folder = folderOf(target);
  if (folder) owners.set(folder, id);
  return id;
}

/**
 * Liste des flux d'un contenu, dans l'ordre ou ils sont proposes.
 *
 * REMPLACEE a chaque scan, jamais completee: l'ordre est celui du tri par qualite, et il
 * change quand une source repond mieux ou moins bien. Une liste cumulative garderait en
 * tete le classement du premier scan, et des liens qui n'existent plus.
 */
function setOrder(content, ids) {
  cache.set(`play:content:${content}`, ids, TTL_MS);
}

function recall(id) {
  return cache.get(`play:stream:${id}`) || null;
}

/** Flux enregistres pour un contenu, dans l'ordre de la liste (donc du tri par qualite). */
function forContent(content) {
  return (cache.get(`play:content:${content}`) || []).map(recall).filter(Boolean);
}

/**
 * Signale qu'une URL amont vient d'etre demandee. Appele par le proxy de flux.
 *
 * L'appel est sur le chemin de CHAQUE segment: il doit rester une ecriture dans une Map.
 */
function note(targetUrl) {
  if (!targetUrl) return;
  const now = Date.now();
  hits.set(targetUrl, now);
  const folder = folderOf(targetUrl);
  if (folder) hits.set(folder, now);

  // Premiere requete sur ce flux: la lecture COMMENCE. C'est le meilleur moment pour
  // preparer le calage des sous-titres -- on sait enfin quel flux caler, et il reste les
  // quelques dizaines de secondes qu'il faut avant que quiconque ouvre le menu des pistes.
  const id = owners.get(targetUrl) || (folder && owners.get(folder));
  if (id && !started.has(id) && onFirstPlay) {
    started.add(id);
    const record = recall(id);
    if (record) Promise.resolve().then(() => onFirstPlay(record)).catch(() => {});
  }

  // Menage: une session de lecture cree une entree par segment (des centaines).
  if (hits.size > 400) {
    for (const [key, at] of hits) {
      if (now - at > 60 * 60 * 1000) hits.delete(key);
    }
    started.clear();
  }
}

/**
 * Callback declenche a la premiere requete d'un flux enregistre.
 * Pose par le module de sous-titres: la dependance va dans ce sens-la, jamais l'inverse
 * (le proxy de flux ne doit rien savoir des sous-titres).
 */
function whenPlaybackStarts(fn) {
  onFirstPlay = fn;
}

/** Date du dernier acces observe pour ce flux (sa playlist ou l'un de ses segments). */
function lastSeen(record) {
  const target = record.target || record.url;
  const folder = folderOf(target);
  return Math.max(hits.get(target) || 0, (folder && hits.get(folder)) || 0);
}

/**
 * Le flux le plus vraisemblablement en cours de lecture pour ce contenu.
 *
 * @param {string} content cle de contenu (type:tmdbId:saison:episode)
 * @param {{fallbackToFirst?:boolean}} options
 * @returns {{record:object, certain:boolean}|null}
 */
function current(content, { fallbackToFirst = false } = {}) {
  const records = forContent(content);
  if (records.length === 0) return null;

  let best = null;
  for (const record of records) {
    const at = lastSeen(record);
    if (at > 0 && (!best || at > best.at)) best = { record, at };
  }
  // Observe: le proxy a servi ce flux il y a peu. C'est la seule voie qui donne une
  // certitude, et donc la seule qui autorise a recaler sans risque de se tromper de release.
  if (best && Date.now() - best.at < config.SUBTITLE_AUTOSYNC_PLAYBACK_WINDOW_MS) {
    return { record: best.record, certain: true };
  }

  // Rien d'observe: le flux ne passe pas par le proxy (lien direct d'un service
  // d'extraction). Le premier de la liste est le mieux classe, donc le plus probable --
  // mais ce n'est qu'une probabilite, et l'appelant decide si elle suffit.
  return fallbackToFirst ? { record: records[0], certain: false } : null;
}

function describe(record) {
  return record ? `${record.label || 'flux'}` : 'aucun flux';
}

module.exports = { register, setOrder, recall, forContent, note, current, describe, idOf, whenPlaybackStarts };
