// Run: BASE_URL=https://… TOKEN=… npm run check   |   npm run check -- --mock   (see README.md)
import { parseArgs } from 'node:util';

import { runChecks, type CheckResult } from './checks.ts';
import { startStub } from './stub.ts';

const { values } = parseArgs({
  options: {
    mock: { type: 'boolean', default: false },
    'no-search': { type: 'boolean', default: false },
    product: { type: 'string' },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  console.log(`Shelvin backend contract check

  BASE_URL=https://api.example.com TOKEN=… npm run check [-- options]
  npm run check -- --mock          against a built-in local stub (no network, no cost)

Options:
  --no-search         skip search, scraper build and scrape (they cost money on a real server)
  --product <json>    the confirmed ProductIdentity to search for (default: Doritos Nacho 61 g)
  --json              print the results as JSON
Env: BASE_URL, TOKEN, POLL_MS (default 1000), JOB_TIMEOUT_MS (default 150000)`);
  process.exit(0);
}

const ICON: Record<CheckResult['status'], string> = { pass: 'PASS', warn: 'WARN', fail: 'FAIL', skip: 'SKIP' };

function print(r: CheckResult) {
  const time = r.ms !== undefined ? ` (${r.ms} ms)` : '';
  const note = r.note ? ` — ${r.note}` : '';
  console.log(`${ICON[r.status]}  ${r.name}${time}${note}`);
  for (const i of r.issues) console.log(`      ${i.severity === 'error' ? '✗' : '!'} ${i.path ? `${i.path}: ` : ''}${i.message}`);
}

async function main() {
  const stub = values.mock ? await startStub({ token: 'contract-check-token' }) : undefined;
  const baseUrl = stub?.baseUrl ?? process.env.BASE_URL;
  if (!baseUrl) {
    console.error('Set BASE_URL (and TOKEN), or pass --mock. See --help.');
    process.exit(2);
  }
  const token = stub ? 'contract-check-token' : process.env.TOKEN || undefined;
  if (!values.json) {
    console.log(`Checking ${baseUrl}${stub ? ' (local stub)' : ''}${token ? ' with a token' : ' without a token'}`);
    if (!stub && !values['no-search']) console.log('Note: search, build and scrape run for real (an agent search or a builder session can cost money). Use --no-search to skip them.\n');
  }
  try {
    const results = await runChecks({
      baseUrl,
      token,
      search: !values['no-search'],
      product: values.product ? JSON.parse(values.product) : undefined,
      pollMs: Number(process.env.POLL_MS) || 1000,
      jobTimeoutMs: Number(process.env.JOB_TIMEOUT_MS) || 150_000,
      onResult: values.json ? undefined : print,
    });
    const count = (s: CheckResult['status']) => results.filter((r) => r.status === s).length;
    if (values.json) console.log(JSON.stringify(results, null, 2));
    else console.log(`\n${count('pass')} passed, ${count('warn')} with warnings, ${count('fail')} failed, ${count('skip')} skipped`);
    process.exitCode = count('fail') > 0 ? 1 : 0;
  } finally {
    await stub?.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
