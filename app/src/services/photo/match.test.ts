// Run: npm test  (node --test with native TypeScript stripping; no network)
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { bestImage, parseOffSearch, pickImage, scoreHit, searchBrandTags, sizeAmount, tokens, type OffSearchHit, type PhotoTarget } from './match.ts';

const img = (code: string) => `https://images.openfoodfacts.org/images/products/${code}/front_es.1.400.jpg`;

// Real hits from `api/v2/search?brands_tags=doritos&countries_tags_en=mexico` (trimmed).
const DORITOS: OffSearchHit[] = [
  { code: '7501011131064', brands: 'Doritos', product_name: 'Doritos Nachos', quantity: '146 g', image_front_url: img('a') },
  { code: '7501011123588', brands: 'Doritos', product_name: 'doritos nacho', quantity: '61 gr', image_front_url: img('b') },
  { code: '7501011130272', brands: 'Doritos', product_name: 'Xtra Flamin’ Hot', quantity: '61 g', image_front_url: img('c') },
  { code: '7500478012138', brands: 'Doritos, Sabritas', product_name: 'Doritos ADN Incognita unidades', quantity: '245 g', image_front_url: img('d') },
  { code: '7500478008025', brands: 'Doritos', product_name: 'Botana Sabritas Doritos Nacho con queso sabor chile', quantity: '' },
];

const doritos = (productName: string, variant?: string, size?: string): PhotoTarget => ({
  brand: 'Doritos',
  productName,
  variant,
  size,
  manufacturer: 'Sabritas (PepsiCo México)',
});

test('search body → hits; rate-limit page or error → none', () => {
  assert.equal(parseOffSearch({ count: 2, products: [{ code: '1' }, null, 'x', { code: '2' }] }).length, 2);
  assert.deepEqual(parseOffSearch('<!DOCTYPE html>…'), []);
  assert.deepEqual(parseOffSearch({ error: 'rate limited' }), []);
  assert.deepEqual(parseOffSearch(null), []);
  const sal = parseOffSearch({ hits: [{ code: '3', brands: ['Doritos', 'Sabritas'], product_name: 'Doritos nacho' }] });
  assert.equal(sal[0].brands, 'Doritos, Sabritas', 'search.openfoodfacts.org lists brands as an array');
});

test('picks the same flavor, preferring the same size', () => {
  assert.equal(bestImage(doritos('Doritos Nacho', 'Nacho', '61 g'), DORITOS), img('b'), 'nacho 61 gr beats Nachos 146 g');
  assert.equal(bestImage(doritos('Doritos Nacho', 'Nacho'), DORITOS), img('a'), 'without a size, OFF order (most scanned) wins the tie');
  assert.equal(bestImage(doritos('Doritos Incógnita', 'Incógnita', '62 g'), DORITOS), img('d'), 'accents ignored; "ADN … unidades" is noise');
  const flaminHot: OffSearchHit = { brands: 'Doritos', product_name: 'Doritos Flamin’ Hot', quantity: '62 g', image_front_url: img('h') };
  assert.equal(bestImage(doritos("Doritos Flamin' Hot", "Flamin' Hot", '62 g'), [...DORITOS, flaminHot]), img('h'), 'apostrophes ignored');
});

test('fewer extra words beat the same size (98 check 7, P-1)', () => {
  const hits: OffSearchHit[] = [
    { brands: 'Doritos', product_name: 'Doritos Nacho', image_front_url: img('plain') },
    { brands: 'Doritos', product_name: 'Doritos Nacho Queso Chile', quantity: '62 g', image_front_url: img('queso') },
  ];
  assert.equal(bestImage(doritos('Doritos Nacho', 'Nacho', '62 g'), hits), img('plain'));
  const noisy: OffSearchHit[] = [
    { brands: 'Doritos', product_name: 'Doritos Nacho ADN', image_front_url: img('noisy') },
    { brands: 'Doritos', product_name: 'Doritos Nacho', quantity: '62 g', image_front_url: img('sized') },
    { brands: 'Doritos', product_name: 'Doritos Nacho', image_front_url: img('unsized') },
  ];
  assert.equal(bestImage(doritos('Doritos Nacho', 'Nacho', '62 g'), noisy), img('sized'), 'size breaks the tie between equal names');
});

test('only the brand known → no photo (P-2)', () => {
  assert.equal(bestImage({ brand: 'Doritos', productName: 'Doritos', manufacturer: 'Sabritas (PepsiCo México)' }, DORITOS), undefined);
  assert.equal(bestImage({ brand: '', productName: 'Nacho' }, DORITOS), undefined, 'no brand at all');
});

