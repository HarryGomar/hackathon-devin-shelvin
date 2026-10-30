/**
 * Runs the app's identification pipeline on the test set and writes results/runs/<tag>.json (and, with --publish,
 * results/results.json and results/REPORT.md).
 *
 *   npm run bench -- --tag baseline --arms B,C,D,E     arms (A is free; B–E call Claude, capped at --max-cost)
 *   npm run bench -- --tag haiku --options '{"normalizeModel":"claude-haiku-5-5"}'   try an IdentifyOptions override
 *   npm run bench -- --only 7501011123588,75007614     a few products
 *   npm run report -- --tag final                      re-score a run and rewrite REPORT.md
 *
 * Claude responses, OFF records and photo-step results are cached and replayed with their original latency.
 * Key: ANTHROPIC_API_KEY, else EXPO_PUBLIC_ANTHROPIC_API_KEY from app/.env. Never printed.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { CLAUDE_MODEL } from '../../../app/src/services/claude/client.ts';
import { isThinRecord } from '../../../app/src/services/identify/parse.ts';
import { DEFAULT_OPTIONS, type IdentifyOptions } from '../../../app/src/services/identify/pipeline.ts';
import { ARM_NEEDS, runArm } from './arms.ts';
import { FatalApiError, totalSpend } from './claude.ts';
import { ANSWERS_FILE, REPORT_FILE, RESULTS_DIR, RESULTS_FILE, RUNS_DIR, TESTSET_FILE } from './paths.ts';
import { renderReport, type ResultsFile } from './report.ts';
import { scoreIdentity } from './score.ts';
import type { Answer, ArmId, ArmResult, TestItem } from './types.ts';

const { values: args } = parseArgs({
  options: {
    'report-only': { type: 'boolean', default: false },
    publish: { type: 'boolean', default: false },
    fresh: { type: 'boolean', default: false },
    arms: { type: 'string', default: 'A,B,D,E' },
    tag: { type: 'string', default: 'dev' },
    options: { type: 'string', default: '{}' },
    limit: { type: 'string' },
    only: { type: 'string' },
    'c-limit': { type: 'string', default: '12' },
    'skip-web': { type: 'boolean', default: false },
    concurrency: { type: 'string', default: '6' },
    'max-cost': { type: 'string', default: '2' },
  },
});

const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8')) as T;

let items = readJson<TestItem[]>(TESTSET_FILE);
if (args.only) items = items.filter((i) => args.only!.split(',').includes(i.barcode));
if (args.limit) items = items.slice(0, Number(args.limit));
// Products whose barcode path web-searches (no brand in OFF): the priciest calls, skippable while iterating on photos.
if (args['skip-web']) items = items.filter((i) => !isThinRecord(i.off));
const allItems = readJson<TestItem[]>(TESTSET_FILE);
const answers = new Map(readJson<Answer[]>(ANSWERS_FILE).map((a) => [a.barcode, a]));
for (const item of allItems) if (!answers.has(item.barcode)) throw new Error(`answers.json has no entry for ${item.barcode}`);

const runFile = (tag: string) => join(RUNS_DIR, `${tag}.json`);

function scoreAll(results: ArmResult[]): ArmResult[] {
  return results.map((r) => ({ ...r, score: r.identity ? scoreIdentity(r.identity, answers.get(r.barcode)!) : undefined }));
}

function loadRuns(): ResultsFile[] {
  if (!existsSync(RUNS_DIR)) return [];
  return readdirSync(RUNS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJson<ResultsFile>(join(RUNS_DIR, f)))
    .map((r) => ({ ...r, results: scoreAll(r.results) }));
}

function write(data: ResultsFile): void {
  mkdirSync(RUNS_DIR, { recursive: true });
  writeFileSync(runFile(data.tag), JSON.stringify(data, null, 2) + '\n');
  console.log(`\n→ ${runFile(data.tag)}`);
  if (args.publish) {
    mkdirSync(RESULTS_DIR, { recursive: true });
    writeFileSync(RESULTS_FILE, JSON.stringify(data, null, 2) + '\n');
    writeFileSync(REPORT_FILE, renderReport(data, allItems, answers, loadRuns()));
    console.log(`→ ${RESULTS_FILE}\n→ ${REPORT_FILE}`);
  }
}

if (args['report-only']) {
  const file = runFile(args.tag);
  if (!existsSync(file)) throw new Error(`No ${file}; run \`npm run bench -- --tag ${args.tag}\` first`);
  const data = readJson<ResultsFile>(file);
  args.publish = true;
  write({ ...data, results: scoreAll(data.results) });
  process.exit(0);
}

const arms = args.arms.split(',').map((a) => a.trim().toUpperCase()) as ArmId[];
const options: IdentifyOptions = { ...DEFAULT_OPTIONS, ...(JSON.parse(args.options) as Partial<IdentifyOptions>) };
const spent = { usd: 0 };
const maxCost = Number(args['max-cost']);
const cLimit = Number(args['c-limit']);

// Interleaved per product so a cost stop cuts every arm evenly. Arm C (web search, the priciest) runs on the first
// --c-limit products that have an OFF record.
const jobs: { arm: ArmId; item: TestItem }[] = [];
let cCount = 0;
for (const item of items) {
  for (const arm of arms) {
    if (!ARM_NEEDS[arm](item)) continue;
    if (arm === 'C' && cCount++ >= cLimit) continue;
    jobs.push({ arm, item });
  }
}

console.log(`${jobs.length} runs, options ${JSON.stringify(options)}, cap $${maxCost} (all-time fresh spend so far $${totalSpend().toFixed(2)})`);
const results: ArmResult[] = [];
let next = 0;
let stop: string | undefined;
const worker = async (): Promise<void> => {
  while (next < jobs.length) {
    const { arm, item } = jobs[next++]!;
    if (stop) {
      results.push({ arm, barcode: item.barcode, status: 'skipped', error: stop });
      continue;
    }
    try {
      const r = await runArm(arm, item, { options, transport: { fresh: args.fresh, maxCostUsd: maxCost, spent, reserveUsd: 0.1 } });
      results.push(r);
      const s = r.identity ? scoreIdentity(r.identity, answers.get(r.barcode)!) : undefined;
      const fresh = (r.calls ?? []).filter((c) => !c.cached).length;
      console.log(
        `[${arm}] ${item.barcode} ${r.status}${r.error ? ` (${r.error})` : ''} ${s ? (s.all ? '✓' : '✗') : ''}` +
          `${r.identity ? ` conf ${r.identity.confidence.toFixed(2)}` : ''} ${((r.latencyMs ?? 0) / 1000).toFixed(1)}s` +
          ` ${(r.calls ?? []).map((c) => c.kind).join('+') || 'no-claude'}${fresh ? ` (${fresh} fresh)` : ''}  run $${spent.usd.toFixed(2)}`,
      );
    } catch (e) {
      if (!(e instanceof FatalApiError)) throw e;
      stop = e.message;
      results.push({ arm, barcode: item.barcode, status: 'skipped', error: stop });
    }
  }
};
await Promise.all(Array.from({ length: Math.max(1, Number(args.concurrency)) }, worker));
if (stop) console.warn(`\nStopped early: ${stop}`);
console.log(`This run spent $${spent.usd.toFixed(2)} on fresh calls; all-time $${totalSpend().toFixed(2)}.`);

const order = new Map(allItems.map((item, i) => [item.barcode, i]));
results.sort((a, b) => order.get(a.barcode)! - order.get(b.barcode)! || a.arm.localeCompare(b.arm));

// Merge into an existing run with the same tag (so arms or products can be added in several invocations).
const prev = existsSync(runFile(args.tag)) ? readJson<ResultsFile>(runFile(args.tag)) : undefined;
const key = (r: ArmResult) => `${r.arm}:${r.barcode}`;
const fresh = new Set(results.map(key));
const merged = [...(prev?.results ?? []).filter((r) => !fresh.has(key(r))), ...results].sort(
  (a, b) => (order.get(a.barcode) ?? 0) - (order.get(b.barcode) ?? 0) || a.arm.localeCompare(b.arm),
);

write({
  tag: args.tag,
  generatedAt: new Date().toISOString(),
  model: CLAUDE_MODEL,
  options,
  armsRun: [...new Set([...(prev?.armsRun ?? []), ...arms])].sort(),
  products: allItems.length,
  results: scoreAll(merged),
});
