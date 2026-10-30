/** Renders results/REPORT.md from a scored run (and a comparison of every run). Hand-written conclusions come from analysis.md. */
import { existsSync, readFileSync } from 'node:fs';

import type { IdentifyOptions } from '../../../app/src/services/identify/pipeline.ts';
import { PRICING_NOTE } from './claude.ts';
import { ANALYSIS_FILE } from './paths.ts';
import { CONFIDENT, NAME_OVERLAP } from './score.ts';
import { ARMS, type Answer, type ArmId, type ArmResult, type TestItem } from './types.ts';

export interface ResultsFile {
  tag: string;
  generatedAt: string;
  model: string;
  options: IdentifyOptions;
  armsRun: ArmId[];
  products: number;
  results: ArmResult[];
}

const ARM_IDS: ArmId[] = ['A', 'B', 'C', 'D', 'E'];

const pct = (k: number, n: number) => (n === 0 ? '–' : `${k}/${n} (${Math.round((100 * k) / n)}%)`);
const usd = (n: number) => `$${n.toFixed(n < 0.1 ? 3 : 2)}`;
const secs = (ms: number | undefined) => (ms === undefined ? '–' : `${(ms / 1000).toFixed(1)}s`);
const cell = (s: string | undefined) => (s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function quantile(xs: number[], q: number): number | undefined {
  if (xs.length === 0) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)];
}

const mean = (xs: number[]) => (xs.length === 0 ? undefined : xs.reduce((a, b) => a + b, 0) / xs.length);
const fmt2 = (n: number | undefined) => (n === undefined ? '–' : n.toFixed(2));

/** Photo arms can't be expected to read a photo with no label on it; those products leave their accuracy counts. */
const counted = (r: ArmResult, answers: Map<string, Answer>) => !(r.arm === 'D' && answers.get(r.barcode)!.photo === 'no-label');

export function armSummary(rs: ArmResult[], answers: Map<string, Answer>) {
  const ran = rs.filter((r) => r.status === 'ok' || r.status === 'error');
  const acc = ran.filter((r) => counted(r, answers));
  const ok = (f: (r: ArmResult) => boolean) => acc.filter(f).length;
  const withVariant = acc.filter((r) => answers.get(r.barcode)!.variant);
  const right = ran.filter((r) => r.score?.all).map((r) => r.identity!.confidence);
  const wrong = ran.filter((r) => r.identity && !r.score?.all).map((r) => r.identity!.confidence);
  const lat = ran.map((r) => r.latencyMs ?? 0);
  return {
    ran: ran.length,
    n: acc.length,
    errors: ran.filter((r) => r.status === 'error').length,
    fellBack: ran.filter((r) => r.fellBackToOff).length,
    brand: ok((r) => !!r.score?.brand),
    name: ok((r) => !!r.score?.name),
    variant: withVariant.filter((r) => r.score?.variant === true).length,
    variantN: withVariant.length,
    size: ok((r) => !!r.score?.size),
    all: ok((r) => !!r.score?.all),
    confidentWrong: ran.filter((r) => r.score?.confidentWrong).length,
    confRight: mean(right),
    confWrong: mean(wrong),
    p50: quantile(lat, 0.5),
    p90: quantile(lat, 0.9),
    callsPerScan: mean(ran.map((r) => r.calls?.length ?? 0)),
    cost: ran.reduce((s, r) => s + (r.costUsd ?? 0), 0),
    skipped: rs.filter((r) => r.status === 'skipped').length,
  };
}

function predicted(r: ArmResult): string {
  const id = r.identity!;
  return `\`${[id.brand, id.productName, id.variant ?? '—', id.size ?? '—'].join(' | ')}\` (conf ${id.confidence.toFixed(2)})`;
}

const keyText = (a: Answer) => `\`${[a.brand, a.productName, a.variant || '—', a.size].join(' | ')}\``;

function explain(r: ArmResult, a: Answer): string {
  const s = r.score!;
  const id = r.identity!;
  const why: string[] = [];
  if (!s.brand) why.push(`brand "${id.brand}" ≠ "${a.brand}"${a.brandAliases ? ` (or ${a.brandAliases.join(', ')})` : ''}`);
  if (!s.name) why.push(`name overlap ${s.nameOverlap} < ${NAME_OVERLAP} ("${id.productName}" vs "${a.productName}")`);
  if (s.variant === false) why.push(`variant "${id.variant ?? ''}" ≠ "${a.variant}"`);
  if (!s.size) why.push(id.size ? `size "${id.size}" ≠ "${a.size}"` : 'no size returned');
  const via = r.fellBackToOff ? ' (Claude failed; OFF record used)' : r.arm === 'A' ? ' (raw OFF record)' : '';
  const calls = r.calls?.length ? ` Calls: ${r.calls.map((c) => c.kind).join(' + ')}.` : '';
  return `${why.join('; ')}${via}.${calls}${a.uncertain ? ' The key itself is uncertain here.' : ''}`;
}

