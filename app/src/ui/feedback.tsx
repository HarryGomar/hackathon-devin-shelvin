import { ActivityIndicator, StyleSheet, View, type DimensionValue } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';

import { useTheme } from '@/theme';

import { Button } from './controls';
import { useFadeIn, usePulse } from './motion';
import { Icon, Text, type IconName } from './primitives';

export interface ProgressStep {
  key: string;
  label: string;
}

/**
 * Job steps as a numbered table under a strong rule. Steps before `currentKey` are ticked, `currentKey` spins in aqua.
 * Pass `done` to mark everything complete.
 */
export function ProgressSteps({ steps, currentKey, message, done, onDark }: { steps: ProgressStep[]; currentKey?: string; message?: string; done?: boolean; onDark?: boolean }) {
  const { colors } = useTheme();
  const currentIndex = done ? steps.length : Math.max(0, steps.findIndex((s) => s.key === currentKey));
  return (
    <View accessibilityRole="progressbar" style={[styles.steps, { borderTopColor: colors.text }]}>
      {steps.map((step, i) => {
        const state = i < currentIndex ? 'done' : i === currentIndex ? 'current' : 'todo';
        return (
          <View key={step.key} style={[styles.stepRow, { borderBottomColor: colors.border }]}>
            <Text variant="mono" color="secondary" style={styles.stepNum}>
              {String(i + 1).padStart(2, '0')}
            </Text>
            <Text variant="body" color={state === 'todo' ? 'secondary' : 'text'} style={[styles.flex, state === 'current' && styles.bold]}>
              {step.label}
            </Text>
            <StepState key={state} state={state} />
          </View>
        );
      })}
      {message && !done ? (
        <Text variant="mono" color="secondary" style={[styles.stepMessage, onDark && { color: colors.text }]}>
          {message}
        </Text>
      ) : null}
    </View>
  );
}

function StepState({ state }: { state: 'done' | 'current' | 'todo' }) {
  const { colors } = useTheme();
  const entering = useFadeIn();
  return (
    <Animated.View entering={entering} style={styles.stepState}>
      {state === 'done' ? (
        <Text variant="label" color="success">
          DONE
        </Text>
      ) : state === 'current' ? (
        <ActivityIndicator size="small" color={colors.accent} />
      ) : (
        <Text variant="label" color="secondary">
          —
        </Text>
      )}
    </Animated.View>
  );
}

export function EmptyState({ icon, iconFallback, title, message, action }: { icon?: IconName; iconFallback?: string; title: string; message?: string; action?: { title: string; onPress: () => void } }) {
  const { colors, radius, spacing } = useTheme();
  return (
    <View style={[styles.empty, { gap: spacing.sm, paddingVertical: spacing.xl }]}>
      {icon ? (
        <View style={[styles.emptyIcon, { borderColor: colors.border, borderRadius: radius.md }]}>
          <Icon name={icon} size={22} color={colors.textSecondary} fallback={iconFallback} />
        </View>
      ) : null}
      <Text variant="heading" style={styles.center}>
        {title}
      </Text>
      {message ? (
        <Text variant="caption" color="secondary" style={[styles.center, styles.message]}>
          {message}
        </Text>
      ) : null}
      {action ? (
        <View style={{ marginTop: spacing.sm }}>
          <Button title={action.title} onPress={action.onPress} variant="secondary" />
        </View>
      ) : null}
    </View>
  );
}

/** Error line with a red rule on its left, and an outlined retry. */
export function ErrorBanner({ message, onRetry, retryLabel = 'Try again' }: { message: string; onRetry?: () => void; retryLabel?: string }) {
  const { colors, spacing } = useTheme();
  return (
    <View accessibilityRole="alert" style={[styles.banner, { borderLeftColor: colors.danger, gap: spacing.sm }]}>
      <Text variant="label" color="danger">
        ERROR
      </Text>
      <Text variant="body" color="danger">
        {message}
      </Text>
      {onRetry ? (
        <View style={styles.retry}>
          <Button title={retryLabel} onPress={onRetry} variant="danger" />
        </View>
      ) : null}
    </View>
  );
}

