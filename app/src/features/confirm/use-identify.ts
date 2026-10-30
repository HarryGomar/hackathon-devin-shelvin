import { useEffect, useState } from 'react';

import type { ScanInput } from '@/api/types';
import { identifyProduct } from '@/services/identify';
import { useSession } from '@/state/session';

import { strings } from './strings';

/**
 * Identifies the session's input once, when there's an input but no identity yet.
 * Results for an input that's no longer current are dropped.
 */
export function useIdentify() {
  const input = useSession((s) => s.input);
  const identity = useSession((s) => s.identity);
  const setIdentity = useSession((s) => s.setIdentity);
  const [failure, setFailure] = useState<{ input: ScanInput; message: string }>();

  const failed = !!input && failure?.input === input;

  useEffect(() => {
    if (!input || identity || failed) return;
    let cancelled = false;
    const isCurrent = () => !cancelled && useSession.getState().input === input && !useSession.getState().identity;
    identifyProduct(input).then(
      (product) => {
        if (isCurrent()) setIdentity(product);
      },
      (e: unknown) => {
        if (isCurrent()) setFailure({ input, message: e instanceof Error ? e.message : strings.identifyFailed });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [input, identity, failed, setIdentity]);

  return {
    identifying: !!input && !identity && !failed,
    error: failed && !identity ? failure?.message : undefined,
    retry: () => setFailure(undefined),
  };
}
