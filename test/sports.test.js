const test = require('node:test');
const assert = require('node:assert');
const { match, parseEvents } = require('../src/iptv/sports');

const H = 3600e3;
const now = Date.parse('2026-11-08T13:00:00Z');
const channel = (key, name, tvgId) => ({ key, name, tvgId });
const event = (id, start, home, away) => ({
  id,
  start,
  teams: [
    { short: home[0], name: home[1], home: true },
    { short: away[0], name: away[1], home: false },
  ],
});

test('matchs ESPN retrouves dans le guide, nommes comme ESPN', () => {
  const channels = [channel('beinsport1', 'beIN SPORTS 1', 'BeINSports1.fr'), channel('canalplusfoot', 'Canal+ Foot', 'CanalPlusFoot.fr')];
  const programmes = new Map([
    ['BeINSports1.fr', [{ start: now + 0.75 * H, stop: now + 3 * H, title: 'Football : Ligue 1', sub: 'Rennes / Lille', desc: '' }]],
    ['CanalPlusFoot.fr', [
      // Rediffusion d'un autre jour: meme affiche, mauvais horaire -> ignoree.
      { start: now - 2 * H, stop: now - 1 * H, title: 'Football : Premier League', sub: 'Brighton & Hove Albion / Brentford' },
      { start: now + 4.5 * H, stop: now + 7 * H, title: 'Football : Premier League', sub: 'Crystal Palace / Liverpool' },
      { start: now + 8 * H, stop: now + 10 * H, title: 'Football : Ligue des champions', sub: 'AEK Athènes / Real Madrid' },
    ]],
  ]);
  const events = [
    event('1', now + 1 * H, ['Rennes', 'Stade Rennais'], ['Lille', 'Lille']),
    event('2', now + 1 * H, ['Brighton', 'Brighton & Hove Albion'], ['Brentford', 'Brentford']),
    event('3', now + 5 * H, ['C Palace', 'Crystal Palace'], ['Liverpool', 'Liverpool']),
    event('4', now + 8 * H, ['AEK Athens', 'AEK Athens'], ['Real Madrid', 'Real Madrid']),
    // Bonne heure, mais equipes absentes du programme.
    event('5', now + 5 * H, ['Chelsea', 'Chelsea'], ['Arsenal', 'Arsenal']),
  ];
  const found = match(events, channels, programmes, now);
  assert.deepStrictEqual(found.map((f) => [f.event.id, f.channel.key]), [
    ['1', 'beinsport1'],
    ['3', 'canalplusfoot'],
    ['4', 'canalplusfoot'],
  ]);
  assert.match(found[0].name, /^Rennes - Lille · beIN SPORTS 1 · \d\d:\d\d$/);
  assert.match(found[1].name, /^C Palace - Liverpool · /);
});

test('lecture du scoreboard ESPN: domicile d abord, matchs termines ecartes', () => {
  const competitor = (homeAway, short, name) => ({ homeAway, team: { shortDisplayName: short, displayName: name } });
  const events = parseEvents({
    events: [
      { id: '9', date: '2026-11-10T00:00Z', competitions: [{ status: { type: { state: 'pre' } }, competitors: [competitor('away', 'Lakers', 'Los Angeles Lakers'), competitor('home', 'Hawks', 'Atlanta Hawks')] }] },
      { id: '8', date: '2026-11-09T00:00Z', competitions: [{ status: { type: { state: 'post' } }, competitors: [competitor('home', 'A', 'A'), competitor('away', 'B', 'B')] }] },
    ],
  });
  assert.deepStrictEqual(events.map((e) => [e.id, e.teams.map((t) => t.short)]), [['9', ['Hawks', 'Lakers']]]);
});

test('Pro D2 lu dans le guide: le direct oui, la rediffusion non', () => {
  const channels = [channel('canalplussport', 'Canal+ Sport', 'CanalPlusSport.fr')];
  const programmes = new Map([['CanalPlusSport.fr', [
    { start: now + 1 * H, stop: now + 3 * H, title: 'Rugby : Pro D2 | Colomiers / Béziers', sub: '', desc: '' },
    { start: now + 5 * H, stop: now + 7 * H, title: 'Rugby : Pro D2', sub: '10e journée  : Agen / Biarritz Olympique', desc: '' },
  ]]]);
  const found = match([], channels, programmes, now);
  assert.deepStrictEqual(found.map((f) => f.name.replace(/ · [^·]+$/, '')), ['Agen - Biarritz Olympique · Canal+ Sport']);
});

test('Top 14 ESPN: Stade Toulousain retrouve sous "Toulouse"', () => {
  const channels = [channel('canalplus', 'Canal+', 'CanalPlus.fr')];
  const programmes = new Map([['CanalPlus.fr', [
    { start: now + 1 * H, stop: now + 3 * H, title: 'Rugby : Top 14', sub: '11e journée : Lyon / Toulouse', desc: '' },
  ]]]);
  const found = match([event('7', now + 1 * H, ['Lyon', 'Lyon'], ['Stade Toulousain', 'Stade Toulousain'])], channels, programmes, now);
  assert.strictEqual(found.length, 1);
});