/** Mono status line with a colored rule on its left, e.g. "SAVED ✓ 3 LISTINGS · 14:05". */
export function SuccessBanner({ message, tone = 'success' }: { message: string; tone?: 'success' | 'warning' }) {
  const { colors } = useTheme();
  const fg = tone === 'success' ? colors.success : colors.warning;
  return (
    <View accessibilityRole="summary" style={[styles.banner, { borderLeftColor: fg }]}>
      <Text variant="mono" style={[styles.bannerText, { color: fg }]}>
        {message.toUpperCase()}
      </Text>
    </View>
  );
}

/** Softly pulsing placeholder bar while content loads (static under Reduce Motion). */
export function Skeleton({ width = '100%', height = 16 }: { width?: DimensionValue; height?: number }) {
  const { colors, radius } = useTheme();
  const progress = usePulse(900);
  const pulseStyle = useAnimatedStyle(() => ({ opacity: 0.5 + progress.get() * 0.5 }));
  return <Animated.View style={[{ width, height, borderRadius: radius.sm, backgroundColor: colors.surfaceRaised }, pulseStyle]} />;
}

/** Data-mode status in mono (e.g. DEMO DATA, LIVE ID · LIVE SEARCH · DEMO SCRAPERS), with an amber square while anything is demo. */
export function ModeBadge({ label, demo, accessibilityLabel }: { label: string; demo: boolean; accessibilityLabel?: string }) {
  const { colors } = useTheme();
  return (
    <View style={styles.mode} accessible accessibilityLabel={accessibilityLabel ?? label}>
      <View style={[styles.modeDot, { backgroundColor: demo ? colors.warning : colors.success }]} />
      <Text variant="label" color={demo ? 'warning' : 'secondary'} numberOfLines={2} style={styles.modeText}>
        {label}
      </Text>
    </View>
  );
}

/**
 * Amber-ruled strip that says the content is demo data, so a sample result is never mistaken for a real one:
 * a caps label (DEMO RESULT, DEMO PAGES, DEMO LISTINGS) and one sentence.
 */
export function DemoNotice({ label, message }: { label: string; message?: string }) {
  const { colors } = useTheme();
  return (
    <View accessible accessibilityRole="alert" accessibilityLabel={message ? `${label}. ${message}` : label} style={[styles.banner, styles.demo, { borderLeftColor: colors.warning }]}>
      <View style={styles.demoLabel}>
        <View style={[styles.modeDot, { backgroundColor: colors.warning }]} />
        <Text variant="label" color="warning">
          {label.toUpperCase()}
        </Text>
      </View>
      {message ? (
        <Text variant="caption" color="secondary">
          {message}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  bold: { fontWeight: '600' },
  center: { textAlign: 'center' },
  message: { maxWidth: 300 },
  steps: { borderTopWidth: 1 },
  stepRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44, borderBottomWidth: StyleSheet.hairlineWidth },
  stepNum: { width: 20 },
  stepState: { minWidth: 36, alignItems: 'flex-end' },
  stepMessage: { paddingTop: 8 },
  empty: { alignItems: 'center', justifyContent: 'center' },
  emptyIcon: { width: 48, height: 48, borderWidth: 1, alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  banner: { borderLeftWidth: 2, paddingLeft: 12, paddingVertical: 4 },
  bannerText: { fontWeight: '600', letterSpacing: 0.4 },
  retry: { alignSelf: 'flex-start' },
  mode: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 },
  modeDot: { width: 6, height: 6 },
  modeText: { flexShrink: 1, textAlign: 'right' },
  demo: { gap: 3 },
  demoLabel: { flexDirection: 'row', alignItems: 'center', gap: 6 },
});
