import assert from 'node:assert/strict';
import { test } from 'node:test';

import { brandMatches, nameOverlap, parseSizes, scoreIdentity, sizeMatches, tokens, variantMatches } from './score.ts';
import type { Answer, ProductIdentity } from './types.ts';

const doritos: Answer = {
  barcode: '7501011123588',
  brand: 'Doritos',
  brandAliases: ['Sabritas'],
  productName: 'Doritos Nacho',
  variant: 'Nacho',
  size: '62 g',
  photo: 'good',
  checkNote: '',
};

const coke: Answer = {
  barcode: '75007614',
  brand: 'Coca-Cola',
  productName: 'Coca-Cola',
  nameAliases: ['Coca-Cola Sabor Original'],
  variant: 'Sabor Original',
  variantOptional: true,
  size: '600 ml',
  photo: 'good',
  checkNote: '',
};

const id = (o: Partial<ProductIdentity>): ProductIdentity => ({
  id: 'x',
  brand: '',
  productName: '',
  confidence: 0.9,
  source: 'claude',
  ...o,
});

test('size units normalize', () => {
  for (const s of ['62 g', '62g', '62 gr', '62 GRS', 'Cont. Net. 62 g', '62 gramos']) assert.ok(sizeMatches(s, doritos), s);
  assert.ok(!sizeMatches('61 gr', doritos));
  assert.ok(!sizeMatches('', doritos));
  assert.deepEqual(parseSizes('1.8L'), [{ value: 1800, unit: 'ml' }]);
  assert.deepEqual(parseSizes('2,5 l'), [{ value: 2500, unit: 'ml' }]);
  assert.deepEqual(parseSizes('1 kg'), [{ value: 1000, unit: 'g' }]);
  assert.deepEqual(parseSizes('360 g (339.9 ml)'), [
    { value: 360, unit: 'g' },
    { value: 339.9, unit: 'ml' },
  ]);
  assert.ok(parseSizes('3 x 50 g').some((a) => a.value === 150));
  assert.ok(sizeMatches('600ml', coke));
  assert.ok(sizeMatches('0.6 L', coke));
});

test('names compare by normalized token overlap', () => {
  assert.deepEqual(tokens('Doritos Nachos 62 g'), ['dorito', 'nacho']);
  assert.equal(nameOverlap('doritos nacho', doritos), 1);
  assert.equal(nameOverlap('DORITOS® Nachos', doritos), 1);
  assert.ok(nameOverlap('Doritos Incógnita', doritos) < 0.8);
  assert.equal(tokens('Peñafiel Agua Mineral').join(' '), 'penafiel agua mineral');
});

test('brand matches exactly after normalizing, or an alias', () => {
  assert.ok(brandMatches('DORITOS', doritos));
  assert.ok(brandMatches('Sabritas', doritos));
  assert.ok(brandMatches('Coca Cola', coke));
  assert.ok(!brandMatches('Barcel', doritos));
  assert.ok(!brandMatches('', doritos));
});

test('variant: words present, or a default variant left unsaid', () => {
  assert.equal(variantMatches({ brand: 'Doritos', productName: 'Doritos Nacho' }, doritos), true);
  assert.equal(variantMatches({ brand: 'Doritos', productName: 'Doritos', variant: 'Dinamita' }, doritos), false);
  assert.equal(variantMatches({ brand: 'Coca-Cola', productName: 'Coca cola' }, coke), true);
  assert.equal(variantMatches({ brand: 'Coca-Cola', productName: 'Coca-Cola Light', variant: 'Light' }, coke), false);
  assert.equal(variantMatches({ brand: 'X', productName: 'X' }, { ...doritos, variant: '' }), null);
});

test('confident wrong flags wrong answers at confidence ≥ 0.8 only', () => {
  const right = scoreIdentity(id({ brand: 'Doritos', productName: 'Doritos Nacho', variant: 'Nacho', size: '62 g' }), doritos);
  assert.equal(right.all, true);
  assert.equal(right.confidentWrong, false);
  const wrong = scoreIdentity(id({ brand: 'Doritos', productName: 'Doritos Nacho', variant: 'Nacho', size: '61 gr' }), doritos);
  assert.equal(wrong.all, false);
  assert.equal(wrong.confidentWrong, true);
  const unsure = scoreIdentity(id({ brand: 'Doritos', productName: 'Doritos Nacho', size: '61 g', confidence: 0.4 }), doritos);
  assert.equal(unsure.confidentWrong, false);
});

test('variant aliases: a translated variant counts', () => {
  const ikea: Answer = { barcode: '1105247480000', brand: 'IKEA', productName: 'IKEA CHOKLAD MÖRK', variant: 'Dark chocolate', variantAliases: ['Chocolate oscuro'], size: '100 g', photo: 'good', checkNote: '' };
  assert.equal(variantMatches({ brand: 'IKEA', productName: 'IKEA Choklad', variant: 'Chocolate oscuro' }, ikea), true);
  assert.equal(variantMatches({ brand: 'IKEA', productName: 'IKEA Choklad', variant: 'Chocolate con leche' }, ikea), false);
});
