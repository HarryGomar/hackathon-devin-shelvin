import { router, useLocalSearchParams } from 'expo-router';
import { Pressable, RefreshControl, StyleSheet, View } from 'react-native';

import { apiMode } from '@/api/client';
import type { AgentEvent, BuildDetail, GateAttempt } from '@/api/types';
import { formatDateTime } from '@/features/results/format';
import { openPage } from '@/features/results/open-page';
import { toneColor, useTheme } from '@/theme';
import { Cell, DemoNotice, ErrorBanner, Leader, Row, Screen, SectionHeader, Skeleton, StatusWord, Text } from '@/ui';

import { clockTime, costText, durationText, eventTag, eventTone, isActive, outcomeText, stateWord, verdictWord } from './format';
import { Gates } from './gates';
import { strings } from './strings';
import { useBuild } from './use-builds';

const ATTEMPT_COLUMNS = { n: 28, verdict: 84 };
const TIME_WIDTH = 62;

/** One build's whole recording: header, ATTEMPTS, TRACE (every event, newest at the bottom), GATE. Polls until it ends. */
export function BuildScreen() {
  const { colors } = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data, error, refreshing, refresh } = useBuild(id ?? '');
  return (
    <Screen refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.textSecondary} />}>
      {apiMode === 'mock' ? <DemoNotice label={strings.demoBuilds} message={strings.demoBuildsMessage} /> : null}
      {error ? <ErrorBanner message={`${strings.buildNotFound} ${error}`} onRetry={refresh} /> : null}
      {data ? (
        <>
          <BuildHeader build={data} />
          <Attempts build={data} />
          <Trace events={data.events} />
          <Gates build={data} />
        </>
      ) : error ? null : (
        <BuildSkeleton />
      )}
    </Screen>
  );
}

/** Domain and state, the builder's latest note, receipt lines, and the session and PR links. */
function BuildHeader({ build }: { build: BuildDetail }) {
  const { spacing } = useTheme();
  const cost = costText(build.cost);
  const started = formatDateTime(build.startedAt);
  const ended = formatDateTime(build.endedAt ?? undefined);
  const duration = durationText(build.startedAt, build.endedAt);
  const note = [build.stage, build.note].filter(Boolean).join(' · ');
  return (
    <View style={{ gap: spacing.md }}>
      <View style={{ gap: spacing.xs }}>
        <View style={[styles.titleRow, { gap: spacing.md }]}>
          <Text variant="title" style={styles.flex} accessibilityRole="header">
            {build.domain}
          </Text>
          <View style={styles.titleState}>
            <StatusWord {...stateWord(build.state)} />
          </View>
        </View>
        {note ? (
          <Text variant="mono" color="secondary">
            {note}
          </Text>
        ) : null}
      </View>
      <View>
        <Leader label={strings.provider} value={strings.providers[build.provider] ?? build.provider} />
        {build.source ? <Leader label={strings.source} value={build.source} selectable /> : null}
        <Leader label={strings.kind} value={strings.kinds[build.kind] ?? build.kind} />
        {build.maxAttempts > 0 ? <Leader label={strings.attemptLabel} value={`${build.attempt}/${build.maxAttempts}`} /> : null}
        {cost ? <Leader label={strings.cost} value={cost} /> : null}
        {started ? <Leader label={strings.started} value={started} /> : null}
        {ended ? <Leader label={strings.ended} value={ended} /> : null}
        {duration ? <Leader label={strings.duration} value={duration} /> : null}
        {build.branch ? <Leader label={strings.branch} value={build.branch} selectable /> : null}
      </View>
      <View style={[styles.links, { columnGap: spacing.lg }]}>
        {build.sessionUrl ? <LinkText label={strings.sessionLink(build.provider)} url={build.sessionUrl} /> : null}
        {build.prUrl ? <LinkText label={strings.prLink} url={build.prUrl} /> : null}
        <LinkText label={strings.openConsole} onPress={() => router.push({ pathname: '/console', params: { build: build.buildId } })} />
      </View>
      <Text variant="mono" color="secondary" selectable numberOfLines={3}>
        {build.url}
      </Text>
    </View>
  );
}