test('a superset with another flavor, or too much noise, is not the product (A-P1)', () => {
  const quesoChile: OffSearchHit = { brands: 'Doritos', product_name: 'Doritos Nacho Queso Chile', quantity: '62 g', image_front_url: img('q') };
  assert.equal(scoreHit(doritos('Doritos Nacho', 'Nacho', '62 g'), quesoChile), undefined, 'queso/chile are flavors the target lacks');
  assert.equal(bestImage(doritos("Doritos Flamin' Hot", "Flamin' Hot", '62 g'), DORITOS), undefined, '"Xtra Flamin’ Hot" is another version');
  const noisy: OffSearchHit = { brands: 'Doritos', product_name: 'Doritos Nacho edicion especial mundial', image_front_url: img('n') };
  assert.equal(scoreHit(doritos('Doritos Nacho', 'Nacho'), noisy), undefined, 'more than 2 extra words');
});

test('never a wrong flavor or brand: no match beats a wrong photo', () => {
  assert.equal(bestImage(doritos('Doritos Pizzerola', 'Pizzerola'), DORITOS), undefined);
  const cheetos: OffSearchHit = { brands: 'Sabritas', product_name: 'cheetos nacho', quantity: '52 g', image_front_url: img('e') };
  assert.equal(scoreHit(doritos('Doritos Nacho', 'Nacho'), cheetos), undefined, 'same maker (Sabritas), other brand');
  assert.equal(scoreHit(doritos('Doritos Nacho', 'Nacho'), { ...DORITOS[1], image_front_url: undefined }), undefined, 'no image');
  assert.equal(scoreHit(doritos('Doritos Nacho', 'Nacho'), { ...DORITOS[1], image_front_url: 'http://x/y.jpg' }), undefined, 'https only');
});

test('brand found in the name when OFF files it under the maker', () => {
  const takis: PhotoTarget = { brand: 'Takis', productName: 'Takis Fuego', variant: 'Fuego', size: '70 g', manufacturer: 'Barcel (Grupo Bimbo)' };
  const hits: OffSearchHit[] = [
    { brands: 'Barcel', product_name: 'Takis Original', image_front_url: img('o') },
    { brands: 'Barcel', product_name: 'Takis Fuego Verde', quantity: '190 g', image_front_url: img('v') },
    { brands: 'Barcel', product_name: 'Takis Fuego', quantity: '56 g', image_front_url: img('f') },
  ];
  assert.equal(bestImage(takis, hits), img('f'), '"Fuego Verde" is another flavor');
  assert.equal(bestImage(takis, hits.slice(0, 2)), undefined, 'only Original and Fuego Verde → no photo');
  assert.deepEqual(searchBrandTags(takis), ['takis', 'barcel']);
});

test('brand tags to search: brand first, then the maker', () => {
  assert.deepEqual(searchBrandTags(doritos('Doritos Nacho')), ['doritos', 'sabritas']);
  assert.deepEqual(searchBrandTags({ brand: 'Coca-Cola', productName: 'Coca-Cola' }), ['coca-cola']);
  assert.deepEqual(searchBrandTags({ brand: 'Nestlé', productName: 'Nescafé', manufacturer: 'Nestlé México S.A. de C.V.' }), ['nestle']);
});

test('tokens and sizes', () => {
  assert.deepEqual(tokens('Botana Doritos® Flamin’ Hot 62 g'), ['doritos', 'flamin', 'hot']);
  assert.equal(sizeAmount('61 gr'), 61);
  assert.equal(sizeAmount('1,5 L'), 1500);
  assert.equal(sizeAmount('0.5 kg'), 500);
  assert.equal(sizeAmount('600ml'), 600);
  assert.equal(sizeAmount('6 pzas'), undefined);
});

test('image priority: OFF exact → OFF search → user photo → none', () => {
  const all = { offExact: 'https://off/exact.jpg', offSearch: 'https://off/search.jpg', userPhoto: 'file:///photo.jpg' };
  assert.deepEqual(pickImage(all), { imageUrl: all.offExact, imageSource: 'openfoodfacts' });
  assert.deepEqual(pickImage({ ...all, offExact: undefined }), { imageUrl: all.offSearch, imageSource: 'openfoodfacts' });
  assert.deepEqual(pickImage({ userPhoto: all.userPhoto }), { imageUrl: all.userPhoto, imageSource: 'user_photo' });
  assert.deepEqual(pickImage({}), {});
});
