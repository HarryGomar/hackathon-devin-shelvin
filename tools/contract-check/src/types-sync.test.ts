import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { APP_TYPES, copiedPart, LOCAL_TYPES } from './sync-types.ts';

test('src/types.ts is an exact copy of app/src/api/types.ts (run `npm run sync-types` if not)', () => {
  assert.equal(copiedPart(readFileSync(LOCAL_TYPES, 'utf8')), readFileSync(APP_TYPES, 'utf8'));
});
