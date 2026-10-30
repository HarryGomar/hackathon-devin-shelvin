import { StyleSheet, View } from 'react-native';

import type { ScanType } from '@/api/types';
import { useTheme } from '@/theme';
import { SectionHeader, SegmentedControl, Text, ToggleRow } from '@/ui';

import { strings } from './strings';

const SCAN_TYPES: ScanType[] = ['first_party', 'third_party', 'both'];

/** "What to search": first/third party/both as a strip, and a row for including similar products. */
export function SearchOptions({
  scanType,
  includeSimilar,
  onScanTypeChange,
  onIncludeSimilarChange,
}: {
  scanType: ScanType;
  includeSimilar: boolean;
  onScanTypeChange: (value: ScanType) => void;
  onIncludeSimilarChange: (value: boolean) => void;
}) {
  const { colors, spacing } = useTheme();
  return (
    <View>
      <SectionHeader title={strings.whatToSearch} />
      <View style={{ gap: spacing.sm, paddingTop: spacing.md }}>
        <SegmentedControl
          options={SCAN_TYPES.map((value) => ({ value, label: strings.scanTypes[value] }))}
          value={scanType}
          onChange={onScanTypeChange}
        />
        <Text variant="mono" color="secondary">
          {strings.scanTypeHints[scanType]}
        </Text>
      </View>
      <View style={[styles.toggle, { borderColor: colors.border, marginTop: spacing.md }]}>
        <ToggleRow label={strings.similarLabel} hint={strings.similarHint} value={includeSimilar} onChange={onIncludeSimilarChange} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  toggle: { borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, paddingVertical: 12 },
});
