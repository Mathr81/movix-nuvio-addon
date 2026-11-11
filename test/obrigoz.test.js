const test = require('node:test');
const assert = require('node:assert');
const { cleanTitle } = require('../src/addons/obrigoz');

test('cleanTitle coupe sur tout tiret separateur, court ou long', () => {
  assert.strictEqual(cleanTitle('Drive – The Pretenders'), 'Drive');
  assert.strictEqual(cleanTitle('Drive — The Pretenders'), 'Drive');
  assert.strictEqual(cleanTitle('Drive - The Pretenders'), 'Drive');
  assert.strictEqual(cleanTitle('Spider-Man: No Way Home'), 'Spider-Man');
  assert.strictEqual(cleanTitle('Drive-Away Dolls'), 'Drive-Away Dolls');
});

test("pickResult refuse un autre film plutot que de prendre le premier resultat", () => {
  const { pickResult } = require('../src/addons/obrigoz');
  const found = [
    { title: 'Cocorico 2', year: '2026' },
    { title: 'Drive - The Pretenders', year: '2026' },
    { title: 'Drive Angry', year: '2011' },
    { title: 'Drive', year: '2011' },
    { title: 'Dune : Deuxième Partie', year: '2024' },
  ];
  assert.strictEqual(pickResult(found, ['Coco', 'Coco'], '2017'), null);
  assert.strictEqual(pickResult(found, ['Drive – The Pretenders', 'Drive - The Pretenders'], '2026').title, 'Drive - The Pretenders');
  assert.strictEqual(pickResult(found, ['Drive', 'Drive'], '2011').title, 'Drive');
  assert.strictEqual(pickResult(found, ['Dune : Troisième partie', 'Dune: Part Three'], '2026'), null);
  assert.strictEqual(pickResult(found, ['Dune : Deuxième partie', 'Dune: Part Two'], '2025').title, 'Dune : Deuxième Partie');
});

test('cleanTitle retire les caracteres invisibles de TMDB', () => {
  assert.strictEqual(cleanTitle("‎Avatar Aang, le dernier maître de l'air"), "Avatar Aang, le dernier maître de l'air");
});
