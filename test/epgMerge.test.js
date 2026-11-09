const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { merge } = require('../src/iptv/epg');

test('fusion de guides: le premier guide garde ses chaines, le second complete', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epg-'));
  const a = path.join(dir, 'a.xml.gz');
  const b = path.join(dir, 'b.xml');
  fs.writeFileSync(a, zlib.gzipSync(
    '<tv><channel id="TF1.fr"><display-name>TF1</display-name></channel>' +
    '<programme start="20261109200000 +0100" stop="20261109210000 +0100" channel="TF1.fr"><title>JT A</title></programme></tv>',
  ));
  // Non compresse, attributs dans un autre ordre, et un doublon de TF1.fr a ecarter.
  fs.writeFileSync(b,
    '<tv><channel id="TF1.fr"><display-name>TF1</display-name></channel>' +
    '<channel id="NRJ12.fr" lang="fr"><display-name>NRJ 12</display-name></channel>' +
    '<programme channel="TF1.fr" start="20261109200000" stop="20261109210000"><title>JT B</title></programme>' +
    '<programme channel="NRJ12.fr" start="20261109200000" stop="20261109210000"><title>Film</title></programme></tv>',
  );
  const out = path.join(dir, 'out.xml.gz');
  const { channels } = await merge([a, b], out);
  const xml = zlib.gunzipSync(fs.readFileSync(out)).toString();

  assert.strictEqual(channels, 2);
  assert.strictEqual((xml.match(/<channel /g) || []).length, 2);
  assert.ok(xml.includes('JT A') && xml.includes('Film'));
  assert.ok(!xml.includes('JT B'), 'programme en double du second guide');
  assert.ok(xml.indexOf('<programme') > xml.lastIndexOf('<channel'), 'chaines avant programmes');
  fs.rmSync(dir, { recursive: true, force: true });
});