function LinkText({ label, url, onPress }: { label: string; url?: string; onPress?: () => void }) {
  return (
    <Pressable accessibilityRole="link" accessibilityLabel={label} accessibilityHint={url} onPress={onPress ?? (() => url && openPage(url))} hitSlop={8}>
      {({ pressed }) => (
        <Text variant="mono" color="accent" style={[styles.link, pressed && styles.pressed]}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}

/** ATTEMPTS: each with what the builder reported, the gate's verdict and count, the failed checks and notes. */
function Attempts({ build }: { build: BuildDetail }) {
  const active = isActive(build.state);
  return (
    <View>
      <SectionHeader title={strings.attemptsTitle} right={build.maxAttempts > 0 ? `${build.attempts.length}/${build.maxAttempts}` : undefined} />
      {build.attempts.length === 0 ? (
        <Text variant="mono" color="secondary" style={styles.empty}>
          {active ? strings.noAttemptsYet : strings.noAttempts}
        </Text>
      ) : (
        build.attempts.map((attempt) => <AttemptRow key={attempt.n} attempt={attempt} active={active} />)
      )}
    </View>
  );
}

function AttemptRow({ attempt, active }: { attempt: GateAttempt; active: boolean }) {
  const when = [clockTime(attempt.startedAt), durationText(attempt.startedAt, attempt.endedAt)].filter(Boolean).join(' · ');
  return (
    <Row>
      <Cell width={ATTEMPT_COLUMNS.n}>
        <Text variant="mono" style={styles.lineText}>
          {strings.attemptNumber(attempt.n)}
        </Text>
      </Cell>
      <Cell>
        <Text variant="subheading">{outcomeText(attempt.outcome)}</Text>
        <Text variant="mono" color="secondary" style={styles.meta}>
          {when}
        </Text>
        {attempt.failed.map((check, i) => (
          <View key={`${check.name}-${i}`} style={styles.meta}>
            <Text variant="mono" color="danger">
              ↳ {check.name}
            </Text>
            {check.detail ? (
              <Text variant="mono" color="secondary" selectable style={styles.detail}>
                {check.detail}
              </Text>
            ) : null}
          </View>
        ))}
        {attempt.notes ? (
          <Text variant="caption" color="secondary" selectable style={styles.meta}>
            {attempt.notes}
          </Text>
        ) : null}
        {attempt.sentBack ? (
          <Text variant="mono" color="warning" style={styles.meta}>
            {strings.sentBack}
          </Text>
        ) : null}
      </Cell>
      <Cell width={ATTEMPT_COLUMNS.verdict} align="right">
        <View style={styles.lineHit}>
          <StatusWord {...verdictWord(attempt, active)} />
        </View>
        {attempt.total > 0 ? (
          <Text variant="mono" style={styles.meta}>
            {`${attempt.passed}/${attempt.total}`}
          </Text>
        ) : null}
      </Cell>
    </Row>
  );
}

/** TRACE: every event, oldest first, so the newest is at the bottom. */
function Trace({ events }: { events: AgentEvent[] }) {
  return (
    <View>
      <SectionHeader title={strings.traceTitle} right={strings.count(events.length)} />
      {events.length === 0 ? (
        <Text variant="mono" color="secondary" style={styles.empty}>
          {strings.noEvents}
        </Text>
      ) : (
        events.map((event, i) => <EventRow key={`${event.at}-${i}`} event={event} />)
      )}
    </View>
  );
}

function EventRow({ event }: { event: AgentEvent }) {
  const { colors } = useTheme();
  return (
    <Row style={styles.compactRow}>
      <Cell width={TIME_WIDTH}>
        <Text variant="mono" color="secondary">
          {clockTime(event.at)}
        </Text>
      </Cell>
      <Cell>
        <Text variant="label" style={[styles.tag, { color: toneColor(colors, eventTone(event)) }]}>
          {eventTag(event)}
        </Text>
        <Text variant="caption" selectable>
          {event.message}
        </Text>
      </Cell>
    </Row>
  );
}

function BuildSkeleton() {
  const { spacing } = useTheme();
  return (
    <View style={{ gap: spacing.md }}>
      <Skeleton width="65%" height={22} />
      <Skeleton width="40%" height={12} />
      {[0, 1, 2, 3].map((i) => (
        <Skeleton key={i} height={12} />
      ))}
      <Skeleton width="35%" height={10} />
      <Skeleton height={40} />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start' },
  titleState: { minHeight: 26, justifyContent: 'center' },
  links: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 8 },
  link: { fontWeight: '700', textDecorationLine: 'underline' },
  pressed: { opacity: 0.6 },
  empty: { paddingVertical: 10 },
  meta: { marginTop: 2 },
  // Lines up under the check name, after "↳ ".
  detail: { marginTop: 2, marginLeft: 16 },
  lineText: { lineHeight: 19 },
  lineHit: { minHeight: 19, justifyContent: 'center' },
  compactRow: { paddingVertical: 7 },
  tag: { marginBottom: 2 },
});
