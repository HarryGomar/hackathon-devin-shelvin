import { Image } from 'expo-image';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { monoFamily, useTheme } from '@/theme';

import { Text } from './primitives';
import { monogram, monogramColors, retailerIconUrl } from './retailer-logo-source';

/**
 * Retailer's site icon in a rounded tile, for known Mexican retailers only (see KNOWN_RETAILER_DOMAINS).
 * Brand sites and unknown shops, and any icon that is loading, fails or is offline, show a monogram of `name` instead.
 * Sizes: ~18–20 in table rows, ~28 on the receipt header.
 */
export function RetailerLogo({ domain, name, size = 28 }: { domain: string; name: string; size?: number }) {
  const { colors, dark } = useTheme();
  // Keyed by domain, so a recycled row never shows the previous retailer's state.
  const [status, setStatus] = useState<{ domain: string; value: 'loaded' | 'failed' }>();
  const current = status?.domain === domain ? status.value : 'loading';
  const iconUrl = retailerIconUrl(domain);
  const tint = monogramColors(domain, dark);
  const tile = { width: size, height: size, borderRadius: Math.max(3, Math.round(size * 0.16)) };
  const loaded = current === 'loaded';
  const inset = Math.round(size * 0.14);

  return (
    <View
      accessibilityLabel={name}
      style={[tile, styles.tile, { backgroundColor: loaded ? '#FFFFFF' : tint.bg, borderColor: colors.border }]}>
      {!loaded ? (
        <Text style={{ color: tint.fg, fontSize: Math.round(size * 0.4), lineHeight: Math.round(size * 0.48), fontWeight: '700', fontFamily: monoFamily }}>
          {monogram(name) || '•'}
        </Text>
      ) : null}
      {iconUrl && current !== 'failed' ? (
        <Image
          source={{ uri: iconUrl }}
          cachePolicy="memory-disk"
          recyclingKey={domain}
          contentFit="contain"
          onLoad={() => setStatus({ domain, value: 'loaded' })}
          onError={() => setStatus({ domain, value: 'failed' })}
          style={[styles.icon, { top: inset, left: inset, right: inset, bottom: inset, opacity: loaded ? 1 : 0 }]}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  tile: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth },
  icon: { position: 'absolute' },
});
