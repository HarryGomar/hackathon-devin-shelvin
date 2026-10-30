// Run: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ApiError,
  buildHeaders,
  HttpApi,
  identifyRequestBody,
  NETWORK_MESSAGE,
  parseErrorBody,
  queryString,
  TIMEOUT_MESSAGE,
} from './http';

interface Call {
  url: string;
  init: RequestInit;
}

/** A fetch stand-in that records calls and answers with `respond`. */
function fakeFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    const call = { url, init };
    calls.push(call);
    return respond(call);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('buildHeaders: bearer token only when set, JSON content type only with a body', () => {
  assert.deepEqual(buildHeaders('team-token', true), {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: 'Bearer team-token',
  });
  assert.deepEqual(buildHeaders(undefined, false), { Accept: 'application/json' });
  assert.equal(buildHeaders('', false).Authorization, undefined);
});

test('parseErrorBody: flat contract, old nested form, and junk', () => {
  const fallback = 'GET /x failed (500)';
  assert.deepEqual(parseErrorBody({ error: 'Product x not found', code: 'not_found' }, fallback), {
    message: 'Product x not found',
    code: 'not_found',
  });
  assert.deepEqual(parseErrorBody({ error: 'No code' }, fallback), { message: 'No code', code: undefined });
  assert.deepEqual(parseErrorBody({ error: { code: 'not_found', message: 'Gone' } }, fallback), {
    message: 'Gone',
    code: 'not_found',
  });
  assert.deepEqual(parseErrorBody({ error: { code: 'internal' } }, fallback), { message: fallback, code: 'internal' });
  assert.deepEqual(parseErrorBody({ error: '  ' }, fallback), { message: fallback, code: undefined });
  assert.deepEqual(parseErrorBody(undefined, fallback), { message: fallback });
  assert.deepEqual(parseErrorBody('oops', fallback), { message: fallback });
});

test('identifyRequestBody: a photo never sends its device-local uri', () => {
  const photo = identifyRequestBody({ kind: 'photo', uri: 'file:///private/photo.jpg', base64: 'AAAA', mimeType: 'image/jpeg' });
  assert.deepEqual(photo, { kind: 'photo', base64: 'AAAA', mimeType: 'image/jpeg' });
  assert.equal('uri' in photo, false);
  assert.deepEqual(identifyRequestBody({ kind: 'barcode', code: '7501011123588', format: 'ean13' }), {
    kind: 'barcode',
    code: '7501011123588',
    format: 'ean13',
  });
  assert.deepEqual(identifyRequestBody({ kind: 'barcode', code: '123' }), { kind: 'barcode', code: '123' });
  assert.deepEqual(identifyRequestBody({ kind: 'manual', code: '123' }), { kind: 'manual', code: '123' });
});

test('HttpApi.identify: POSTs /identify with the token and a uri-free body', async () => {
  const product = { id: 'doritos-nacho-61-g', brand: 'Doritos', productName: 'Doritos Nacho', confidence: 0.9, source: 'claude' };
  const { fn, calls } = fakeFetch(() => json(200, product));
  const api = new HttpApi('https://api.example.com/', { token: 'secret', fetch: fn });
  const result = await api.identify({ kind: 'photo', uri: 'file:///a.jpg', base64: 'BBBB', mimeType: 'image/png' });
  assert.deepEqual(result, product);
  assert.equal(calls[0].url, 'https://api.example.com/identify');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, 'Bearer secret');
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { kind: 'photo', base64: 'BBBB', mimeType: 'image/png' });
});

test('HttpApi: GET sends no body or content type, and no Authorization without a token', async () => {
  const { fn, calls } = fakeFetch(() => json(200, { scans: [] }));
  assert.deepEqual(await new HttpApi('http://localhost:8791', { fetch: fn }).listScans(), []);
  assert.equal(calls[0].url, 'http://localhost:8791/scans');
  assert.equal(calls[0].init.body, undefined);
  assert.deepEqual(calls[0].init.headers, { Accept: 'application/json' });
});

