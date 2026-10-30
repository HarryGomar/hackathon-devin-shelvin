// Run: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseAppearancePreference, resolveColorScheme } from './appearance-preference';

test('appearance: stored light/dark are kept, anything else means Automatic', () => {
  assert.equal(parseAppearancePreference('light'), 'light');
  assert.equal(parseAppearancePreference('dark'), 'dark');
  assert.equal(parseAppearancePreference('system'), 'system');
  assert.equal(parseAppearancePreference(null), 'system');
  assert.equal(parseAppearancePreference('Dark'), 'system');
  assert.equal(parseAppearancePreference(42), 'system');
});

test('appearance: Automatic follows the phone, a pick overrides it', () => {
  assert.equal(resolveColorScheme('system', 'dark'), 'dark');
  assert.equal(resolveColorScheme('system', 'light'), 'light');
  assert.equal(resolveColorScheme('system', null), 'light');
  assert.equal(resolveColorScheme('light', 'dark'), 'light');
  assert.equal(resolveColorScheme('dark', 'light'), 'dark');
});
