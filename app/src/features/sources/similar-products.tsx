import { StyleSheet, View } from 'react-native';

import type { ProductIdentity, SimilarProduct } from '@/api/types';
import { useTheme } from '@/theme';
import { Cell, Icon, Row, StatusWord, Text } from '@/ui';

import { strings } from './strings';

/** The identity to confirm when a similar product is picked, built from the card itself (never from fixtures). */
export function identityForSimilar(s: SimilarProduct): ProductIdentity {
  return {
    id: s.id,
    brand: s.brand,
    productName: s.productName,
    variant: s.variant,
    imageUrl: s.imageUrl,
    confidence: 1,
    source: 'user_edited',
  };
}

/** Similar products as table rows (name, SAME BRAND / COMPETITOR, reason); tapping one starts over from Confirm with it. */
export function SimilarProductRows({ products, onPick }: { products: SimilarProduct[]; onPick: (s: SimilarProduct) => void }) {
  const { colors } = useTheme();
  return (
    <View>
      {products.map((s) => (
        <Row key={s.id} accessibilityLabel={`${s.productName}, ${s.reason}`} onPress={() => onPick(s)}>
          <Cell>
            <Text variant="subheading" numberOfLines={2}>
              {s.productName}
            </Text>
            <Text variant="mono" color="secondary" numberOfLines={2} style={styles.sub}>
              {s.reason}
            </Text>
          </Cell>
          <View style={styles.relation}>
            <StatusWord label={s.relation === 'same_brand' ? strings.sameBrand : strings.competitor} tone="neutral" />
          </View>
          <View style={styles.chevron}>
            <Icon name="chevron.right" size={12} color={colors.textSecondary} fallback="›" />
          </View>
        </Row>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  sub: { marginTop: 2 },
  relation: { paddingTop: 3 },
  chevron: { paddingTop: 3 },
});