test('HttpApi: a server error throws ApiError with the server message, status and code', async () => {
  const { fn } = fakeFetch(() => json(422, { error: "That photo doesn't show a retail product.", code: 'not_a_product' }));
  const api = new HttpApi('http://x', { fetch: fn });
  await assert.rejects(api.identify({ kind: 'manual', code: '1' }), (e: unknown) => {
    assert.ok(e instanceof ApiError);
    assert.equal(e.message, "That photo doesn't show a retail product.");
    assert.equal(e.status, 422);
    assert.equal(e.code, 'not_a_product');
    return true;
  });
});

test('HttpApi: a non-JSON error body falls back to a generic message', async () => {
  const { fn } = fakeFetch(() => new Response('<html>Bad gateway</html>', { status: 502 }));
  await assert.rejects(new HttpApi('http://x', { fetch: fn }).getProduct('p'), {
    message: 'GET /products/p failed (502)',
    status: 502,
  });
});

test('HttpApi: a network failure gives a readable message', async () => {
  const { fn } = fakeFetch(() => {
    throw new TypeError('Network request failed');
  });
  await assert.rejects(new HttpApi('http://x', { fetch: fn }).listScans(), { message: NETWORK_MESSAGE, status: 0, code: 'network' });
});

/** A fetch that only settles when aborted, like a server that never answers. */
const hangingFetch = fakeFetch(
  ({ init }) =>
    new Promise<Response>((_, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }),
);

test('HttpApi: plain requests and /identify time out separately with a readable message', async () => {
  const api = new HttpApi('http://x', { fetch: hangingFetch.fn, requestTimeoutMs: 20, identifyTimeoutMs: 60 });
  const started = Date.now();
  await assert.rejects(api.listScans(), { message: TIMEOUT_MESSAGE, status: 0, code: 'timeout' });
  const plain = Date.now() - started;
  await assert.rejects(api.identify({ kind: 'manual', code: '1' }), { message: TIMEOUT_MESSAGE, code: 'timeout' });
  const identify = Date.now() - started - plain;
  assert.ok(plain < 55, `plain request should abort near 20 ms, took ${plain}`);
  assert.ok(identify >= 55, `identify should wait for its own longer timeout, took ${identify}`);
});

test('health, builds and build-batch hit their paths', async () => {
  const { fn, calls } = fakeFetch((call) =>
    call.url.endsWith('/scrapers/build-batch') ? json(202, { builds: [], skipped: [], parallel: 4 }) : json(200, { ok: true, builds: [] }),
  );
  const api = new HttpApi('http://127.0.0.1:8791/', { token: 'team-token', fetch: fn });
  await api.getHealth();
  await api.listBuilds();
  await api.getBuild('b 1');
  const res = await api.startBuildBatch({ productId: 'p', pageIds: ['a', 'b'] });
  assert.deepEqual(
    calls.map((c) => c.url),
    ['/health', '/builds', '/builds/b%201', '/scrapers/build-batch'].map((p) => `http://127.0.0.1:8791${p}`),
  );
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, 'Bearer team-token');
  assert.equal(calls[3].init.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[3].init.body)), { productId: 'p', pageIds: ['a', 'b'] });
  assert.equal(res.parallel, 4);
});

test('build history takes its filters as a query string, like /products', async () => {
  const { fn, calls } = fakeFetch(() => json(200, { builds: [] }));
  const api = new HttpApi('http://x', { fetch: fn });
  await api.listBuilds({ domain: 'super.walmart.com.mx', state: 'needs_person', limit: 20 });
  await api.listBuilds({ domain: '', limit: undefined });
  assert.deepEqual(calls.map((c) => c.url), ['http://x/builds?domain=super.walmart.com.mx&state=needs_person&limit=20', 'http://x/builds']);
});

test('queryString: only set fields, encoded', () => {
  assert.equal(queryString({}), '');
  assert.equal(queryString({ q: 'papas & más', barcode: '', limit: 5, offset: undefined }), '?q=papas%20%26%20m%C3%A1s&limit=5');
});
