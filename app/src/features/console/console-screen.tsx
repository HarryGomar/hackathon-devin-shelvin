import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ScrollView, StyleSheet, TextInput, useWindowDimensions, View } from 'react-native';

import { apiMode } from '@/api/client';
import { useTheme } from '@/theme';
import { DemoNotice, ErrorBanner, Screen, SegmentedControl, Skeleton, Text } from '@/ui';

import { useActingAs } from './acting-as';
import { Board, ConsoleStrip } from './board';
import { BuildPane } from './build-pane';
import { firstNeedingYou } from './format';
import { Library } from './library';
import { strings } from './strings';
import { useConsoleHistory } from './use-console';

const WIDE = 1100;
const BOARD_WIDTH = 320;

type View_ = 'builds' | 'decisions';

/**
 * The developer console: watch and steer scraper builds. Wide: the strip over BOARD · TRACE · DECISIONS/CHANGES/GATE/
 * INSIGHTS. Narrow: the strip and board; a selected build takes the screen. `?build=<id>` is the selected build.
 */
export function ConsoleScreen() {
  const { spacing } = useTheme();
  const { width } = useWindowDimensions();
  const wide = width >= WIDE;
  const params = useLocalSearchParams<{ build?: string }>();
  const [view, setView] = useState<View_>('builds');
  const { data: history, error, refresh } = useConsoleHistory();
  const builds = history?.builds ?? [];
  const fallback = wide ? (firstNeedingYou(builds) ?? builds[0])?.buildId : undefined;
  const selected = params.build || fallback;

  const select = (id: string | undefined) => {
    setView('builds');
    // '' rather than undefined: the param stays a string on every platform; empty means the board.
    router.setParams({ build: id ?? '' });
    if (id) refresh();
  };

  const top = (
    <View style={{ gap: spacing.sm }}>
      <TopBar view={view} onView={setView} />
      {apiMode === 'mock' ? <DemoNotice label={strings.demo} message={strings.demoMessage} /> : null}
      {error ? <ErrorBanner message={`${strings.loadFailed} ${error}`} onRetry={refresh} /> : null}
    </View>
  );
  const strip = history ? <ConsoleStrip history={history} onSelect={select} /> : <Skeleton height={64} />;
  const board = history ? <Board builds={builds} selected={selected} onSelect={select} /> : <BoardSkeleton />;

  if (view === 'decisions') {
    return (
      <Screen contentStyle={wide ? styles.full : undefined}>
        {top}
        <Library onSelect={select} />
      </Screen>
    );
  }

  if (wide) {
    return (
      <Screen scroll={false} contentStyle={[styles.full, { gap: spacing.md }]}>
        {top}
        {strip}
        <View style={[styles.panes, { gap: spacing.lg }]}>
          <ScrollView style={styles.board} contentContainerStyle={{ paddingBottom: spacing.xl }}>
            {board}
          </ScrollView>
          {selected ? (
            <BuildPane key={selected} id={selected} wide onSelect={select} />
          ) : (
            <Text variant="mono" color="secondary" style={styles.flex}>
              {strings.pick}
            </Text>
          )}
        </View>
      </Screen>
    );
  }

  if (selected) {
    return (
      <Screen scroll={false} contentStyle={{ gap: spacing.sm, paddingBottom: spacing.sm }}>
        <BuildPane key={selected} id={selected} wide={false} onBack={() => select(undefined)} onSelect={select} />
      </Screen>
    );
  }

  return (
    <Screen>
      {top}
      {strip}
      {board}
    </Screen>
  );
}

/** BUILDS · DECISIONS, and who the console acts as. */
function TopBar({ view, onView }: { view: View_; onView: (v: View_) => void }) {
  const { colors, radius, spacing, typography } = useTheme();
  const name = useActingAs((s) => s.name);
  const setName = useActingAs((s) => s.setName);
  return (
    <View style={[styles.row, styles.wrap, { gap: spacing.md }]}>
      <View style={styles.views}>
        <SegmentedControl
          options={[
            { value: 'builds' as View_, label: strings.views.builds },
            { value: 'decisions' as View_, label: strings.views.decisions },
          ]}
          value={view}
          onChange={onView}
        />
      </View>
      <View style={[styles.row, { gap: spacing.sm, marginLeft: 'auto' }]}>
        <Text variant="label" color="secondary">
          {strings.actingAs.toUpperCase()}
        </Text>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder={strings.defaultActor}
          placeholderTextColor={colors.textSecondary}
          selectionColor={colors.accent}
          cursorColor={colors.accent}
          autoCorrect={false}
          accessibilityLabel={strings.actingAs}
          style={[typography.mono, styles.actor, { color: colors.text, borderColor: colors.border, borderRadius: radius.lg, paddingHorizontal: spacing.sm }]}
        />
      </View>
    </View>
  );
}

function BoardSkeleton() {
  const { spacing } = useTheme();
  return (
    <View style={{ gap: spacing.md, paddingTop: spacing.md }}>
      {[0, 1, 2, 3].map((i) => (
        <View key={i} style={{ gap: 6 }}>
          <Skeleton width="55%" height={14} />
          <Skeleton width="80%" height={10} />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  row: { flexDirection: 'row', alignItems: 'center' },
  wrap: { flexWrap: 'wrap' },
  full: { maxWidth: 1800 },
  panes: { flex: 1, minHeight: 0, flexDirection: 'row', alignItems: 'stretch' },
  board: { width: BOARD_WIDTH, flexGrow: 0 },
  views: { width: 240 },
  actor: { minHeight: 36, width: 140, borderWidth: 1 },
});
