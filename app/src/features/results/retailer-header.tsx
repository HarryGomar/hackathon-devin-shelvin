import { StyleSheet, View } from 'react-native';

import type { Listing } from '@/api/types';
import { useSession } from '@/state/session';
import { useTheme } from '@/theme';
import { RetailerLogo, Text } from '@/ui';

import { formatDateTime } from './format';
import { retailerLabel } from './retailer';
import { strings } from './strings';

/** Retailer name and whether it's the brand's site, using the session's page for the listing when there is one. */
export function useRetailerLabel(listing: Pick<Listing, 'pageId' | 'retailerName'>) {
  const sourceType = useSession((s) => s.pages.find((p) => p.id === listing.pageId)?.sourceType);
  return retailerLabel(listing.retailerName, sourceType);
}

/** The receipt's centered header: logo, store name in mono caps, OFFICIAL for the brand's own site, domain, scrape time. */
export function RetailerHeader({ listing }: { listing: Listing }) {
  const { spacing } = useTheme();
  const { name, official } = useRetailerLabel(listing);
  const scraped = formatDateTime(listing.scrapedAt);
  return (
    <View style={[styles.center, { gap: 3 }]}>
      <View style={[styles.nameRow, { gap: spacing.sm }]}>
        <RetailerLogo domain={listing.domain} name={name} size={26} />
        <Text variant="number" style={styles.name} numberOfLines={2} accessibilityRole="header">
          {name.toUpperCase()}
        </Text>
      </View>
      {official ? (
        <Text variant="label" color="secondary">
          {strings.official.toUpperCase()}
        </Text>
      ) : null}
      <Text variant="mono" color="secondary" numberOfLines={1}>
        {listing.domain}
      </Text>
      {scraped ? (
        <Text variant="mono" color="secondary">
          {strings.scrapedAt(scraped)}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center' },
  nameRow: { flexDirection: 'row', alignItems: 'center', maxWidth: '100%' },
  name: { fontWeight: '700', letterSpacing: 1.6, flexShrink: 1, textAlign: 'center' },
});
