const test = require('node:test');
const assert = require('node:assert');
const { detectHoster, unpackPacker } = require('../src/streaming/hosterExtract');

test('unpackPacker substitue les mots sans executer le script', () => {
  const packed = `eval(function(p,a,c,k,e,d){}('0 1={2:"3://4.5/6.7"}',8,8,'var|p|file|https|cdn|org|master|m3u8'.split('|'),0,{}))`;
  assert.strictEqual(unpackPacker(packed), 'var p={file:"https://cdn.org/master.m3u8"}');
  assert.strictEqual(unpackPacker('<html></html>'), null);
});

test('les redirecteurs FStream passent avant le libelle du lecteur', () => {
  assert.strictEqual(detectHoster('https://trakx.lol/dood/newPlayer.php?id=x', 'Dood'), 'redirector');
  assert.strictEqual(detectHoster('https://kokoflix.lol/rosewood_go.php?id=x', 'Voe'), 'redirector');
  assert.strictEqual(detectHoster('https://luluvid.com/e/abc'), 'lulustream');
});
