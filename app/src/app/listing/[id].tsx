import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { apiMode, getApi } from '@/api/client';
import type { Listing } from '@/api/types';
import {
  comparePrices,
  groupByProduct,
  fieldRows,
  findListing,
  formatAmount,
  formatDelta,
  formatPrice,
  openListingPage,
  pricePer100,
  ratingText,
  RetailerHeader,
  shownPrice,
  stockText,
  strings,
  taxonomyNote,
  useRetailerLabel,
} from '@/features/results';
import { useSession } from '@/state/session';
import { useTheme } from '@/theme';
import { Button, Card, DashedRule, DemoNotice, EmptyState, ErrorBanner, Leader, NumberedTree, ProductImage, Screen, Skeleton, Text } from '@/ui';

/** One listing in full. Read from the current scrape when it's there, else from the product's saved listings. */
export default function ListingScreen() {
  const { id, productId } = useLocalSearchParams<{ id: string; productId?: string }>();
  const scrapeListings = useSession((s) => s.lastScrape?.listings);
  const sessionProduct = useSession((s) => s.identity);
  const sessionPages = useSession((s) => s.pages);
  const sessionSimilar = useSession((s) => s.search?.similarProducts);
  const fromScrape = id ? findListing(id, scrapeListings) : undefined;
  const needsFetch = !fromScrape && !!id && !!productId;
  const [attempt, setAttempt] = useState(0);
  // Each load is tagged with its request key, so a stale response (other listing, earlier attempt) reads as "still loading".
  const requestKey = `${productId}/${id}#${attempt}`;
  const [loaded, setLoaded] = useState<{ key: string; listing?: Listing; others?: Listing[]; productName?: string; productSize?: string; error?: string }>();

  useEffect(() => {
    if (!needsFetch || !productId) return;
    let cancelled = false;
    getApi()
      .getProductListings(productId)
      .then((result) => {
        if (!cancelled) setLoaded({ key: requestKey, listing: findListing(id, result.listings), others: result.listings, productName: result.product.productName, productSize: result.product.size });
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoaded({ key: requestKey, error: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [needsFetch, productId, id, requestKey]);

  const current = loaded?.key === requestKey ? loaded : undefined;
  const listing = fromScrape ?? current?.listing;
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  // The slip names the store, so the header doesn't repeat it.
  const header = <Stack.Screen options={{ title: strings.listingTitle.toUpperCase() }} />;

  if (listing) {
    const others = fromScrape ? (scrapeListings ?? []) : (current?.others ?? []);
    const productSize = fromScrape ? sessionProduct?.size : current?.productSize;
    const productName = fromScrape ? sessionProduct?.productName : current?.productName;
    // Compare only with listings of the same product (similar products' listings are saved alongside).
    const group = groupByProduct(others, productName ?? '', sessionPages, sessionSimilar).find((g) => g.listings.some((l) => l.id === listing.id));
    const same = group?.key === 'same';
    return <ListingDetail listing={listing} others={group?.comparable ? group.listings : []} productSize={same ? productSize : undefined} header={header} />;
  }

  if (current?.error) {
    return (
      <Screen>
        {header}
        <ErrorBanner message={current.error} onRetry={retry} />
      </Screen>
    );
  }

  if (needsFetch && !current) {
    return (
      <Screen>
        {header}
        <ListingSkeleton />
      </Screen>
    );
  }

  const goSaved = () => {
    if (productId) router.replace({ pathname: '/product/[id]', params: { id: productId } });
  };
  return (
    <Screen>
      {header}
      <EmptyState
        icon="doc.text.magnifyingglass"
        iconFallback="?"
        title={strings.listingNotFoundTitle}
        message={strings.listingNotFoundMessage}
        action={productId ? { title: strings.savedListingsTitle, onPress: goSaved } : undefined}
      />
    </Screen>
  );
}

// Fields shown as their own receipt lines (stock, rating) or not at all (the review count goes with the rating).
const CONSUMED_KEYS = new Set(['availability', 'stock', 'stock_status', 'disponibilidad', 'in_stock', 'inStock', 'available', 'rating', 'review_count', 'reviewCount', 'reviews']);

/** The receipt slip: store header, item, big price, leader lines, both category trees, and the same product elsewhere. */
function ListingDetail({ listing, others, productSize, header }: { listing: Listing; others: Listing[]; productSize?: string; header: ReactNode }) {
  const { spacing } = useTheme();
  const { categoryPath, standardTaxonomy } = listing;
  const price = shownPrice(listing);
  const retailer = useRetailerLabel(listing);
  const per = pricePer100(listing, productSize);
  const stock = stockText(listing.fields);
  const rating = ratingText(listing.fields);
  const fields = fieldRows(Object.fromEntries(Object.entries(listing.fields ?? {}).filter(([k]) => !CONSUMED_KEYS.has(k))));
  const note = taxonomyNote(standardTaxonomy);
  const hasTaxonomy = !!categoryPath?.length || !!standardTaxonomy?.path.length;
  const elsewhere = others.length > 1 ? others : [];

  return (
    <Screen
      footer={
        <Button
          title={strings.openPage}
          sub={listing.domain}
          variant="primary"
          size="lg"
          end={{ icon: 'arrow.up.right', fallback: '↗' }}
          onPress={() => openListingPage(listing)}
        />
      }>
      {header}
      {apiMode === 'mock' ? <DemoNotice label={strings.demoListings} message={strings.demoListingsMessage} /> : null}
      <Card style={[styles.slip, { gap: spacing.md }]}>
        <RetailerHeader listing={listing} />
        <DashedRule />
        <View style={[styles.itemRow, { gap: spacing.md }]}>
          <Text variant="heading" style={styles.flex}>
            {listing.title ?? retailer.name}
          </Text>
          {listing.imageUrl ? <ProductImage uri={listing.imageUrl} label={listing.title ?? retailer.name} size={56} /> : null}
        </View>
        {price ? (
          <View style={styles.bigPrice} accessible accessibilityLabel={formatPrice(price.amount, price.currency)}>
            <Text variant="label" color="secondary">
              {strings.priceLabel(price.currency).toUpperCase()}
            </Text>
            <Text variant="price">{formatPrice(price.amount, price.currency).replace(/\s?[A-Z]{3}$/, '')}</Text>
          </View>
        ) : null}
        <View>
          {per ? <Leader label={strings.per100(per.unit)} value={`$${formatAmount(per.amount)}`} /> : null}
          {stock ? <Leader label={strings.stock} value={stock.toUpperCase()} /> : null}
          {rating ? <Leader label={strings.rating} value={rating} /> : null}
          {fields.map((row) => (
            <Leader key={row.key} label={row.label} value={row.value} selectable />
          ))}
          {!per && !stock && !rating && fields.length === 0 ? (
            <Text variant="caption" color="secondary">
              {strings.noFields}
            </Text>
          ) : null}
        </View>

        {hasTaxonomy ? (
          <>
            <DashedRule />
            <View style={{ gap: spacing.md }}>
              {categoryPath?.length ? <NumberedTree label={strings.retailerCategory} path={categoryPath} /> : null}
              {standardTaxonomy?.path.length ? (
                <NumberedTree label={standardTaxonomy.system || strings.standardTaxonomy} path={standardTaxonomy.path} note={standardTaxonomy.code ? note : undefined} />
              ) : null}
            </View>
          </>
        ) : null}

        {elsewhere.length > 0 ? (
          <>
            <DashedRule />
            <Elsewhere current={listing} listings={elsewhere} />
          </>
        ) : null}

        <DashedRule />
        <Text variant="mono" color="secondary" selectable numberOfLines={3}>
          {listing.url}
        </Text>
      </Card>
    </Screen>
  );
}

/** "Same product elsewhere": every listing of the product with its price, ▼ LOW on the cheapest and +delta on the rest. */
function Elsewhere({ current, listings }: { current: Listing; listings: Listing[] }) {
  const comparison = comparePrices(listings);
  return (
    <View>
      <Text variant="label" color="secondary" style={styles.elsewhereLabel}>
        {strings.elsewhere.toUpperCase()}
      </Text>
      {listings.map((l) => {
        const me = l.id === current.id;
        const delta = comparison.deltas[l.id];
        const lowest = delta === 0;
        const price = shownPrice(l);
        return (
          <View key={l.id} style={styles.cmpRow}>
            <ElsewhereName listing={l} bold={me} />
            <Text variant="mono" style={[styles.cmpPrice, me && styles.bold]}>
              {price ? formatAmount(price.amount) : strings.empty}
            </Text>
            <Text variant="mono" color={lowest ? 'accent' : 'secondary'} style={[styles.cmpNote, lowest && styles.bold]}>
              {lowest ? strings.lowMark : delta !== undefined && delta > 0 ? formatDelta(delta) : ''}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

function ElsewhereName({ listing, bold }: { listing: Listing; bold: boolean }) {
  const { name } = useRetailerLabel(listing);
  return (
    <Text variant="mono" numberOfLines={1} style={[styles.flex, bold && styles.bold]}>
      {name}
    </Text>
  );
}

function ListingSkeleton() {
  const { spacing } = useTheme();
  return (
    <Card style={{ gap: spacing.md }}>
      <View style={[styles.center, { gap: spacing.sm }]}>
        <Skeleton width="45%" height={14} />
        <Skeleton width="35%" height={10} />
      </View>
      <DashedRule />
      <Skeleton width="80%" height={20} />
      <Skeleton width="40%" height={34} />
      <Skeleton height={12} />
      <Skeleton height={12} />
      <Skeleton width="70%" height={12} />
    </Card>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  bold: { fontWeight: '700' },
  center: { alignItems: 'center' },
  slip: { paddingVertical: 18 },
  itemRow: { flexDirection: 'row', alignItems: 'flex-start' },
  bigPrice: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 },
  elsewhereLabel: { marginBottom: 4 },
  cmpRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 24 },
  cmpPrice: { width: 72, textAlign: 'right' },
  cmpNote: { width: 56, textAlign: 'right', fontSize: 11 },
});
