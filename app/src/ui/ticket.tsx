// Ticket building blocks: tables with hairline rows, caps status words, receipt leader lines, numbered trees, stats strip.
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { toneColor, useTheme, type Tone } from '@/theme';

import { DashedRule, Text } from './primitives';

export interface Column {
  label: string;
  /** Fixed width for number columns, so values line up down the table. Omit for the flexible column. */
  width?: number;
  align?: 'left' | 'right';
}

/** Mono caps column headers over a hairline. */
export function TableHead({ columns }: { columns: Column[] }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.row, styles.head, { borderBottomColor: colors.border }]}>
      {columns.map((c) => (
        <Text
          key={c.label}
          variant="label"
          color="secondary"
          numberOfLines={1}
          style={[c.width ? { width: c.width } : styles.flex, { textAlign: c.align ?? 'left' }]}>
          {c.label.toUpperCase()}
        </Text>
      ))}
    </View>
  );
}

interface RowProps {
  children: ReactNode;
  onPress?: () => void;
  accessibilityLabel?: string;
  /** Rule under the row: hairline (default), or none when a sub-row follows. */
  rule?: 'solid' | 'none';
  style?: StyleProp<ViewStyle>;
}

/** One table row. Pressable rows dim slightly while pressed. */
export function Row({ children, onPress, accessibilityLabel, rule = 'solid', style }: RowProps) {
  const { colors } = useTheme();
  const base = [styles.row, styles.cellRow, rule === 'solid' && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }, style];
  if (!onPress) return <View style={base}>{children}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={({ pressed }) => [base, pressed && { backgroundColor: colors.surface }]}>
      {children}
    </Pressable>
  );
}

/** A cell: flexible by default, fixed `width` for numbers. */
export function Cell({ children, width, align = 'left', style }: { children: ReactNode; width?: number; align?: 'left' | 'right'; style?: StyleProp<ViewStyle> }) {
  return <View style={[width ? { width } : styles.flexShrink, align === 'right' && styles.right, style]}>{children}</View>;
}

/** Group label inside a table: caps mono over a dashed rule (OFFICIAL, RETAILERS · 5, REJECTED · 1). */
export function GroupLabel({ label, right, onPress, expanded }: { label: string; right?: ReactNode; onPress?: () => void; expanded?: boolean }) {
  const content = (
    <>
      <View style={[styles.row, styles.groupRow]}>
        <Text variant="label" color="secondary" style={styles.flex}>
          {label.toUpperCase()}
          {onPress ? (expanded ? '  ▴' : '  ▾') : ''}
        </Text>
        {right}
      </View>
      <DashedRule />
    </>
  );
  if (!onPress) return <View accessibilityRole="header">{content}</View>;
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={onPress} hitSlop={6}>
      {content}
    </Pressable>
  );
}

/** VERIFIED / UNSURE / REJECTED: colored caps mono, no pill. */
export function StatusWord({ label, tone = 'neutral' }: { label: string; tone?: Tone }) {
  const { colors } = useTheme();
  return (
    <Text variant="label" style={[styles.status, { color: toneColor(colors, tone) }]} numberOfLines={1}>
      {label.toUpperCase()}
    </Text>
  );
}

/** Receipt line: LABEL ······ value. Long values drop under the label instead of fighting the leader. */
export function Leader({ label, value, selectable, strong }: { label: string; value: string; selectable?: boolean; strong?: boolean }) {
  const { colors } = useTheme();
  if (value.length > 28) {
    return (
      <View style={styles.leaderLong}>
        <Text variant="mono" color="secondary">
          {label.toUpperCase()}
        </Text>
        <Text variant="caption" selectable={selectable}>
          {value}
        </Text>
      </View>
    );
  }
  return (
    <View style={styles.leader}>
      <Text variant="mono" color="secondary" numberOfLines={1} style={styles.leaderLabel}>
        {label.toUpperCase()}
      </Text>
      <View style={styles.leaderDots}>
        <DashedRule dotted color={colors.textSecondary} style={styles.dots} />
      </View>
      <Text variant="mono" selectable={selectable} style={[styles.leaderValue, strong && styles.bold]}>
        {value}
      </Text>
    </View>
  );
}

