import { StyleSheet, View } from 'react-native';

import type { ScanInput } from '@/api/types';
import { useTheme } from '@/theme';
import { Icon, ProductImage, Text } from '@/ui';

import { strings } from './strings';

/** What the user scanned, as one mono line: SCANNED BARCODE ··· 7500000000017, or the photo thumbnail. */
export function InputSummary({ input }: { input: ScanInput }) {
  const { colors, spacing } = useTheme();
  const isPhoto = input.kind === 'photo';
  const label = isPhoto ? strings.yourPhoto : input.kind === 'barcode' ? strings.scannedBarcode : strings.typedBarcode;
  return (
    <View style={[styles.row, { gap: spacing.md, borderBottomColor: colors.border }]}>
      {isPhoto ? <ProductImage uri={input.uri} label={strings.yourPhoto} size={36} /> : <Icon name="barcode" size={20} color={colors.textSecondary} fallback="▥" />}
      <Text variant="label" color="secondary" style={styles.flex}>
        {label.toUpperCase()}
      </Text>
      {isPhoto ? null : (
        <Text variant="number" selectable style={styles.digits}>
          {input.code}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 40, paddingBottom: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  digits: { letterSpacing: 1 },
});
