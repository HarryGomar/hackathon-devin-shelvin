// Loaded by `npm test` (node --import). Resolves app imports the way Metro does, so pure modules
// can be tested as they are: `@/x` → src/x, and extensionless relative imports → .ts / index.ts.
// Only .ts files load (node strips types); anything importing react-native or a .tsx can't be tested.
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';

const src = new URL('../src/', import.meta.url);

registerHooks({
  resolve(specifier, context, nextResolve) {
    let spec = specifier.startsWith('@/') ? new URL(specifier.slice(2), src).href : specifier;
    if ((spec.startsWith('.') || spec.startsWith('file:')) && !/\.[cm]?[jt]s$/.test(spec)) {
      const base = new URL(spec, context.parentURL).href;
      const found = ['.ts', '/index.ts'].map((ext) => base + ext).find((url) => existsSync(new URL(url)));
      if (found) spec = found;
    }
    return nextResolve(spec, context);
  },
});
