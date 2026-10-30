import * as WebBrowser from 'expo-web-browser';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { apiMode } from '@/api/client';
import type { GateAttempt } from '@/api/types';
import type { BuildEntry } from '@/state/session';
import { toneColor, useTheme } from '@/theme';
import { Cell, Leader, Row, StatusWord, Text } from '@/ui';

import {
  attemptVerdict,
  buildEnded,
  buildStateWord,
  buildStepStates,
  costText,
  providerLabel,
  shownBuildStep,
  type StepState,
} from './build-run';
import { strings } from './strings';

/**
 * One scraper build as a Ticket slip: site and status word, the four steps (probe → build → gate → merge), who builds
 * it (Devin / Claude Code / Scripted), the attempt, each attempt's gate verdict with the failed checks, the latest
 * note, and the builder's session and PR links (live backend only; the mock's are made up).
 */
export function BuildPanel({ entry, flat }: { entry: BuildEntry; flat?: boolean }) {
  const { colors, spacing, radius } = useTheme();
  const run = entry.run;
  const ended = buildEnded(run?.state, entry.status);
  const step = shownBuildStep(entry.progress?.step, run, ended);
  const word = buildStateWord(run?.state, entry.status);
  const note = run?.note ?? entry.progress?.message ?? entry.error;
  const cost = costText(run?.cost);

  return (
    <View
      accessibilityLiveRegion="polite"
      style={[
        { gap: spacing.sm },
        !flat && { borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderRadius: radius.lg, padding: spacing.md, backgroundColor: colors.surface },
      ]}>
      <View style={styles.head}>
        <Text variant="label" color="secondary" numberOfLines={1} style={styles.flex}>
          {strings.build.title(entry.domain).toUpperCase()}
        </Text>
        <StatusWord {...word} />
      </View>

      <StepStrip states={buildStepStates(step, ended)} />

      <View>
        <Leader label={strings.build.agent} value={run ? providerLabel(run.provider) + (apiMode === 'mock' ? strings.build.demoSuffix : '') : '—'} strong />
        {run && run.maxAttempts > 0 ? <Leader label={strings.build.attempt} value={`${run.attempt} / ${run.maxAttempts}`} /> : null}
        {run?.source ? <Leader label={strings.build.source} value={run.source} /> : null}
        {cost ? <Leader label={strings.build.cost} value={cost} /> : null}
      </View>

      {run?.attempts.length ? (
        <View>
          {run.attempts.map((a) => (
            <AttemptRow key={a.n} attempt={a} last={a.n === run.attempts[run.attempts.length - 1].n} />
          ))}
        </View>
      ) : null}

      {note ? (
        <Text variant="mono" color={ended === 'failed' ? 'danger' : 'secondary'}>
          ↳ {note}
        </Text>
      ) : null}

      {apiMode === 'live' && (run?.sessionUrl || run?.prUrl) ? (
        <View style={styles.links}>
          {run.sessionUrl ? <LinkText label={strings.build.session(providerLabel(run.provider))} url={run.sessionUrl} /> : null}
          {run.prUrl ? <LinkText label={strings.build.pr} url={run.prUrl} /> : null}
        </View>
      ) : null}
      {!ended && !run ? <ActivityIndicator size="small" color={colors.accent} style={styles.spinner} /> : null}
    </View>
  );
}

const GLYPH: Record<StepState, string> = { done: '✓', current: '●', todo: '○', failed: '×' };

/** PROBE ✓ | BUILD ● | GATE ○ | MERGE ○ in equal mono cells. */
function StepStrip({ states }: { states: { key: keyof typeof strings.buildStepsShort; state: StepState }[] }) {
  const { colors } = useTheme();
  return (
    <View accessibilityRole="progressbar" style={[styles.strip, { borderTopColor: colors.text, borderBottomColor: colors.border }]}>
      {states.map((s, i) => {
        const color =
          s.state === 'done' ? colors.success : s.state === 'current' ? colors.accent : s.state === 'failed' ? colors.danger : colors.textSecondary;
        return (
          <View
            key={s.key}
            accessible
            accessibilityLabel={`${strings.buildSteps[s.key]}: ${s.state}`}
            style={[styles.stripCell, i > 0 && { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.border }]}>
            <Text variant="label" style={{ color }} numberOfLines={1}>
              {GLYPH[s.state]} {strings.buildStepsShort[s.key].toUpperCase()}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

/** "#1  GATE FAIL 12/14  sent back", then "× check — detail" for each failed check. */
function AttemptRow({ attempt, last }: { attempt: GateAttempt; last: boolean }) {
  const { colors } = useTheme();
  const verdict = attemptVerdict(attempt);
  return (
    <View>
      <Row rule={attempt.failed.length ? 'none' : 'solid'} style={styles.attemptRow}>
        <Cell width={28}>
          <Text variant="mono" color="secondary">
            #{attempt.n}
          </Text>
        </Cell>
        <Cell>
          <View style={styles.attemptLine}>
            <StatusWord {...verdict} />
            {!attempt.verdict && !attempt.endedAt && last ? <ActivityIndicator size="small" color={colors.accent} /> : null}
          </View>
        </Cell>
        {attempt.sentBack ? (
          <Cell align="right">
            <Text variant="mono" color="secondary" numberOfLines={1}>
              {strings.build.sentBack}
            </Text>
          </Cell>
        ) : null}
      </Row>
      {attempt.failed.length ? (
        <View style={[styles.failedChecks, { borderBottomColor: colors.border }]}>
          {attempt.failed.map((f) => (
            <Text key={f.name} variant="mono" style={{ color: toneColor(colors, 'danger') }}>
              × {f.name} — <Text variant="mono" color="secondary">{f.detail}</Text>
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function LinkText({ label, url }: { label: string; url: string }) {
  return (
    <Pressable accessibilityRole="link" accessibilityLabel={label} hitSlop={8} onPress={() => WebBrowser.openBrowserAsync(url).catch(() => {})}>
      {({ pressed }) => (
        <Text variant="mono" color="accent" style={[styles.link, pressed && styles.pressed]}>
          {label} ↗
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  strip: { flexDirection: 'row', borderTopWidth: 1, borderBottomWidth: StyleSheet.hairlineWidth },
  stripCell: { flex: 1, paddingVertical: 6, paddingHorizontal: 4, alignItems: 'center' },
  attemptRow: { paddingVertical: 6 },
  attemptLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  failedChecks: { paddingLeft: 38, paddingBottom: 6, gap: 2, borderBottomWidth: StyleSheet.hairlineWidth },
  links: { flexDirection: 'row', flexWrap: 'wrap', gap: 16 },
  link: { fontWeight: '700', textDecorationLine: 'underline' },
  pressed: { opacity: 0.6 },
  spinner: { alignSelf: 'flex-start' },
});
