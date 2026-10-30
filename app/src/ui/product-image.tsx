import { Image } from 'expo-image';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useTheme } from '@/theme';

import { Text } from './primitives';

/** Product picture with a hairline frame and 4 pt corners, or a neutral tile with the brand's initials when there's no image or it fails to load (offline, 404). */
export function ProductImage({ uri, label, size = 64 }: { uri?: string; label: string; size?: number }) {
  const { colors, radius } = useTheme();
  // Remembers which uri failed, so a new uri gets a fresh try.
  const [failedUri, setFailedUri] = useState<string>();
  const box = { width: size, height: size, borderRadius: radius.md };
  const initialsVariant = size >= 64 ? 'number' : 'mono';
  if (uri && uri !== failedUri) {
    return (
      <Image
        source={{ uri }}
        style={[box, styles.border, { backgroundColor: colors.surfaceMuted, borderColor: colors.border }]}
        contentFit="cover"
        accessibilityLabel={label}
        onError={() => setFailedUri(uri)}
      />
    );
  }
  const initials = label
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('');
  return (
    <View style={[box, styles.center, styles.border, { backgroundColor: colors.surfaceMuted, borderColor: colors.border }]} accessibilityLabel={label}>
      <Text variant={initialsVariant} color="secondary">
        {initials}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
  border: { borderWidth: StyleSheet.hairlineWidth },
});
