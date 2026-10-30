import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import type { BrandCatalog, Listing } from '@/api/types';
import { useTheme } from '@/theme';
import { Cell, GroupLabel, Row, StatusWord, TableHead, Text } from '@/ui';

import { catalogMatchIndex, catalogPriceCurrency, catalogVisibleRows } from './catalog';
import { formatAmount, shownPrice } from './compare';
import { retailerLabel } from './retailer';
import { strings } from './strings';

const LIMIT = 8;
const PRICE_WIDTH = 78;

/**
 * A brand's own site, read as its whole catalog: every product it lists, the scanned one marked SCANNED. Kept out of
 * the price comparison (other products, and the brand's list price). The first 8 rows, then "Show all".
 */
export function CatalogTable({ catalog, listings, onOpen }: { catalog: BrandCatalog; listings: Listing[]; onOpen: (listing: Listing) => void }) {
  const { colors, spacing } = useTheme();
  const [showAll, setShowAll] = useState(false);
  const match = catalogMatchIndex(catalog, listings);
  const rows = catalogVisibleRows(catalog, match, LIMIT, showAll);
  // Some brand sites list no prices: no price column then.
  const currency = catalogPriceCurrency(catalog);
  const more = catalog.listings.length > LIMIT;

  return (
    <View style={{ gap: spacing.xs }}>
      <GroupLabel label={strings.catalogTitle(retailerLabel(catalog.retailerName, 'first_party').name, catalog.count)} />
      <Text variant="caption" color="secondary" style={{ paddingTop: spacing.xs }}>
        {strings.catalogHint}
      </Text>
      <View>
        <TableHead columns={[{ label: strings.catalogProductColumn }, ...(currency ? [{ label: currency, width: PRICE_WIDTH, align: 'right' as const }] : [])]} />
        {rows.map(({ listing, index }) => {
          const scanned = index === match;
          const price = shownPrice(listing);
          return (
            <Row
              key={listing.id}
              onPress={() => onOpen(listing)}
              accessibilityLabel={`${listing.title ?? listing.url}${scanned ? `, ${strings.catalogScanned}` : ''}`}
              style={scanned ? [styles.scanned, { backgroundColor: colors.surface, borderLeftColor: colors.accent }] : undefined}>
              <Cell>
                <Text variant="subheading" numberOfLines={2}>
                  {listing.title ?? listing.url}
                </Text>
                {scanned ? <StatusWord label={strings.catalogScanned} tone="accent" /> : null}
              </Cell>
              {currency ? (
                <Cell width={PRICE_WIDTH} align="right">
                  <Text variant="number">{price ? formatAmount(price.amount) : '—'}</Text>
                </Cell>
              ) : null}
            </Row>
          );
        })}
      </View>
      {more ? (
        <Pressable accessibilityRole="button" onPress={() => setShowAll((v) => !v)} hitSlop={8}>
          {({ pressed }) => (
            <Text variant="mono" color="accent" style={[styles.more, pressed && styles.pressed]}>
              {showAll ? strings.catalogShowFewer : strings.catalogShowAll(catalog.listings.length)}
            </Text>
          )}
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  scanned: { borderLeftWidth: 2, paddingLeft: 8 },
  more: { fontWeight: '700', textDecorationLine: 'underline', paddingVertical: 6 },
  pressed: { opacity: 0.6 },
});
