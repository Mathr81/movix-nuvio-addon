const test = require('node:test');
const assert = require('node:assert');
const ctx = require('../src/core/requestContext');
const { isPersonal, find } = require('../src/catalog/catalogs');

const guests = new Map([['a'.repeat(32), 'marie']]);
const prefix = `/p/${'a'.repeat(32)}`;

test('le prefixe proche ne laisse passer que les routes d addon', () => {
  assert.deepStrictEqual(ctx.guestRoute(`${prefix}/manifest.json`, guests), { guest: 'marie', url: '/manifest.json' });
  assert.deepStrictEqual(ctx.guestRoute(`${prefix}/vf/stream/movie/tt1.json`, guests), { guest: 'marie', url: '/vf/stream/movie/tt1.json' });
  assert.strictEqual(ctx.guestRoute(`${prefix}/catalog/movie/movix-trending/skip=20.json`, guests).url, '/catalog/movie/movix-trending/skip=20.json');
  for (const url of [`${prefix}/ui`, `${prefix}/debug/sync`, `${prefix}/hub/sync`, `${prefix}/manifest.json/../ui`, '/p/inconnu/manifest.json', `${prefix}/`]) {
    assert.strictEqual(ctx.guestRoute(url, guests), null, url);
  }
});

test('le contexte suit les await et reste vide hors du middleware', async () => {
  assert.strictEqual(ctx.guest(), null);
  await ctx.run({ guest: 'marie' }, async () => {
    await new Promise((r) => setTimeout(r, 5));
    assert.strictEqual(ctx.guest(), 'marie');
  });
});

test('les rangees du compte sont personnelles, pas les autres', () => {
  for (const id of ['movix-watchlist', 'movix-favorites', 'movix-reco', 'movix-trakt-reco']) assert.ok(isPersonal(find(id)), id);
  assert.ok(!isPersonal(find('movix-trending')));
  assert.ok(!isPersonal(find('movix-search')));
});
