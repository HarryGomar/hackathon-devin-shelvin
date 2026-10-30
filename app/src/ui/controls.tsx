import * as Haptics from 'expo-haptics';
import type { ReactNode } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Switch, View } from 'react-native';

import { useTheme } from '@/theme';

import { Icon, Text, type IconName } from './primitives';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

interface ButtonProps {
  title: string;
  onPress: () => void;
  variant?: ButtonVariant;
  icon?: IconName;
  /** Text shown instead of the icon where SF Symbols aren't available (web/Android). */
  iconFallback?: string;
  loading?: boolean;
  disabled?: boolean;
  size?: 'md' | 'lg';
  /** Light haptic on press (default true for primary). */
  haptic?: boolean;
  /** Primary only: mono line under the title, e.g. "EAN · UPC · QR" or the page's domain. */
  sub?: string;
  /** Primary only: end segment after a hairline, e.g. "4 / 6" or an arrow. */
  end?: string | { icon: IconName; fallback: string };
  /** Primary only: the printed barcode stripe on the left edge, for the screen's one scan action. */
  stripe?: boolean;
}

/**
 * Primary: the ink block (6 pt corners), optional barcode stripe and end segment. Pressed, it darkens a little and
 * the stripe shifts 1 pt. Secondary: a hairline outline with a mono caps label. Ghost: mono caps text only.
 */
export function Button({ title, onPress, variant = 'primary', icon, iconFallback, loading, disabled, size = 'md', haptic, sub, end, stripe }: ButtonProps) {
  const { colors, radius, spacing } = useTheme();
  const isDisabled = disabled || loading;
  const muted = disabled && !loading;

  const handlePress = () => {
    if ((haptic ?? variant === 'primary') && Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    }
    onPress();
  };

  if (variant === 'primary') {
    // Disabled primaries go to an outlined slip instead of see-through ink, so the label stays readable.
    const fg = muted ? colors.textSecondary : colors.primaryText;
    const height = stripe ? 72 : size === 'lg' ? 56 : 46;
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={sub ? `${title}, ${sub}` : title}
        accessibilityState={{ disabled: !!isDisabled, busy: !!loading }}
        disabled={isDisabled}
        onPress={handlePress}
        style={({ pressed }) => [
          styles.block,
          {
            minHeight: height,
            borderRadius: radius.lg,
            backgroundColor: muted ? colors.surface : pressed ? colors.primaryPressed : colors.primary,
            borderColor: muted ? colors.border : 'transparent',
            opacity: loading ? 0.8 : 1,
          },
        ]}>
        {({ pressed }) => (
          <>
            {stripe ? <BarcodeStripe color={fg} shifted={pressed} /> : null}
            <View style={[styles.blockLabel, { paddingHorizontal: spacing.lg }]}>
              <View style={styles.titleRow}>
                {loading ? <ActivityIndicator color={fg} size="small" /> : icon ? <Icon name={icon} color={fg} size={18} fallback={iconFallback} /> : null}
                <Text variant={stripe ? 'heading' : 'subheading'} style={[styles.blockTitle, stripe && styles.stripeTitle, { color: fg }]} numberOfLines={1}>
                  {title}
                </Text>
              </View>
              {sub ? (
                <Text variant="label" numberOfLines={1} style={[styles.sub, { color: fg }]}>
                  {sub.toUpperCase()}
                </Text>
              ) : null}
            </View>
            {end ? (
              <View style={[styles.end, { borderLeftColor: muted ? colors.border : withAlpha(colors.primaryText, 0.2) }]}>
                {typeof end === 'string' ? (
                  <Text variant="mono" style={[styles.endText, { color: fg }]}>
                    {end}
                  </Text>
                ) : (
                  <Icon name={end.icon} size={18} color={fg} fallback={end.fallback} />
                )}
              </View>
            ) : null}
          </>
        )}
      </Pressable>
    );
  }

  const fg = muted ? colors.textSecondary : variant === 'danger' ? colors.danger : variant === 'ghost' ? colors.textSecondary : colors.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled: !!isDisabled, busy: !!loading }}
      disabled={isDisabled}
      onPress={handlePress}
      style={({ pressed }) => [
        styles.outline,
        {
          minHeight: size === 'lg' ? 50 : 44,
          borderRadius: radius.lg,
          borderColor: variant === 'ghost' ? 'transparent' : variant === 'danger' && !muted ? colors.danger : colors.border,
          backgroundColor: pressed ? colors.surface : 'transparent',
          paddingHorizontal: spacing.lg,
        },
      ]}>
      {loading ? <ActivityIndicator color={fg} size="small" /> : icon ? <Icon name={icon} color={fg} size={16} fallback={iconFallback} /> : null}
      <Text variant="mono" style={[styles.outlineLabel, { color: fg }]} numberOfLines={1}>
        {title.toUpperCase()}
      </Text>
    </Pressable>
  );
}

