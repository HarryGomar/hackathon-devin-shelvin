/**
 * Builds testset.json from Open Food Facts and a draft answer key (answers.draft.json) taken from the same
 * records. The draft is then checked by hand against each front photo and saved as answers.json.
 *
 *   npm run testset             fetch (cached) records + photos, write testset.json and answers.draft.json
 *   npm run testset -- --sheets also write labelled contact sheets of the photos to cache/sheets/ for checking
 *
 * Products were picked with the OFF search API (search.openfoodfacts.org, countries_tags:"en:mexico", code:750*,
 * by scan count) and filtered to records with a name, brand, quantity and front photo.
 *
 * This rebuilds only those first 25 products; re-add the rest afterwards with
 * `npm run add-products -- sources/added-products.json`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import sharp from 'sharp';

import { ANSWERS_DRAFT_FILE, SHEETS_DIR, TESTSET_FILE } from './paths.ts';
import { fetchImage, fullSizeImageUrl, lookupOff } from './off.ts';
import type { Answer, TestItem } from './types.ts';

const PICKS: { code: string; tier: TestItem['tier']; aisle: string }[] = [
  // Big national brands
  { code: '7501011123588', tier: 'big', aisle: 'Botanas' }, // Doritos Nacho
  { code: '7500478018512', tier: 'big', aisle: 'Botanas' }, // Doritos Dinamita
  { code: '7501011127012', tier: 'big', aisle: 'Botanas' }, // Tostitos Salsa Verde
  { code: '7501011110335', tier: 'big', aisle: 'Botanas' }, // Fritos Limón y Sal
  { code: '7500810003671', tier: 'big', aisle: 'Botanas' }, // Takis Fuego
  { code: '7501030459958', tier: 'big', aisle: 'Botanas' }, // Barcel Hot Nuts
  { code: '7501000111206', tier: 'big', aisle: 'Panadería' }, // Bimbo Pan Blanco
  { code: '7501030478591', tier: 'big', aisle: 'Pan dulce' }, // Marinela Gansito
  { code: '7501000658923', tier: 'big', aisle: 'Galletas' }, // Gamesa Marías
  { code: '75007614', tier: 'big', aisle: 'Refrescos' }, // Coca-Cola 600 ml (EAN-8)
  { code: '7501055305339', tier: 'big', aisle: 'Refrescos' }, // Coca-Cola Light
  { code: '7501020565935', tier: 'big', aisle: 'Lácteos' }, // Lala leche entera
  { code: '7501020515299', tier: 'big', aisle: 'Lácteos' }, // Lala media crema
  { code: '7501059214385', tier: 'big', aisle: 'Desayuno' }, // Nesquik
  { code: '7501058611062', tier: 'big', aisle: 'Lácteos' }, // Carnation Clavel evaporada
  { code: '7501013110425', tier: 'big', aisle: 'Jugos' }, // Jumex néctar de manzana
  { code: '7501055351237', tier: 'big', aisle: 'Jugos' }, // Del Valle Naranja & Nada
  // Smaller / regional brands
  { code: '7501014302126', tier: 'small', aisle: 'Desayuno' }, // Ibarra chocolate en polvo
  { code: '7501017004423', tier: 'small', aisle: 'Abarrotes' }, // La Costeña frijoles negros refritos
  { code: '7501003105486', tier: 'small', aisle: 'Abarrotes' }, // Herdez atún aleta amarilla
  { code: '7501018319038', tier: 'small', aisle: 'Abarrotes' }, // La Moderna tornillo
  { code: '7501077400050', tier: 'small', aisle: 'Abarrotes' }, // Maseca harina
  { code: '7501073830509', tier: 'small', aisle: 'Aguas' }, // Peñafiel agua mineral
  { code: '7501052420165', tier: 'small', aisle: 'Abarrotes' }, // La Sierra frijoles negros refritos
  { code: '7501209705640', tier: 'small', aisle: 'Lácteos' }, // Sello Rojo leche entera
];

async function main(): Promise<void> {
  const sheets = process.argv.includes('--sheets');
  const items: TestItem[] = [];
  const drafts: Answer[] = [];

  for (const pick of PICKS) {
    const { product, latencyMs } = await lookupOff(pick.code);
    const imageUrl = product?.image_front_url ?? product?.image_url;
    if (!product || !imageUrl || !product.brands || !product.quantity) {
      console.warn(`skip ${pick.code}: OFF record lacks name, brand, quantity or photo`);
      continue;
    }
    const imageFullUrl = fullSizeImageUrl(imageUrl);
    await fetchImage(`${pick.code}.D`, imageFullUrl);
    items.push({ barcode: pick.code, tier: pick.tier, aisle: pick.aisle, off: product, offStatus: 'full', offLatencyMs: latencyMs, imageUrl, imageFullUrl });

    const name = product.product_name_es || product.product_name || '';
    const brand = product.brands.split(',')[0]!.trim();
    drafts.push({
      barcode: pick.code,
      brand,
      productName: name.toLowerCase().startsWith(brand.toLowerCase()) ? name : `${brand} ${name}`,
      variant: '',
      size: product.quantity,
      photo: 'good',
      checkNote: 'draft from OFF; not checked',
    });
    console.log(`${pick.code}  ${brand} | ${name} | ${product.quantity}`);
  }

  writeFileSync(TESTSET_FILE, JSON.stringify(items, null, 2) + '\n');
  writeFileSync(ANSWERS_DRAFT_FILE, JSON.stringify(drafts, null, 2) + '\n');
  console.log(`\n${items.length} products → testset.json; draft key → answers.draft.json (check by hand → answers.json)`);

  if (sheets) await writeContactSheets(items);
}

/** 3×2 grids of 400 px tiles, labelled with the barcode, so the key can be checked a few photos at a time. */
async function writeContactSheets(items: TestItem[]): Promise<void> {
  mkdirSync(SHEETS_DIR, { recursive: true });
  const tile = 400;
  const perSheet = 6;
  for (let s = 0; s * perSheet < items.length; s++) {
    const group = items.slice(s * perSheet, (s + 1) * perSheet);
    const composites = await Promise.all(
      group.map(async (item, i) => {
        const img = await sharp(await fetchImage(`${item.barcode}.D`, item.imageFullUrl!))
          .rotate()
          .resize({ width: tile, height: tile - 30, fit: 'contain', background: '#ffffff' })
          .toBuffer();
        const label = Buffer.from(
          `<svg width="${tile}" height="30"><rect width="100%" height="100%" fill="#000"/><text x="8" y="21" font-size="18" font-family="Helvetica" fill="#fff">${item.barcode}</text></svg>`,
        );
        const left = (i % 3) * tile;
        const top = Math.floor(i / 3) * tile;
        return [
          { input: label, left, top },
          { input: img, left, top: top + 30 },
        ];
      }),
    );
    const file = join(SHEETS_DIR, `sheet-${s + 1}.jpg`);
    await sharp({ create: { width: tile * 3, height: tile * 2, channels: 3, background: '#ffffff' } })
      .composite(composites.flat())
      .jpeg({ quality: 80 })
      .toFile(file);
    console.log(`sheet → ${file}`);
  }
}

await main();
