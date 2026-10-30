const test = require('node:test');
const assert = require('node:assert');
const { audioLanguagesOf } = require('../src/streaming/probe');
const { langFromAudio } = require('../src/streaming/streamBuilder');

test('langues audio lues dans le master', () => {
  const master = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",LANGUAGE="fr",NAME="Français",URI="fr.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",URI="en.m3u8"',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",LANGUAGE="de",URI="de.m3u8"',
  ].join('\n');
  assert.deepStrictEqual(audioLanguagesOf(master), ['fr', 'English']);
  assert.deepStrictEqual(audioLanguagesOf(master, 'SUBTITLES'), ['de']);
});

test('pistes audio -> VF / VO / MULTI', () => {
  assert.strictEqual(langFromAudio(['fre']), 'VF');
  assert.strictEqual(langFromAudio(['Français', 'und']), 'VF');
  assert.strictEqual(langFromAudio(['fr', 'eng']), 'MULTI');
  assert.strictEqual(langFromAudio(['eng']), 'VO');
  assert.strictEqual(langFromAudio(['und']), undefined);
  assert.strictEqual(langFromAudio(undefined), undefined);
});
