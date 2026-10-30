// Run: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { knownRetailerDomain, monogram, monogramColors, retailerIconUrl } from './retailer-logo-source';

test('known retailers match exactly and on subdomains', () => {
  assert.equal(knownRetailerDomain('soriana.com'), 'soriana.com');
  assert.equal(knownRetailerDomain('super.walmart.com.mx'), 'walmart.com.mx');
  assert.equal(knownRetailerDomain('despensa.bodegaaurrera.com.mx'), 'bodegaaurrera.com.mx');
  assert.equal(knownRetailerDomain('WWW.Chedraui.com.mx.'), 'chedraui.com.mx');
  assert.equal(knownRetailerDomain('www.amazon.com.mx:443'), 'amazon.com.mx');
});

test('look-alikes and other sites do not match', () => {
  for (const host of [
    'walmart.com.mx.evil.com',
    'notwalmart.com.mx',
    'walmart-com.mx',
    'walmart.com',
    'amazon.com',
    'soriana.com.evil.mx',
    'takis.com.mx',
    'doritos.com.mx',
    'example.com.mx',
    '',
  ])
    assert.equal(knownRetailerDomain(host), undefined, host);
});

test('icon URL only for known retailers, for the registrable domain', () => {
  assert.equal(retailerIconUrl('super.walmart.com.mx'), 'https://www.google.com/s2/favicons?domain=walmart.com.mx&sz=128');
  assert.equal(retailerIconUrl('takis.com.mx'), undefined);
  assert.equal(retailerIconUrl('walmart.com.mx.evil.com'), undefined);
});

test('monogram uses the name, not the domain', () => {
  assert.equal(monogram('Takis'), 'T');
  assert.equal(monogram('Takis (official site)'), 'T');
  assert.equal(monogram('Walmart Súper'), 'WS');
  assert.equal(monogram('Bodega Aurrera Despensa'), 'BA');
  assert.equal(monogram('7-Eleven'), '7');
  assert.equal(monogram('(official site)'), '');
});

test('monogram tint is stable per domain and differs between domains', () => {
  assert.deepEqual(monogramColors('takis.com.mx', false), monogramColors('TAKIS.com.mx', false));
  assert.notDeepEqual(monogramColors('takis.com.mx', true), monogramColors('doritos.com.mx', true));
});