const groupLabel: Record<TestItem['offStatus'], string> = { full: 'full OFF record', thin: 'thin OFF record', none: 'no OFF record' };

export function renderReport(data: ResultsFile, items: TestItem[], answers: Map<string, Answer>, runs: ResultsFile[] = []): string {
  const itemOf = new Map(items.map((i) => [i.barcode, i]));
  const byArm = new Map(ARM_IDS.map((arm) => [arm, data.results.filter((r) => r.arm === arm)]));
  const summaries = new Map(ARM_IDS.map((arm) => [arm, armSummary(byArm.get(arm)!, answers)]));
  const L: string[] = [];

  L.push('# Identification benchmark: products sold in Mexico', '');
  L.push(
    `Run \`${data.tag}\`, generated ${data.generatedAt.slice(0, 16).replace('T', ' ')} UTC by \`tools/identify-benchmark\`. ` +
      `${data.products} products. Main model \`${data.model}\`; pipeline options \`${JSON.stringify(data.options)}\`. ` +
      'Every arm runs the app\'s own pipeline (`app/src/services/identify/pipeline.ts`) end to end.',
  );
  L.push('', `Claude cost of the calls in this run: **${usd([...summaries.values()].reduce((s, x) => s + x.cost, 0))}** (${PRICING_NOTE}).`);

  L.push('', '## Summary by arm', '');
  L.push(
    `"All fields" = brand, name (token overlap ≥ ${NAME_OVERLAP}), size, and variant when the key has one. ` +
      `"Confident & wrong" = not all fields right while the app would show confidence ≥ ${CONFIDENT}. ` +
      'Latency is end to end (OFF lookups, every Claude call, the photo step), replayed from the recorded timings. Errors count as wrong.',
    '',
  );
  L.push('| Arm | Products | Errors | Brand | Name | Variant | Size | **All fields** | Confident & wrong | Mean conf. right / wrong | **Latency p50 / p90** | Claude calls / scan | Cost / scan |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const arm of ARM_IDS) {
    const s = summaries.get(arm)!;
    if (s.ran === 0) continue;
    L.push(
      `| ${arm}. ${ARMS[arm]} | ${s.n}${s.skipped ? ` (+${s.skipped} skipped)` : ''} | ${s.errors}${s.fellBack ? ` (+${s.fellBack} OFF fallback)` : ''} | ${pct(s.brand, s.n)} | ${pct(s.name, s.n)} | ${pct(s.variant, s.variantN)} | ${pct(s.size, s.n)} | **${pct(s.all, s.n)}** | ${s.confidentWrong} | ${fmt2(s.confRight)} / ${fmt2(s.confWrong)} | **${secs(s.p50)} / ${secs(s.p90)}** | ${fmt2(s.callsPerScan)} | ${s.ran ? usd(s.cost / s.ran) : '–'} |`,
    );
  }

  L.push('', '### Barcode path (B) by Open Food Facts coverage', '');
  L.push('| OFF record | Products | All fields | Confident & wrong | Latency p50 / p90 | Cost / scan |', '|---|---|---|---|---|---|');
  for (const status of ['full', 'thin', 'none'] as const) {
    const rs = byArm.get('B')!.filter((r) => itemOf.get(r.barcode)?.offStatus === status);
    const s = armSummary(rs, answers);
    if (s.ran === 0) continue;
    L.push(`| ${groupLabel[status]} | ${s.n} | ${pct(s.all, s.n)} | ${s.confidentWrong} | ${secs(s.p50)} / ${secs(s.p90)} | ${usd(s.cost / s.ran)} |`);
  }

  if (runs.length > 1) {
    L.push('', '## Runs compared', '');
    L.push('Each run is one pipeline configuration (`npm run bench -- --tag <name> --options …`). Cells: all fields right, latency p50 / p90. Only products in both the run and the current test set count.', '');
    L.push(`| Run | Options | ${ARM_IDS.join(' | ')} |`, `|---|---|${ARM_IDS.map(() => '---').join('|')}|`);
    for (const run of [...runs].sort((a, b) => a.generatedAt.localeCompare(b.generatedAt))) {
      const cells = ARM_IDS.map((arm) => {
        const s = armSummary(run.results.filter((r) => r.arm === arm && answers.has(r.barcode)), answers);
        return s.ran === 0 ? '' : `${pct(s.all, s.n)}, ${secs(s.p50)} / ${secs(s.p90)}`;
      });
      L.push(`| \`${run.tag}\` | \`${cell(JSON.stringify(run.options))}\` | ${cells.join(' | ')} |`);
    }
  }

  L.push('', '## Per product', '');
  L.push('✓ = all fields right. Otherwise the wrong fields: **b**rand, **n**ame, **v**ariant, **s**ize. The number is the confidence the app would show; ❗ = confident and wrong; ⚠ = error; ↩ = Claude failed and the app fell back to OFF; blank = not run.', '');
  L.push(`| # | Barcode | OFF | Key: brand \\| name \\| variant \\| size | ${ARM_IDS.join(' | ')} |`, `|---|---|---|---|${ARM_IDS.map(() => '---').join('|')}|`);
  items.forEach((item, i) => {
    const a = answers.get(item.barcode)!;
    const flags = `${a.uncertain ? ' ?' : ''}${item.tricky?.length ? ` _(${item.tricky.join(', ')})_` : ''}`;
    const cells = ARM_IDS.map((arm) => {
      const r = byArm.get(arm)!.find((x) => x.barcode === item.barcode);
      if (!r || r.status === 'skipped') return '';
      if (!r.identity) return `⚠ ${r.error}`;
      const s = r.score!;
      const wrong = [!s.brand && 'b', !s.name && 'n', s.variant === false && 'v', !s.size && 's'].filter(Boolean).join('');
      return `${r.fellBackToOff ? '↩ ' : ''}${s.all ? '✓' : `✗ ${wrong}`} ${r.identity.confidence.toFixed(2)}${s.confidentWrong ? ' ❗' : ''}`;
    });
    L.push(`| ${i + 1} | ${item.barcode} | ${item.offStatus} | ${cell([a.brand, a.productName, a.variant || '—', a.size].join(' | '))}${flags} | ${cells.join(' | ')} |`);
  });

  const failures = data.results
    .filter((r) => r.identity && r.score && !r.score.all)
    .sort((x, y) => Number(y.score!.confidentWrong) - Number(x.score!.confidentWrong) || y.identity!.confidence - x.identity!.confidence);
  const errors = data.results.filter((r) => r.status === 'error');
  L.push('', '## Failures', '');
  L.push(failures.length === 0 && errors.length === 0 ? 'None.' : 'Confident-and-wrong first, then by confidence.', '');
  for (const r of failures.slice(0, 25)) {
    const a = answers.get(r.barcode)!;
    L.push(`- **${r.arm} · ${a.productName}** (${r.barcode})${r.score!.confidentWrong ? ' ❗' : ''}: predicted ${predicted(r)}; key ${keyText(a)}. ${explain(r, a)}`);
  }
  if (failures.length > 25) L.push(`- …and ${failures.length - 25} more in results.json.`);
  for (const r of errors) L.push(`- **${r.arm} · ${answers.get(r.barcode)!.productName}** (${r.barcode}): error \`${r.error}\`.`);

  L.push('', '## Analysis', '');
  L.push(existsSync(ANALYSIS_FILE) ? readFileSync(ANALYSIS_FILE, 'utf8').trim() : '_Not written yet._');

  L.push('', '## Method', '');
  L.push(
    '- **Test set** (`testset.json`): the first 25 products were picked from Open Food Facts (`countries_tags:"en:mexico"`, by scan count) and all have a full record. The rest were added to cover hard cases: thin or missing OFF records, several sizes or flavors of one line, UPC-A codes, store brands and imports; their barcodes were confirmed on OFF or retailer pages (Walmart México product URLs embed the GTIN).',
    '- **Answer key** (`answers.json`): checked by hand against the pack photo and retailer pages; `checkNote` says what was verified.',
    '- **Arms** run `identifyBarcode` / `identifyPhoto` from `app/src/services/identify/pipeline.ts` with the app\'s request bodies (`requests.ts`), parsing (`parse.ts`) and photo step (`services/photo`). Only the I/O is swapped: Open Food Facts records, Claude responses and photo-step results are cached on disk and replayed after waiting their originally measured latency, so reruns are free and timings stay end to end. **C** hides the OFF record (the app then web-searches the barcode). **D** uses the front photo, **E** a photo that shows the barcode, both downscaled to ≤1024 px JPEG quality 70 like the app\'s `preparePhoto`.',
    `- **Scoring** (\`src/score.ts\`): text lowercased, accents and punctuation removed, Spanish stopwords and plural "s" dropped. Name = Dice token overlap ≥ ${NAME_OVERLAP} against the key name or an alias. Brand = exact after normalizing, or an alias. Variant = the key's variant words appear in the predicted variant or name (a default variant like "Original" may be left unsaid). Size = same amount in g or ml within 1%.`,
    '- **Latency** p50 / p90 over the products each arm ran. One run per product; a rerun with `--fresh` could differ by a product or two.',
  );

  L.push('', '## Answer key notes', '');
  for (const item of items) {
    const a = answers.get(item.barcode)!;
    L.push(`- ${item.barcode} **${a.productName}**${a.uncertain ? ' ?' : ''}: ${a.checkNote}`);
  }
  return L.join('\n') + '\n';
}
