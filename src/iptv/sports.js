const axios = require('axios');
const config = require('../core/config');
const epg = require('./epg');

/**
 * Entrees "Matchs" de la playlist: un match a venir ou en cours, nomme comme ESPN le nomme,
 * qui pointe vers la chaine qui le diffuse.
 *
 * Pourquoi: l'onglet Sports de Nuvio Enhanced lit les matchs sur ESPN et cherche, dans la
 * playlist, une chaine dont le NOM contient les deux equipes telles qu'ESPN les ecrit
 * (`shortDisplayName`: "Man United", "Rennes") -- ou un diffuseur americain. Nos chaines
 * s'appellent "Canal+ Foot", jamais "Rennes - Lille": il ne trouvait donc rien.
 *
 * Le guide, lui, sait ce que diffuse chaque chaine ("Football : Ligue 1" / "Rennes /
 * Lille"). On recoupe donc les deux: un match ESPN qui commence pendant un programme dont
 * le texte cite ses deux equipes devient une entree "Rennes - Lille · beIN SPORTS 1 ·
 * 15:00", jouant cette chaine.
 *
 * Nuvio garde la liste des chaines en cache jusqu'au prochain rafraichissement manuel: les
 * entrees couvrent donc les matchs des ~30 prochaines heures, heure comprise dans le nom.
 */

// Memes ligues que l'onglet Sports du fork (LiveTvSports.kt): inutile de nommer un match
// qu'il n'affichera pas.
const LEAGUES = [
  'soccer/eng.1', 'soccer/esp.1', 'soccer/ita.1', 'soccer/ger.1', 'soccer/fra.1',
  'soccer/uefa.champions', 'soccer/uefa.europa', 'basketball/nba', 'football/nfl',
  'hockey/nhl', 'baseball/mlb', 'mma/ufc',
];

const EVENTS_TTL_MS = 30 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;
const LOOKAHEAD_MS = 30 * 60 * 60 * 1000;
const LOOKBEHIND_MS = 3 * 60 * 60 * 1000;
// Un programme commence souvent avant le coup d'envoi (avant-match), rarement apres.
const EARLY_MS = 20 * 60 * 1000;
const MAX_ENTRIES = 60;

// Mots trop communs pour designer une equipe a eux seuls.
const GENERIC = new Set([
  'city', 'united', 'town', 'saint', 'real', 'sporting', 'athletic', 'atletico', 'club', 'olympique',
  'stade', 'racing', 'inter', 'new', 'york', 'los', 'angeles', 'san', 'state', 'golden', 'the',
  'west', 'north', 'south', 'east', 'fc', 'afc', 'ac', 'sc', 'rc', 'as', 'cf', 'de', 'del', 'la', 'le',
]);

// Ecritures francaises du guide pour des noms ESPN anglais.
const FRENCH = {
  athens: 'athenes', lisbon: 'lisbonne', copenhagen: 'copenhague', brugge: 'bruges', internazionale: 'inter milan',
  olympiacos: 'olympiakos', 'paris saint germain': 'paris sg psg', 'red star': 'etoile rouge', seville: 'seville',
  bayern: 'bayern', cologne: 'cologne', napoli: 'naples', 'man united': 'manchester united', 'man city': 'manchester city',
  'c palace': 'crystal palace', 'nottm forest': 'nottingham forest', wolves: 'wolverhampton',
};

function normalize(text) {
  return ` ${String(text || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()} `;
}

/** Le texte d'un programme designe-t-il cette equipe ? Nom complet, ou un mot distinctif. */
function mentions(text, team) {
  const names = [team.short, team.name];
  for (const [en, fr] of Object.entries(FRENCH)) if (names.some((n) => normalize(n).includes(` ${en} `))) names.push(fr);
  return names.some((name) => {
    const phrase = normalize(name);
    if (phrase.trim() && text.includes(phrase)) return true;
    return phrase.trim().split(' ').some((word) => word.length >= 4 && !GENERIC.has(word) && text.includes(` ${word} `));
  });
}

/** Jours ESPN (calendrier de l'Est americain, UTC-5) d'aujourd'hui et demain. */
function espnDays(now = Date.now()) {
  return [0, 1].map((offset) => new Date(now - 5 * 3600e3 + offset * 86400e3).toISOString().slice(0, 10).replace(/-/g, ''));
}

function parseEvents(data) {
  return (data?.events || []).flatMap((event) => {
    const competition = event.competitions?.[0];
    const teams = (competition?.competitors || []).map((c) => ({
      name: c.team?.displayName || c.athlete?.displayName || '',
      short: c.team?.shortDisplayName || c.athlete?.shortName || c.team?.displayName || '',
      home: c.homeAway === 'home',
    }));
    const start = Date.parse(event.date);
    if (teams.length !== 2 || !start || competition?.status?.type?.state === 'post') return [];
    // Ordre de l'affiche: domicile d'abord, comme dans les guides francais.
    teams.sort((a, b) => Number(b.home) - Number(a.home));
    return [{ id: String(event.id), start, teams }];
  });
}

