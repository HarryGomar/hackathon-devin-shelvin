// Run: npm run sync-types  (copies app/src/api/types.ts into src/types.ts; the checker never imports the app)
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const APP_TYPES = fileURLToPath(new URL('../../../app/src/api/types.ts', import.meta.url));
export const LOCAL_TYPES = fileURLToPath(new URL('./types.ts', import.meta.url));

const HEADER = [
  '// COPY of app/src/api/types.ts (the contract). Do not edit here: change the app file, then run `npm run sync-types`.',
  '// types-sync.test.ts fails when this copy and the app file drift apart.',
  '// ---- copied below this line ----',
].join('\n');

/** The copied part of src/types.ts (everything after the marker line). */
export function copiedPart(localSource: string): string {
  const marker = '// ---- copied below this line ----\n';
  const at = localSource.indexOf(marker);
  return at < 0 ? '' : localSource.slice(at + marker.length);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(LOCAL_TYPES, `${HEADER}\n${readFileSync(APP_TYPES, 'utf8')}`);
  console.log(`Copied ${APP_TYPES} → ${LOCAL_TYPES}`);
}
