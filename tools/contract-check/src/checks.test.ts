// End to end: the checker against the local stub, clean and with faults injected. No network beyond 127.0.0.1.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { canonicalProductId, runChecks, type CheckResult } from './checks.ts';
import { startStub, type Fault } from './stub.ts';

async function run(faults: Fault[] = [], token: string | null = 'secret'): Promise<CheckResult[]> {
  const t = token ?? undefined;
  const stub = await startStub({ token: t, stepMs: 25, faults });
  try {
    return await runChecks({ baseUrl: stub.baseUrl, token: t, pollMs: 10, jobTimeoutMs: 5_000 });
  } finally {
    await stub.close();
  }
}

const failed = (results: CheckResult[]) => results.filter((r) => r.status === 'fail').map((r) => r.name);

test('a server that follows the spec passes every check with no warnings', async () => {
  const results = await run();
  assert.deepEqual(failed(results), []);
  assert.deepEqual(results.filter((r) => r.status === 'warn').map((r) => r.name), []);
  assert.deepEqual(results.filter((r) => r.status === 'skip').map((r) => r.name), []);
});

test('without a token the auth check is skipped, not failed', async () => {
  const results = await run([], null);
  assert.deepEqual(failed(results), []);
  assert.equal(results.find((r) => r.name.startsWith('auth'))?.status, 'skip');
});

test('nested { error: { code, message } } bodies fail every error check', async () => {
  const names = failed(await run(['nested-error']));
  assert.ok(names.length >= 5, names.join(', '));
  assert.ok(names.every((n) => n.startsWith('errors:') || n.startsWith('auth')), names.join(', '));
});

test('a server that ignores the token fails the auth check', async () => {
  assert.deepEqual(failed(await run(['no-auth'])), ['auth: no token / wrong token → 401']);
});

test('the old step ids (searching_web …) fail every job check', async () => {
  const names = failed(await run(['old-step-keys']));
  assert.ok(names.includes('POST /search (job)'), names.join(', '));
  assert.ok(names.includes('POST /scrape (job)'), names.join(', '));
});

test('re-scraping a page must replace its listing, not add a second one', async () => {
  assert.deepEqual(failed(await run(['duplicate-listings'])), ['GET /products/:id/listings']);
});

test('a refused page comes back as a failure with its access code; a 403 is a blocked failure', async () => {
  const results = await run();
  assert.equal(results.find((r) => r.name === 'POST /scrape a refused page (never scraped)')?.note, 'amazon.com.mx: ai_opt_out');
  assert.match(results.find((r) => r.name === 'POST /scrape (job)')?.note ?? '', /2 listings, 1 failures/);
});

test('a server that scrapes a refused page fails that check', async () => {
  assert.deepEqual(failed(await run(['scrape-refused'])), ['POST /scrape a refused page (never scraped)']);
});

test('canonicalProductId: gtin- + GTIN-14 for a valid barcode, else the id sent (the app rule in gtin.ts)', () => {
  const p = { id: 'doritos-nacho-61-g', brand: 'Doritos', productName: 'Doritos Nacho', confidence: 0.9, source: 'claude' as const };
  assert.equal(canonicalProductId({ ...p, barcode: '7501011123588' }), 'gtin-07501011123588');
  assert.equal(canonicalProductId({ ...p, barcode: '007315122013887' }), 'gtin-07315122013887');
  assert.equal(canonicalProductId({ ...p, barcode: '75007614' }), 'gtin-00000075007614');
  assert.equal(canonicalProductId({ ...p, barcode: '7501011123589' }), 'doritos-nacho-61-g', 'a wrong check digit keeps the id');
  assert.equal(canonicalProductId(p), 'doritos-nacho-61-g');
});
