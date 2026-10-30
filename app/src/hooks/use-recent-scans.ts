import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';

import { getApi } from '@/api/client';
import type { ScanSummary } from '@/api/types';

/** GET /scans, reloaded whenever the screen regains focus. */
export function useRecentScans() {
  const [scans, setScans] = useState<ScanSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      setScans(await getApi().listScans());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );

  return { scans, loading, error, refresh };
}
