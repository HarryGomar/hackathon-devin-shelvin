import { router } from 'expo-router';
import { useState } from 'react';
import type { ProductIdentity, ScrapeResult } from '@/api/types';
import { CatalogTable, FailuresCard, formatTime, ListingTables, openListingPage, ProductHeader, strings } from '@/features/results';
import { apiMode } from '@/api/client';
import { useSession } from '@/state/session';
import { Button, DemoNotice, EmptyState, Screen, SuccessBanner } from '@/ui';

function goHome() {
  if (router.canDismiss()) router.dismissAll();
  else router.replace('/');
}

export default function ResultsScreen() {
  const storedScrape = useSession((s) => s.lastScrape);
  const storedIdentity = useSession((s) => s.identity);
  const pages = useSession((s) => s.pages);
  const similar = useSession((s) => s.search?.similarProducts);
  const reset = useSession((s) => s.reset);
  // Keeps the results on screen while it animates away after "Scan another item" clears the session.
  const [leaving, setLeaving] = useState<{ scrape?: ScrapeResult; identity?: ProductIdentity }>();
  const scrape = leaving ? leaving.scrape : storedScrape;
  const identity = leaving ? leaving.identity : storedIdentity;

  if (!scrape) {
    return (
      <Screen>
        <EmptyState
          icon="tray"
          iconFallback="∅"
          title={strings.noResultsTitle}
          message={strings.noResultsMessage}
          action={{ title: strings.backHome, onPress: goHome }}
        />
      </Screen>
    );
  }

  const count = scrape.listings.length;
  const ok = scrape.saved && count > 0;
  const banner = ok ? strings.savedBanner(count, formatTime(scrape.savedAt)) : count === 0 ? strings.nothingSavedBanner : strings.notSavedBanner(count);

  const scanAnother = () => {
    setLeaving({ scrape: storedScrape, identity: storedIdentity });
    reset();
    goHome();
  };

  const scrapeMore = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/sources');
  };

  return (
    <Screen
      footer={
        <>
          <Button title={strings.scanAnother} variant="primary" size="lg" end={{ icon: 'arrow.right', fallback: '→' }} onPress={scanAnother} />
          <Button title={strings.scrapeMore} variant="secondary" onPress={scrapeMore} />
        </>
      }>
      <SuccessBanner message={banner} tone={ok ? 'success' : 'warning'} />
      {apiMode === 'mock' ? <DemoNotice label={strings.demoListings} message={strings.demoListingsMessage} /> : null}
      {identity ? <ProductHeader product={identity} /> : null}
      {identity ? (
        <ListingTables
          listings={scrape.listings}
          product={identity}
          pages={pages}
          similar={similar}
          empty={{ title: strings.noListingsTitle, message: strings.noListingsMessage }}
          onOpen={(listing) => router.push({ pathname: '/listing/[id]', params: { id: listing.id, productId: identity.id } })}
        />
      ) : null}
      {scrape.catalogs?.map((c) => (
        <CatalogTable key={c.pageId} catalog={c} listings={scrape.listings} onOpen={openListingPage} />
      ))}
      <FailuresCard failures={scrape.failures} pages={pages} retryHint={strings.failuresSubtitle} />
    </Screen>
  );
}