// The design's printed stripe: bars of 2, 1, 3, 1 pt with gaps of 2, 3, 1, 3, repeated across 46 pt.
const STRIPE: [bar: boolean, width: number][] = [
  [true, 2],
  [false, 2],
  [true, 1],
  [false, 3],
  [true, 3],
  [false, 1],
  [true, 1],
  [false, 3],
];
const STRIPE_WIDTH = 46;
const STRIPE_BARS = (() => {
  const bars: { x: number; w: number }[] = [];
  let x = 0;
  while (x < STRIPE_WIDTH) {
    for (const [bar, w] of STRIPE) {
      if (x >= STRIPE_WIDTH) break;
      if (bar) bars.push({ x, w: Math.min(w, STRIPE_WIDTH - x) });
      x += w;
    }
  }
  return bars;
})();

function BarcodeStripe({ color, shifted }: { color: string; shifted: boolean }) {
  return (
    <View pointerEvents="none" style={[styles.stripe, { transform: [{ translateX: shifted ? 1 : 0 }] }]}>
      {STRIPE_BARS.map((b) => (
        <View key={b.x} style={{ position: 'absolute', left: b.x, width: b.w, top: 0, bottom: 0, backgroundColor: color }} />
      ))}
    </View>
  );
}

function withAlpha(hex: string, alpha: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/** Outlined strip of equal cells split by hairlines; holds StripCells. */
export function Strip({ children, accessibilityRole }: { children: ReactNode; accessibilityRole?: 'tablist' }) {
  const { colors, radius } = useTheme();
  return (
    <View accessibilityRole={accessibilityRole} style={[styles.strip, { borderColor: colors.border, borderRadius: radius.lg }]}>
      {children}
    </View>
  );
}

interface StripCellProps {
  label: string;
  onPress: () => void;
  icon?: IconName;
  iconFallback?: string;
  first?: boolean;
  selected?: boolean;
  loading?: boolean;
  disabled?: boolean;
  role?: 'button' | 'tab';
  accessibilityLabel?: string;
  expanded?: boolean;
}

/** One cell of a Strip: icon + mono caps label. Selected cells are inked. */
export function StripCell({ label, onPress, icon, iconFallback, first, selected, loading, disabled, role = 'button', accessibilityLabel, expanded }: StripCellProps) {
  const { colors } = useTheme();
  const fg = selected ? colors.primaryText : disabled ? colors.textSecondary : colors.text;
  return (
    <Pressable
      accessibilityRole={role}
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ selected: role === 'tab' ? selected : undefined, disabled: !!(disabled || loading), busy: !!loading, expanded }}
      disabled={disabled || loading}
      onPress={onPress}
      style={({ pressed }) => [
        styles.cell,
        !first && { borderLeftWidth: 1, borderLeftColor: colors.border },
        { backgroundColor: selected ? colors.primary : pressed ? colors.surface : 'transparent' },
      ]}>
      {loading ? <ActivityIndicator size="small" color={colors.textSecondary} /> : icon ? <Icon name={icon} size={15} color={fg} fallback={iconFallback} /> : null}
      <Text variant="mono" numberOfLines={1} style={[styles.cellLabel, { color: fg }]}>
        {label.toUpperCase()}
      </Text>
    </Pressable>
  );
}

