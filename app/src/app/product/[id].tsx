import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { View } from 'react-native';

import { apiMode, getApi } from '@/api/client';
import type { ProductListings } from '@/api/types';
import { FailuresCard, formatDateTime, ListingTables, ProductHeader, savedPageIds, strings } from '@/features/results';
import { useSession } from '@/state/session';
import { useTheme } from '@/theme';
import { Button, DemoNotice, ErrorBanner, Screen, Skeleton, Text } from '@/ui';

export default function ProductScreen() {
  const { spacing } = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const resumeProduct = useSession((s) => s.resumeProduct);
  // Pages from this session's search, if it was this product's, tell same-product listings from similar ones.
  const pages = useSession((s) => s.pages);
  const similar = useSession((s) => s.search?.similarProducts);
  const [attempt, setAttempt] = useState(0);
  // Each load is tagged with its request key, so a stale response (other id, earlier attempt) reads as "still loading".
  const requestKey = `${id}#${attempt}`;
  const [loaded, setLoaded] = useState<{ key: string; data?: ProductListings; error?: string }>();

  // Reloads each time the screen is shown, so listings scraped after "Find more pages" appear on the way back.
  // While reloading, the listings already on screen stay.
  useFocusEffect(
    useCallback(() => {
      if (!id) return;
      let cancelled = false;
      getApi()
        .getProductListings(id)
        .then((result) => {
          if (!cancelled) setLoaded({ key: requestKey, data: result });
        })
        .catch((e: unknown) => {
          if (!cancelled) setLoaded((prev) => (prev?.key === requestKey && prev.data ? prev : { key: requestKey, error: e instanceof Error ? e.message : String(e) }));
        });
      return () => {
        cancelled = true;
      };
    }, [id, requestKey]),
  );

  const current = loaded?.key === requestKey ? loaded : undefined;
  const data = current?.data;
  const error = current?.error;

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const goHome = () => {
    if (router.canDismiss()) router.dismissAll();
    else router.replace('/');
  };

  const title = strings.savedListingsTitle.toUpperCase();

  if (error) {
    return (
      <Screen>
        <Stack.Screen options={{ title }} />
        <ErrorBanner message={error} onRetry={retry} />
        <Button title={strings.backHome} variant="ghost" onPress={goHome} />
      </Screen>
    );
  }

  if (!data) {
    return (
      <Screen>
        <Stack.Screen options={{ title }} />
        <View style={{ gap: spacing.sm }}>
          <Skeleton width="70%" height={22} />
          <Skeleton width="45%" height={12} />
        </View>
        <View style={{ gap: spacing.md }}>
          <Skeleton width="35%" height={10} />
          {[0, 1, 2].map((i) => (
            <View key={i} style={{ flexDirection: 'row', gap: spacing.md }}>
              <View style={{ flex: 1, gap: 6 }}>
                <Skeleton width="60%" height={14} />
                <Skeleton width="35%" height={10} />
              </View>
              <Skeleton width={56} height={16} />
            </View>
          ))}
        </View>
      </Screen>
    );
  }

  const { product, listings, failures = [] } = data;
  const latest = listings.reduce<string | undefined>((max, l) => (!max || l.scrapedAt > max ? l.scrapedAt : max), undefined);
  const latestText = formatDateTime(latest);

  // A new search for this product: Confirm (scan type, similar products) → Pages found, with the saved pages marked Scraped ✓.
  const findMore = () => {
    resumeProduct(product, savedPageIds(listings), data.failures);
    router.push('/confirm');
  };

  return (
    <Screen
      footer={
        <>
          <Text variant="caption" color="secondary">
            {strings.findMoreHint}
          </Text>
          <Button title={strings.findMorePages} variant="primary" size="lg" end={{ icon: 'magnifyingglass', fallback: '⌕' }} onPress={findMore} />
        </>
      }>
      <Stack.Screen options={{ title }} />
      {apiMode === 'mock' ? <DemoNotice label={strings.demoListings} message={strings.demoListingsMessage} /> : null}
      <ProductHeader product={product} note={latestText ? strings.lastScraped(latestText) : undefined} />
      <ListingTables
        listings={listings}
        product={product}
        pages={pages}
        similar={similar}
        empty={{ title: strings.noSavedTitle, message: strings.noSavedMessage }}
        onOpen={(listing) => router.push({ pathname: '/listing/[id]', params: { id: listing.id, productId: product.id } })}
      />
      <FailuresCard failures={failures} pages={pages} retryHint={strings.failuresSubtitleSaved} />
    </Screen>
  );
}
