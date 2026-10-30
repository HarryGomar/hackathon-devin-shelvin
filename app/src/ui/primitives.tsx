import { HeaderHeightContext } from 'expo-router/react-navigation';
import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import { use, type ReactNode } from 'react';
import { Platform, ScrollView, StyleSheet, Text as RNText, View, type StyleProp, type TextProps, type ViewStyle } from 'react-native';
import Animated from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useTheme, type TypographyVariant } from '@/theme';

import { useEnterAnimation } from './motion';

type ThemedTextProps = TextProps & {
  variant?: TypographyVariant;
  color?: 'text' | 'secondary' | 'accent' | 'success' | 'warning' | 'danger' | 'inverse';
};

/** Themed text. `variant` picks size/weight (and the mono face for numbers and labels), `color` picks a theme color. */
export function Text({ variant = 'body', color = 'text', style, ...rest }: ThemedTextProps) {
  const { colors, typography } = useTheme();
  const colorValue = {
    text: colors.text,
    secondary: colors.textSecondary,
    accent: colors.accent,
    success: colors.success,
    warning: colors.warning,
    danger: colors.danger,
    inverse: colors.primaryText,
  }[color];
  return <RNText style={[typography[variant], { color: colorValue }, style]} {...rest} />;
}

export type IconName = SymbolViewProps['name'];

/** SF Symbol on iOS; on web/Android shows `fallback` text (or nothing). */
export function Icon({ name, size = 20, color, fallback }: { name: IconName; size?: number; color?: string; fallback?: string }) {
  const { colors } = useTheme();
  const tint = color ?? colors.text;
  return (
    <SymbolView
      name={name}
      size={size}
      tintColor={tint}
      fallback={fallback ? <RNText style={{ color: tint, fontSize: size * 0.8, lineHeight: size }}>{fallback}</RNText> : null}
    />
  );
}

interface ScreenProps {
  children: ReactNode;
  /** Scrollable content (default true). */
  scroll?: boolean;
  /** Pinned under the content, e.g. a primary action. */
  footer?: ReactNode;
  /** Extra safe-area edges; the Stack header already covers the top on pushed screens. */
  edges?: ('top' | 'bottom')[];
  contentStyle?: StyleProp<ViewStyle>;
  refreshControl?: React.ComponentProps<typeof ScrollView>['refreshControl'];
}

// iOS 26+ draws the Stack header as see-through glass with the screen extending under it.
const HEADER_OVERLAPS = Platform.OS === 'ios' && parseInt(String(Platform.Version), 10) >= 26;

/** Screen container: paper background, padding, scroll, optional footer under a dashed rule. */
export function Screen({ children, scroll = true, footer, edges = ['bottom'], contentStyle, refreshControl }: ScreenProps) {
  const { colors, spacing } = useTheme();
  const headerHeight = use(HeaderHeightContext) ?? 0;
  const padding = { paddingHorizontal: spacing.lg + 2, paddingTop: spacing.md, paddingBottom: spacing.xl, gap: spacing.lg };
  return (
    <SafeAreaView edges={edges} style={[styles.flex, { backgroundColor: colors.background }]}>
      {scroll ? (
        <ScrollView
          style={styles.flex}
          // Lets iOS inset the content below the header (and still scroll under the glass).
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={[padding, styles.maxWidth, contentStyle]}
          keyboardShouldPersistTaps="handled"
          refreshControl={refreshControl}>
          {children}
        </ScrollView>
      ) : (
        <View style={[styles.flex, padding, HEADER_OVERLAPS && { paddingTop: headerHeight + spacing.md }, styles.maxWidth, contentStyle]}>
          {children}
        </View>
      )}
      {footer ? (
        <View style={{ backgroundColor: colors.background }}>
          <DashedRule />
          <View style={[styles.maxWidth, { paddingHorizontal: spacing.lg + 2, paddingTop: spacing.md, paddingBottom: spacing.md, gap: spacing.sm }]}>{footer}</View>
        </View>
      ) : null}
    </SafeAreaView>
  );
}

/**
 * Dashed (or dotted) one-line rule. iOS can't dash a single border side, so this clips a fully dashed box to its top edge.
 * Section separators use it; table rows use hairline solid rules instead.
 */
export function DashedRule({ color, dotted, style }: { color?: string; dotted?: boolean; style?: StyleProp<ViewStyle> }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.ruleClip, style]} pointerEvents="none">
      <View style={[styles.ruleBox, { borderColor: color ?? colors.textSecondary, borderStyle: dotted ? 'dotted' : 'dashed' }]} />
    </View>
  );
}

/**
 * The receipt slip: the one filled panel in the app (listing detail, overlays). Fades in on mount; still under Reduce Motion.
 */
export function Card({ children, style, muted, enterDelay }: { children: ReactNode; style?: StyleProp<ViewStyle>; muted?: boolean; enterDelay?: number }) {
  const { colors, radius, spacing } = useTheme();
  const entering = useEnterAnimation(enterDelay);
  return (
    <Animated.View
      entering={entering}
      style={[
        {
          backgroundColor: muted ? colors.background : colors.surface,
          borderColor: colors.border,
          borderWidth: muted ? 1 : 0,
          borderRadius: radius.md,
          padding: spacing.lg,
          gap: spacing.sm,
        },
        style,
      ]}>
      {children}
    </Animated.View>
  );
}

/** Caps mono label over a dashed rule, with an optional count or note on the right (e.g. "RECENT SCANS ··· 03"). */
export function SectionHeader({ title, subtitle, right }: { title: string; subtitle?: string; right?: ReactNode }) {
  const { spacing } = useTheme();
  return (
    <View style={{ gap: spacing.xs, marginTop: spacing.sm }}>
      <View style={[styles.sectionHeader, { paddingBottom: 6 }]}>
        <Text variant="label" color="secondary" style={styles.flex} accessibilityRole="header">
          {title.toUpperCase()}
        </Text>
        {typeof right === 'string' ? (
          <Text variant="label" color="secondary">
            {right.toUpperCase()}
          </Text>
        ) : (
          right
        )}
      </View>
      <DashedRule />
      {subtitle ? (
        <Text variant="caption" color="secondary" style={{ marginTop: 2 }}>
          {subtitle}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  maxWidth: { width: '100%', maxWidth: 720, alignSelf: 'center' },
  sectionHeader: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  ruleClip: { height: 1, overflow: 'hidden' },
  ruleBox: { height: 3, borderWidth: 1 },
});
