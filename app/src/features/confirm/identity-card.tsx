import { ActivityIndicator, StyleSheet, View } from 'react-native';

import type { ProductIdentity } from '@/api/types';
import { useTheme } from '@/theme';
import { Leader, ProductImage, Skeleton, StatusWord, Strip, StripCell, Text } from '@/ui';

import { confidenceBadge, productConfidence, splitAlternatives, type Alternative } from './identity';
import { strings } from './strings';

const IMAGE_SIZE = 76;

/**
 * The identified product: photo, brand, name, flavor · size, confidence as a mono %, then every detail as a receipt line.
 * Other sizes of the same product don't lower the %: they show as a size picker instead.
 */
export function IdentityCard({ identity, photoUri, onSelectSize }: { identity: ProductIdentity; photoUri?: string; onSelectSize: (alt: Alternative) => void }) {
  const { spacing } = useTheme();
  const edited = identity.source === 'user_edited';
  // A mock identity is a canned sample, so its confidence means nothing.
  const demo = identity.source === 'mock';
  const confidence = productConfidence(identity);
  const { sizes } = splitAlternatives(identity);
  const badge = edited ? { label: strings.confirmedByYou, tone: 'info' as const } : confidenceBadge(confidence);
  const subtitle = [identity.variant, identity.size].filter(Boolean).join(' · ');
  const details: [string, string | undefined][] = [
    [strings.fields.variant, identity.variant],
    [strings.fields.size, identity.size],
    [strings.fields.barcode, identity.barcode],
    [strings.fields.manufacturer, identity.manufacturer],
  ];

  return (
    <View style={{ gap: spacing.md }}>
      <View style={[styles.header, { gap: spacing.md }]}>
        <View style={[styles.flex, { gap: 3 }]}>
          <Text variant="label" color="secondary">
            {identity.brand.toUpperCase()}
          </Text>
          <Text variant="title" accessibilityRole="header">
            {identity.productName}
          </Text>
          {subtitle ? (
            <Text variant="mono" color="secondary">
              {subtitle}
            </Text>
          ) : null}
        </View>
        <ProductImage uri={identity.imageUrl ?? photoUri} label={identity.productName} size={IMAGE_SIZE} />
      </View>
      {demo ? (
        <View style={styles.confidence} accessible accessibilityLabel={`${strings.demo}, ${strings.demoWord}`}>
          <Text variant="stat" color="warning" style={styles.percent}>
            {strings.demo}
          </Text>
          <StatusWord label={strings.demoWord} tone="warning" />
        </View>
      ) : (
        <View style={styles.confidence} accessible accessibilityLabel={edited ? badge.label : `${badge.label}, ${Math.round(confidence * 100)}%`}>
          {edited ? null : (
            <Text variant="stat" style={styles.percent}>
              {Math.round(confidence * 100)}%
            </Text>
          )}
          <StatusWord label={edited ? badge.label : `${strings.matchLabel} · ${badge.label}`} tone={badge.tone} />
        </View>
      )}
      {!edited && !demo && confidence < 0.8 ? (
        <Text variant="caption" color={confidence < 0.5 ? 'danger' : 'warning'}>
          {strings.lowConfidenceHint}
        </Text>
      ) : !edited && !demo && sizes.length > 0 && identity.confidence < 0.8 ? (
        <Text variant="caption" color="warning">
          {strings.checkSizeHint}
        </Text>
      ) : null}
      {sizes.length > 0 && !demo && identity.size ? (
        <View style={{ gap: spacing.sm }}>
          <Text variant="label" color="secondary">
            {strings.whichSize.toUpperCase()}
          </Text>
          <Strip accessibilityRole="tablist">
            <StripCell role="tab" first selected label={identity.size} onPress={() => {}} />
            {sizes.map((alt) => (
              <StripCell key={alt.size} role="tab" label={alt.size!} onPress={() => onSelectSize(alt)} />
            ))}
          </Strip>
        </View>
      ) : null}
      <View>
        {details.map(([label, value]) => (
          <Leader key={label} label={label} value={value ?? '—'} selectable />
        ))}
      </View>
    </View>
  );
}

/** Placeholder shown while identifying. */
export function IdentitySkeleton() {
  const { colors, spacing } = useTheme();
  return (
    <View style={{ gap: spacing.md }}>
      <View style={[styles.header, { gap: spacing.md }]}>
        <View style={[styles.flex, { gap: spacing.sm }]}>
          <Skeleton width="30%" height={10} />
          <Skeleton width="85%" height={22} />
          <Skeleton width="45%" height={12} />
        </View>
        <Skeleton width={IMAGE_SIZE} height={IMAGE_SIZE} />
      </View>
      <View style={[styles.loadingRow, { gap: spacing.sm }]}>
        <ActivityIndicator size="small" color={colors.accent} />
        <Text variant="mono" color="secondary">
          {strings.identifying}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'flex-start' },
  confidence: { flexDirection: 'row', alignItems: 'baseline', gap: 10 },
  percent: { fontSize: 22 },
  loadingRow: { flexDirection: 'row', alignItems: 'center' },
});