/** Category path as numbered levels; the last level is bold. */
export function NumberedTree({ label, path, note }: { label: string; path: string[]; note?: string }) {
  if (path.length === 0) return null;
  return (
    <View style={styles.tree}>
      <Text variant="label" color="secondary" style={styles.treeLabel}>
        {label.toUpperCase()}
      </Text>
      {path.map((part, i) => (
        <View key={`${part}-${i}`} style={styles.treeRow}>
          <Text variant="mono" color="secondary" style={styles.treeNum}>
            {i + 1}
          </Text>
          <Text variant="caption" style={[styles.flex, i === path.length - 1 && styles.bold]}>
            {part}
          </Text>
        </View>
      ))}
      {note ? (
        <Text variant="mono" color="secondary" style={styles.treeNote}>
          {note}
        </Text>
      ) : null}
    </View>
  );
}

export interface StatItem {
  value: number | string;
  label: string;
  tone?: Tone;
  /** A mono line under the label, e.g. "today 3.1 ACU". */
  sub?: string;
  /** Makes the cell a button. */
  onPress?: () => void;
}

/** Counts in a row of equal cells under a strong rule (7 FOUND | 5 VERIFIED | 1 UNSURE | 1 REJECTED). */
export function StatsStrip({ items }: { items: StatItem[] }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.row, { borderTopWidth: 1, borderTopColor: colors.text, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }]}>
      {items.map((item, i) => {
        const cellStyle = [styles.stat, i > 0 && { paddingLeft: 10, borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.border }];
        const content = (
          <>
            <Text variant="stat" style={item.tone && item.value !== 0 ? { color: toneColor(colors, item.tone) } : undefined}>
              {item.value}
            </Text>
            <Text variant="label" color="secondary" numberOfLines={1}>
              {item.label.toUpperCase()}
            </Text>
            {item.sub ? (
              <Text variant="mono" color="secondary" numberOfLines={1}>
                {item.sub}
              </Text>
            ) : null}
          </>
        );
        const label = [`${item.value} ${item.label}`, item.sub].filter(Boolean).join(', ');
        return item.onPress ? (
          <Pressable key={item.label} accessibilityRole="button" accessibilityLabel={label} onPress={item.onPress} style={({ pressed }) => [cellStyle, pressed && { backgroundColor: colors.surface }]}>
            {content}
          </Pressable>
        ) : (
          <View key={item.label} accessible accessibilityLabel={label} style={cellStyle}>
            {content}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  flexShrink: { flex: 1, minWidth: 0 },
  bold: { fontWeight: '700' },
  right: { alignItems: 'flex-end' },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  head: { paddingTop: 8, paddingBottom: 6, borderBottomWidth: StyleSheet.hairlineWidth },
  cellRow: { paddingVertical: 10 },
  groupRow: { paddingTop: 14, paddingBottom: 6, alignItems: 'flex-end' },
  status: { letterSpacing: 0.6 },
  leader: { flexDirection: 'row', alignItems: 'flex-end', gap: 6, minHeight: 24 },
  leaderLabel: { flexShrink: 0, maxWidth: '55%' },
  leaderDots: { flex: 1, minWidth: 12, paddingBottom: 5, opacity: 0.6 },
  dots: {},
  leaderValue: { flexShrink: 1, textAlign: 'right' },
  leaderLong: { gap: 2, paddingVertical: 4 },
  tree: { gap: 2 },
  treeLabel: { marginBottom: 4 },
  treeRow: { flexDirection: 'row', gap: 8, alignItems: 'baseline' },
  treeNum: { width: 14, fontSize: 11 },
  treeNote: { marginTop: 4, fontSize: 11 },
  stat: { flex: 1, paddingVertical: 8, gap: 2 },
});
