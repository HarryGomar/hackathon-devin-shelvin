import { StyleSheet, View } from 'react-native';

import type { ProductIdentity } from '@/api/types';
import { useTheme } from '@/theme';
import { ProductImage, Text } from '@/ui';

import { strings } from './strings';

/** Product name over a mono meta line (brand · variant · size · EAN), with its photo on the right when there is one. */
export function ProductHeader({ product, note }: { product: ProductIdentity; note?: string }) {
  const { spacing } = useTheme();
  const meta = [product.brand, product.variant, product.size, product.barcode ? strings.ean(product.barcode) : undefined].filter(Boolean).join(' · ');
  return (
    <View style={[styles.row, { gap: spacing.md }]}>
      <View style={[styles.flex, { gap: 3 }]}>
        <Text variant="title" accessibilityRole="header">
          {product.productName}
        </Text>
        {meta ? (
          <Text variant="mono" color="secondary">
            {meta}
          </Text>
        ) : null}
        {note ? (
          <Text variant="mono" color="secondary">
            {note}
          </Text>
        ) : null}
      </View>
      {product.imageUrl ? <ProductImage uri={product.imageUrl} label={product.productName} size={52} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'flex-start' },
});