let events = { at: 0, list: [] };
let loading = null;

async function loadEvents() {
  if (Date.now() - events.at < EVENTS_TTL_MS) return events.list;
  if (loading) return loading;
  loading = (async () => {
    const urls = LEAGUES.flatMap((league) =>
      espnDays().map((day) => `https://site.api.espn.com/apis/site/v2/sports/${league}/scoreboard?dates=${day}`),
    );
    const results = await Promise.allSettled(urls.map((url) => axios.get(url, { timeout: FETCH_TIMEOUT_MS })));
    const byId = new Map();
    for (const result of results) {
      if (result.status === 'fulfilled') for (const event of parseEvents(result.value.data)) byId.set(event.id, event);
    }
    // Panne totale d'ESPN: on garde la liste precedente plutot que de vider l'onglet.
    if (byId.size > 0 || results.some((r) => r.status === 'fulfilled')) events = { at: Date.now(), list: [...byId.values()] };
    return events.list;
  })().finally(() => {
    loading = null;
  });
  return loading;
}

const PARIS = { timeZone: 'Europe/Paris' };

/** `15:00` aujourd'hui, `mar. 01:00` un autre jour: la liste reste en cache plus d'un jour. */
function paris(ms, now = Date.now()) {
  const time = new Date(ms).toLocaleTimeString('fr-FR', { ...PARIS, hour: '2-digit', minute: '2-digit' });
  const day = (t) => new Date(t).toLocaleDateString('fr-FR', PARIS);
  return day(ms) === day(now) ? time : `${new Date(ms).toLocaleDateString('fr-FR', { ...PARIS, weekday: 'short' })} ${time}`;
}

/** Rapproche matchs et programmes: [{ event, channel, name }], tries par heure. */
function match(eventList, channels, programmes, now = Date.now()) {
  const found = [];
  const seen = new Set();
  const upcoming = eventList.filter((e) => e.start > now - LOOKBEHIND_MS && e.start < now + LOOKAHEAD_MS);
  for (const channel of channels) {
    for (const programme of programmes.get(channel.tvgId) || []) {
      const candidates = upcoming.filter((e) => e.start >= programme.start - EARLY_MS && e.start < programme.stop);
      if (candidates.length === 0) continue;
      const text = normalize(`${programme.title} ${programme.sub || ''} ${programme.desc || ''}`);
      for (const event of candidates) {
        const id = `${event.id}:${channel.key}`;
        if (seen.has(id) || !event.teams.every((team) => mentions(text, team))) continue;
        seen.add(id);
        found.push({
          event,
          channel,
          name: `${event.teams[0].short} - ${event.teams[1].short} · ${channel.name} · ${paris(event.start, now)}`,
        });
      }
    }
  }
  return found.sort((a, b) => a.event.start - b.event.start).slice(0, MAX_ENTRIES);
}

// stream_id Xtream synthetique -> cle de la chaine, pour la lecture et le guide court.
const byStreamId = new Map();

function streamIdOf(entry) {
  let hash = 0;
  for (const char of `${entry.event.id}:${entry.channel.key}`) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  // Hors de la plage des vraies chaines (numericId de lineup.js).
  return 900000000 + (hash % 99999999);
}

/** Entrees "Matchs" pour la grille courante. Ne bloque jamais la playlist sur ESPN. */
async function entries(channels) {
  if (!config.IPTV_SPORTS_MATCHES || !epg.enabled()) return [];
  try {
    const withGuide = channels.filter((channel) => channel.tvgId);
    const [eventList, programmes] = await Promise.all([
      loadEvents(),
      epg.programmes(new Set(withGuide.map((channel) => channel.tvgId))),
    ]);
    const found = match(eventList, withGuide, programmes);
    for (const entry of found) {
      entry.streamId = streamIdOf(entry);
      byStreamId.set(String(entry.streamId), entry.channel.key);
    }
    return found;
  } catch (err) {
    console.warn(`[iptv] matchs indisponibles: ${err.message}`);
    return [];
  }
}

/**
 * Chaine derriere un stream_id de match. Apres un redemarrage la table est vide: on la
 * reconstruit une fois avant de conclure a un identifiant inconnu.
 */
async function channelOfStreamId(id, view) {
  if (!byStreamId.has(String(id)) && Number(id) >= 900000000) await entries(view.channels);
  return view.byKey.get(byStreamId.get(String(id))) || null;
}

module.exports = { entries, channelOfStreamId, match, mentions, normalize, parseEvents };
