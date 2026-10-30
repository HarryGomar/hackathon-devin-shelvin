import { router, Stack } from 'expo-router';
import { ActivityIndicator, Pressable, RefreshControl, StyleSheet, View } from 'react-native';

import { apiMode } from '@/api/client';
import type { AgentRun, BuildHistory, BuildSite } from '@/api/types';
import { useTheme } from '@/theme';
import { Cell, DemoNotice, EmptyState, ErrorBanner, Row, Screen, SectionHeader, Skeleton, StatsStrip, StatusWord, TableHead, Text } from '@/ui';

import { buildMeta, isActive, stateWord, whenLine } from './format';
import { strings } from './strings';
import { useBuildHistory } from './use-builds';

// Column widths shared by the SITES head and its rows; the state column also ends each build row.
// 38 fits a four-letter head (PASS, FAIL) in the letter-spaced label font; 30 cut them to "PAS…".
const COUNT_WIDTH = 38;
const STATE_WIDTH = 88;

function openBuild(id: string) {
  router.push({ pathname: '/builds/[id]', params: { id } });
}

/** Every scraper build the backend recorded: totals, a tally per site, then the builds newest first. Polls while any runs. */
export function BuildsScreen() {
  const { colors } = useTheme();
  const { data, error, refreshing, refresh } = useBuildHistory();
  return (
    <Screen refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.textSecondary} />}>
      <Stack.Screen options={{ headerRight: () => <ConsoleLink /> }} />
      {apiMode === 'mock' ? <DemoNotice label={strings.demoBuilds} message={strings.demoBuildsMessage} /> : null}
      {error ? <ErrorBanner message={`${strings.loadFailed} ${error}`} onRetry={refresh} /> : null}
      {data ? <History history={data} /> : error ? null : <HistorySkeleton />}
    </Screen>
  );
}

/** CONSOLE in the header: watch and steer the builds. */
function ConsoleLink() {
  return (
    <Pressable accessibilityRole="link" accessibilityLabel={strings.consoleLink} onPress={() => router.push('/console')} hitSlop={8} style={styles.headerLink}>
      {({ pressed }) => (
        <Text variant="label" color="accent" style={pressed && styles.pressed}>
          {strings.consoleLink.toUpperCase()}
        </Text>
      )}
    </Pressable>
  );
}

function History({ history }: { history: BuildHistory }) {
  const { spacing } = useTheme();
  const { totals } = history;
  if (totals.builds === 0 && history.builds.length === 0 && history.sites.length === 0) {
    return <EmptyState icon="hammer" iconFallback="⚒" title={strings.noBuildsTitle} message={strings.noBuildsMessage} />;
  }
  return (
    <>
      <View style={{ gap: spacing.sm }}>
        <StatsStrip
          items={[
            { value: totals.builds, label: strings.stats.builds },
            { value: totals.passed, label: strings.stats.passed, tone: 'success' },
            { value: totals.failed, label: strings.stats.failed, tone: 'danger' },
            { value: totals.refused, label: strings.stats.refused, tone: 'danger' },
            { value: totals.running, label: strings.stats.running, tone: 'accent' },
          ]}
        />
        <Text variant="mono" color="secondary">
          {strings.slots(history.running, history.parallel)}
        </Text>
      </View>
      {history.sites.length > 0 ? <SitesTable sites={history.sites} /> : null}
      <View>
        <SectionHeader title={strings.buildsTitle} right={strings.count(history.builds.length)} />
        {history.builds.map((run) => (
          <BuildRow key={run.buildId} run={run} />
        ))}
      </View>
    </>
  );
}

/** SITES: domain and source | passed | failed | refused | the last build's state. A row opens that last build. */
function SitesTable({ sites }: { sites: BuildSite[] }) {
  return (
    <View>
      <SectionHeader title={strings.sitesTitle} right={strings.count(sites.length)} />
      <TableHead
        columns={[
          { label: strings.siteColumn },
          { label: strings.passedColumn, width: COUNT_WIDTH, align: 'right' },
          { label: strings.failedColumn, width: COUNT_WIDTH, align: 'right' },
          { label: strings.refusedColumn, width: COUNT_WIDTH, align: 'right' },
          { label: strings.lastColumn, width: STATE_WIDTH, align: 'right' },
        ]}
      />
      {sites.map((site) => (
        <SiteRow key={site.domain} site={site} />
      ))}
    </View>
  );
}

function SiteRow({ site }: { site: BuildSite }) {
  const word = stateWord(site.lastState);
  return (
    <Row
      accessibilityLabel={strings.siteA11y(site.domain, site.passed, site.failed, site.refused, word.label)}
      onPress={site.lastBuildId ? () => openBuild(site.lastBuildId!) : undefined}>
      <Cell>
        <Text variant="subheading" numberOfLines={1}>
          {site.domain}
        </Text>
        {site.source ? (
          <Text variant="mono" color="secondary" numberOfLines={1} style={styles.meta}>
            {site.builds === 0 ? strings.builtElsewhere(site.source) : site.source}
          </Text>
        ) : null}
      </Cell>
      <CountCell value={site.passed} color="success" />
      <CountCell value={site.failed} color="danger" />
      <CountCell value={site.refused} color="danger" />
      <Cell width={STATE_WIDTH} align="right">
        <View style={styles.stateHit}>
          <StatusWord {...word} />
        </View>
      </Cell>
    </Row>
  );
}

/** A count in its column: colored when not zero. */
function CountCell({ value, color }: { value: number; color: 'success' | 'danger' }) {
  return (
    <Cell width={COUNT_WIDTH} align="right">
      <Text variant="mono" color={value > 0 ? color : 'secondary'} style={styles.count}>
        {value}
      </Text>
    </Cell>
  );
}

/** One build: domain, "Devin · attempt 2/3 · gate 14/14 · 2.8 ACU", when and how long; its state on the right. */
function BuildRow({ run }: { run: AgentRun }) {
  const { colors } = useTheme();
  const word = stateWord(run.state);
  return (
    <Row accessibilityLabel={`${run.domain}, ${word.label}`} onPress={() => openBuild(run.buildId)}>
      <Cell>
        <Text variant="subheading" numberOfLines={1}>
          {run.domain}
        </Text>
        <Text variant="mono" color="secondary" numberOfLines={2} style={styles.meta}>
          {buildMeta(run)}
        </Text>
        <Text variant="mono" color="secondary" numberOfLines={1}>
          {whenLine(run)}
        </Text>
      </Cell>
      <Cell width={STATE_WIDTH} align="right">
        <View style={[styles.stateHit, styles.stateRow]}>
          {isActive(run.state) ? <ActivityIndicator size="small" color={colors.accent} /> : null}
          <StatusWord {...word} />
        </View>
      </Cell>
    </Row>
  );
}

function HistorySkeleton() {
  const { spacing } = useTheme();
  return (
    <View style={{ gap: spacing.lg }}>
      <Skeleton height={44} />
      {[0, 1, 2].map((i) => (
        <View key={i} style={[styles.skeletonRow, { gap: spacing.md }]}>
          <View style={[styles.flex, { gap: 6 }]}>
            <Skeleton width="55%" height={14} />
            <Skeleton width="75%" height={10} />
          </View>
          <Skeleton width={56} height={12} />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  meta: { marginTop: 2 },
  count: { lineHeight: 19 },
  stateHit: { minHeight: 19, justifyContent: 'center' },
  stateRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  skeletonRow: { flexDirection: 'row', alignItems: 'center' },
  headerLink: { paddingHorizontal: 8, paddingVertical: 6 },
  pressed: { opacity: 0.6 },
});
