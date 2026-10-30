// Contract additions from docs/backend-spec.md beyond the app's types.ts.
/** `GET /health` body. */
export interface HealthResponse {
  ok: true;
  version?: string;
}

/** Every non-2xx body. `error` is shown to the user as is. */
export interface ErrorBody {
  error: string;
  code?: string;
}

export type JobKind = 'search' | 'build' | 'scrape';

/** `progress.step` keys the app draws, in order (app/src/features/sources/*-screen.tsx). `done` may follow the last. */
export const STEP_KEYS: Record<JobKind, readonly string[]> = {
  search: ['search', 'verify', 'rank'],
  build: ['probe', 'build', 'gate', 'merge'],
  scrape: ['scrape', 'taxonomy', 'save'],
};
