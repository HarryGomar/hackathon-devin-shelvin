/** npm run compare: every run's all-fields accuracy and latency p50 / p90 per arm, plus the all-time fresh spend. */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { totalSpend } from './claude.ts';
import { ANSWERS_FILE, RUNS_DIR } from './paths.ts';
import { armSummary, type ResultsFile } from './report.ts';
import { scoreIdentity } from './score.ts';
import type { Answer, ArmId } from './types.ts';

const answers = new Map((JSON.parse(readFileSync(ANSWERS_FILE, 'utf8')) as Answer[]).map((a) => [a.barcode, a]));
const only = process.argv[2]?.split(',');
const runs = existsSync(RUNS_DIR)
  ? readdirSync(RUNS_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(readFileSync(join(RUNS_DIR, f), 'utf8')) as ResultsFile)
      .filter((r) => !only || only.includes(r.tag))
      .sort((a, b) => a.generatedAt.localeCompare(b.generatedAt))
  : [];
const s = (ms?: number) => (ms === undefined ? '–' : (ms / 1000).toFixed(1));
for (const run of runs) {
  const results = run.results.filter((r) => answers.has(r.barcode)).map((r) => ({ ...r, score: r.identity ? scoreIdentity(r.identity, answers.get(r.barcode)!) : undefined }));
  const cells = (['A', 'B', 'C', 'D', 'E'] as ArmId[])
    .map((arm) => {
      const x = armSummary(results.filter((r) => r.arm === arm), answers);
      return x.ran ? `${arm} ${x.all}/${x.n} cw${x.confidentWrong} ${s(x.p50)}/${s(x.p90)}s $${(x.cost / x.ran).toFixed(3)}` : '';
    })
    .filter(Boolean);
  console.log(`${run.tag.padEnd(22)} ${cells.join('  |  ')}`);
}
console.log(`all-time fresh spend $${totalSpend().toFixed(2)}`);
