const test = require('node:test');
const assert = require('node:assert');
const { parseSchema, applyChanges, parseValues } = require('../src/webui/envSchema');

const EXAMPLE = `# Port
PORT=8787

# --- TV en direct ------------
# Les chaines dans Nuvio.

# Active les chaines.
LIVETV_ENABLED=false
# LIVETV_CATALOGS=vavoo_france
VIP_ACCESS_KEY=
`;

test('schema: categories, descriptions, types', () => {
  const [general, tv] = parseSchema(EXAMPLE);
  assert.strictEqual(general.vars[0].kind, 'number');
  assert.strictEqual(tv.title, 'TV en direct');
  assert.strictEqual(tv.intro, 'Les chaines dans Nuvio.');
  assert.deepStrictEqual(tv.vars.map((v) => [v.key, v.kind, v.optional, v.doc]), [
    ['LIVETV_ENABLED', 'bool', false, 'Active les chaines.'],
    ['LIVETV_CATALOGS', 'text', true, ''],
    ['VIP_ACCESS_KEY', 'secret', false, ''],
  ]);
});

test('applyChanges: remplace, decommente, commente, ajoute, cite', () => {
  const env = 'PORT=8787\n# LIVETV_CATALOGS=x\nVIP_ACCESS_KEY=abc\n';
  const out = applyChanges(env, { PORT: '9000', LIVETV_CATALOGS: 'a,b', VIP_ACCESS_KEY: null, NEW_ONE: 'x #y' });
  assert.strictEqual(out, "PORT=9000\nLIVETV_CATALOGS=a,b\n# VIP_ACCESS_KEY=abc\nNEW_ONE='x #y'\n");
  assert.deepStrictEqual(parseValues(out), { PORT: '9000', LIVETV_CATALOGS: 'a,b', NEW_ONE: 'x #y' });
  assert.throws(() => applyChanges(env, { PORT: '1\nEVIL=1' }));
});
