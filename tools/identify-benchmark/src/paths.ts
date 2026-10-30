import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOOL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = join(TOOL_DIR, '..', '..');
export const APP_ENV_FILE = join(REPO_ROOT, 'app', '.env');

export const TESTSET_FILE = join(TOOL_DIR, 'testset.json');
export const ANSWERS_FILE = join(TOOL_DIR, 'answers.json');
export const ANSWERS_DRAFT_FILE = join(TOOL_DIR, 'answers.draft.json');
export const ANALYSIS_FILE = join(TOOL_DIR, 'analysis.md');

export const RESULTS_DIR = join(TOOL_DIR, 'results');
export const RESULTS_FILE = join(RESULTS_DIR, 'results.json');
export const REPORT_FILE = join(RESULTS_DIR, 'REPORT.md');

// Everything under cache/ is gitignored: OFF responses, product photos, raw Claude responses.
export const CACHE_DIR = join(TOOL_DIR, 'cache');
export const OFF_CACHE_DIR = join(CACHE_DIR, 'off');
export const IMG_CACHE_DIR = join(CACHE_DIR, 'img');
export const CLAUDE_CACHE_DIR = join(CACHE_DIR, 'claude');
export const PHOTO_CACHE_DIR = join(CACHE_DIR, 'photo-step');
export const RUNS_DIR = join(TOOL_DIR, 'results', 'runs');
export const SHEETS_DIR = join(CACHE_DIR, 'sheets');
