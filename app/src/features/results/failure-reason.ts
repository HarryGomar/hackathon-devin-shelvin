import { isBlockedCode } from '@/api/failure-codes';

import { strings } from './strings';

export { isBlockedCode };

/** Plain words for why a page wasn't fetched; `fallback` (the backend's error or reason) for a code we don't know. */
export function failureReasonLabel(code: string | undefined, fallback: string): string {
  const labels: Partial<Record<string, string>> = strings.failureReasons;
  return (code && labels[code]) || fallback;
}

/** Failures split into blocked by the site and couldn't fetch, each in its original order. */
export function splitFailures<T extends { code?: string }>(failures: T[]): { blocked: T[]; failed: T[] } {
  return {
    blocked: failures.filter((f) => isBlockedCode(f.code)),
    failed: failures.filter((f) => !isBlockedCode(f.code)),
  };
}
