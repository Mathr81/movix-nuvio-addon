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

test('Byse: la cle est faite des key_parts `version` et `31 - version`', () => {
  const crypto = require('crypto');
  const { decryptPlayback } = require('../src/streaming/hosterByse');
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update('{"sources":[{"url":"https://cdn/x.m3u8"}]}'), cipher.final(), cipher.getAuthTag()]);
  const parts = Array.from({ length: 30 }, () => crypto.randomBytes(16).toString('base64url'));
  parts[2] = key.subarray(0, 16).toString('base64url');
  parts[27] = key.subarray(16).toString('base64url');
  const playback = { version: '3', key_parts: parts, iv: iv.toString('base64url'), payload: body.toString('base64url') };
  assert.strictEqual(decryptPlayback(playback).sources[0].url, 'https://cdn/x.m3u8');
});

test('Filemoon et ses miroirs vont a Byse', () => {
  assert.strictEqual(detectHoster('https://filemoon.sx/e/abc'), 'byse');
  assert.strictEqual(detectHoster('https://bysebuho.com/e/abc'), 'byse');
  assert.strictEqual(detectHoster('https://mxdrop.to/e/abc'), 'mixdrop');
});
