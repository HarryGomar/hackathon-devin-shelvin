/**
 * Compare two runs product by product: npm run diff -- <tagA> <tagB> [arm]
 * Prints products whose result changed (right ↔ wrong) and the two predictions.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ANSWERS_FILE, RUNS_DIR } from './paths.ts';
import { scoreIdentity } from './score.ts';
import type { Answer, ArmResult } from './types.ts';

const [tagA, tagB, arm] = process.argv.slice(2);
if (!tagA || !tagB) throw new Error('usage: npm run diff -- <tagA> <tagB> [arm]');
const answers = new Map((JSON.parse(readFileSync(ANSWERS_FILE, 'utf8')) as Answer[]).map((a) => [a.barcode, a]));
const load = (tag: string) => (JSON.parse(readFileSync(join(RUNS_DIR, `${tag}.json`), 'utf8')) as { results: ArmResult[] }).results;
const key = (r: ArmResult) => `${r.arm}:${r.barcode}`;
const b = new Map(load(tagB).map((r) => [key(r), r]));
const show = (r: ArmResult | undefined) => {
  if (!r?.identity) return r ? `⚠ ${r.error}` : '—';
  const s = scoreIdentity(r.identity, answers.get(r.barcode)!);
  const id = r.identity;
  return `${s.all ? '✓' : '✗'} ${id.brand} | ${id.productName} | ${id.variant ?? '—'} | ${id.size ?? '—'} (${id.confidence.toFixed(2)}, ${((r.latencyMs ?? 0) / 1000).toFixed(1)}s)`;
};
for (const ra of load(tagA)) {
  if (arm && ra.arm !== arm) continue;
  const rb = b.get(key(ra));
  if (!rb) continue;
  const okA = ra.identity && scoreIdentity(ra.identity, answers.get(ra.barcode)!).all;
  const okB = rb.identity && scoreIdentity(rb.identity, answers.get(rb.barcode)!).all;
  if (!!okA === !!okB && !process.env.ALL) continue;
  const a = answers.get(ra.barcode)!;
  console.log(`${ra.arm} ${ra.barcode} key: ${a.brand} | ${a.productName} | ${a.variant || '—'} | ${a.size}`);
  console.log(`   ${tagA}: ${show(ra)}`);
  console.log(`   ${tagB}: ${show(rb)}`);
}