interface SegmentedControlProps<T extends string> {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}

/** Pick one: a Strip whose selected cell is inked. */
export function SegmentedControl<T extends string>({ options, value, onChange }: SegmentedControlProps<T>) {
  return (
    <Strip accessibilityRole="tablist">
      {options.map((o, i) => (
        <StripCell key={o.value} role="tab" first={i === 0} label={o.label} selected={o.value === value} onPress={() => onChange(o.value)} />
      ))}
    </Strip>
  );
}

export function ToggleRow({ label, hint, value, onChange }: { label: string; hint?: string; value: boolean; onChange: (v: boolean) => void }) {
  const { colors } = useTheme();
  return (
    <View style={styles.toggleRow}>
      <View style={styles.flex}>
        <Text variant="subheading">{label}</Text>
        {hint ? (
          <Text variant="caption" color="secondary">
            {hint}
          </Text>
        ) : null}
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ true: colors.accent, false: colors.surfaceRaised }}
        ios_backgroundColor={colors.surfaceRaised}
        accessibilityLabel={label}
      />
    </View>
  );
}

/**
 * Square checkbox for selecting pages: aqua when on, an ink outline when off, a dashed outline when the page
 * can't be selected yet (no scraper).
 */
export function Checkbox({ checked, onChange, label, disabled, unavailable }: { checked: boolean; onChange: () => void; label: string; disabled?: boolean; unavailable?: boolean }) {
  if (unavailable) return <CheckMark checked={false} unavailable />;
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled }}
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onChange}
      hitSlop={12}
      style={{ opacity: disabled ? 0.4 : 1 }}>
      <CheckMark checked={checked} />
    </Pressable>
  );
}

/** The checkbox's square on its own, for rows that are themselves the pressable target. */
export function CheckMark({ checked, unavailable }: { checked: boolean; unavailable?: boolean }) {
  const { colors, radius } = useTheme();
  return (
    <View
      style={[
        styles.checkbox,
        { borderRadius: radius.sm },
        unavailable
          ? { borderStyle: 'dashed', borderColor: colors.textSecondary }
          : { borderColor: checked ? colors.accent : colors.text, backgroundColor: checked ? colors.accent : 'transparent' },
      ]}>
      {checked ? <Icon name="checkmark" size={11} color={colors.accentText} fallback="✓" /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  block: { flexDirection: 'row', alignItems: 'stretch', overflow: 'hidden', borderWidth: 1 },
  blockLabel: { flex: 1, justifyContent: 'center', paddingVertical: 8 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  blockTitle: { fontSize: 16, flexShrink: 1 },
  stripeTitle: { fontSize: 18, letterSpacing: -0.2 },
  sub: { marginTop: 3, opacity: 0.7, letterSpacing: 0.9 },
  end: { justifyContent: 'center', alignItems: 'center', paddingHorizontal: 18, borderLeftWidth: 1 },
  endText: { fontWeight: '600', fontSize: 13 },
  stripe: { width: STRIPE_WIDTH, marginLeft: 16, marginVertical: 14, opacity: 0.9 },
  outline: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderWidth: 1 },
  outlineLabel: { fontWeight: '600', letterSpacing: 0.6 },
  strip: { flexDirection: 'row', borderWidth: 1, overflow: 'hidden' },
  cell: { flex: 1, minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: 4 },
  cellLabel: { fontWeight: '600', letterSpacing: 0.5 },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  checkbox: { width: 18, height: 18, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
});
