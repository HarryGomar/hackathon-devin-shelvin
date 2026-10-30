import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { getApi } from '@/api/client';
import type { BuildDetail, ChangedFile, Decision, DiffLine, NoteContext, SessionInsights } from '@/api/types';
import { isActive } from '@/features/builds/format';
import { CheckRow, Gates } from '@/features/builds/gates';
import { useTheme } from '@/theme';
import { Button, Cell, GroupLabel, Row, StatusWord, Text } from '@/ui';

import { actorName, useActingAs } from './acting-as';
import { checkContext, controlOf, decisionStatus, decisionTone, diffSign, gatePending, insightsLine, latestManualGate, lineContext, sameContext } from './format';
import { strings } from './strings';
import { useAction, useChanges } from './use-console';

const NUM_WIDTH = 34;

/** A quiet "why not" line (the backend said no, or this backend doesn't run the console yet). */
function Quiet({ text }: { text?: string }) {
  if (!text) return null;
  return (
    <Text variant="mono" color="secondary" style={styles.quiet}>
      {text}
    </Text>
  );
}

// ---- DECISIONS ----

/** The build's decisions as they stand, then the ones it started from (from similar builds). */
export function DecisionsPane({ build, onChanged }: { build: BuildDetail; onChanged: () => void }) {
  const decide = controlOf(build, 'decide');
  const decisions = build.decisions ?? [];
  const reused = build.reused ?? [];
  return (
    <View>
      {decisions.length === 0 ? <Quiet text={build.decisions ? strings.decisionsEmpty : decide.why ?? strings.decisionsEmpty} /> : null}
      {!decide.ok && decisions.length > 0 ? <Quiet text={decide.why} /> : null}
      {decisions.map((d) => {
        const from = reused.find((r) => r.topic === d.topic && r.choice === d.choice);
        return <DecisionCardView key={d.topic} buildId={build.buildId} decision={d} from={from?.source ?? undefined} enabled={decide.ok} onChanged={onChanged} />;
      })}
      {reused.length > 0 ? (
        <View>
          <GroupLabel label={strings.startedFrom} />
          {reused.map((d) => (
            <Row key={`${d.buildId}-${d.topic}`} style={styles.compactRow}>
              <Cell>
                <Text variant="label" color="secondary">
                  {d.topic.toUpperCase()}
                </Text>
                <Text variant="mono">{d.choice}</Text>
                <Text variant="mono" color="secondary">
                  {strings.from(d.source ?? d.domain)}
                </Text>
              </Cell>
            </Row>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function DecisionCardView({ buildId, decision, from, enabled, onChanged }: { buildId: string; decision: Decision; from?: string; enabled: boolean; onChanged: () => void }) {
  const { colors, radius, spacing, typography } = useTheme();
  const actor = useActingAs((s) => s.name);
  const [expanded, setExpanded] = useState(false);
  const [picked, setPicked] = useState<string | 'other'>();
  const [other, setOther] = useState('');
  const [why, setWhy] = useState('');
  const [notice, setNotice] = useState<string>();
  const { busy, error, run } = useAction();
  const choice = picked === 'other' ? other.trim() : picked;

  const submit = async (action: 'confirm' | 'change') => {
    const result = await run(action, () =>
      getApi().decideBuild(buildId, { topic: decision.topic, action, ...(action === 'change' ? { choice } : {}), ...(why.trim() ? { why: why.trim() } : {}), by: actorName(actor) }),
    );
    if (!result) return;
    setPicked(undefined);
    setOther('');
    setWhy('');
    setNotice(result.sentToBuilder ? strings.sentToBuilder : undefined);
    onChanged();
  };

  const input = [typography.caption, styles.input, { color: colors.text, borderColor: colors.text, borderRadius: radius.lg, paddingHorizontal: spacing.md }];
  return (
    <View style={[styles.card, { borderBottomColor: colors.border, gap: spacing.xs, paddingVertical: spacing.md }]}>
      <View style={[styles.row, { gap: spacing.sm }]}>
        <Text variant="label" color="secondary" style={styles.flex}>
          {decision.topic.toUpperCase()}
        </Text>
        <StatusWord label={decisionStatus(decision)} tone={decisionTone(decision)} />
      </View>
      <Text variant="subheading" selectable>
        {decision.choice}
      </Text>
      <Pressable onPress={() => setExpanded((e) => !e)} accessibilityRole="button" accessibilityState={{ expanded }}>
        <Text variant="caption" color="secondary" numberOfLines={expanded ? undefined : 2}>
          {decision.why}
        </Text>
      </Pressable>
      {from ? (
        <Text variant="mono" color="secondary">
          {strings.from(from)}
        </Text>
      ) : null}
      <View style={[styles.wrap, { gap: spacing.xs }]}>
        {[...decision.alternatives, 'other'].map((alt) => {
          const on = picked === alt;
          return (
            <Pressable
              key={alt}
              disabled={!enabled}
              accessibilityRole="button"
              accessibilityState={{ selected: on, disabled: !enabled }}
              onPress={() => setPicked(on ? undefined : alt)}
              style={({ pressed }) => [styles.choice, { borderColor: on ? colors.accent : colors.border, borderRadius: radius.sm, backgroundColor: pressed ? colors.surface : 'transparent' }]}>
              <Text variant="mono" color={on ? 'accent' : enabled ? 'text' : 'secondary'}>
                {alt === 'other' ? strings.other : alt}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {picked ? (
        <View style={{ gap: spacing.xs }}>
          {picked === 'other' ? <TextInput value={other} onChangeText={setOther} placeholder={strings.otherPlaceholder} placeholderTextColor={colors.textSecondary} style={input} /> : null}
          <TextInput value={why} onChangeText={setWhy} placeholder={strings.whyPlaceholder} placeholderTextColor={colors.textSecondary} style={input} />
        </View>
      ) : null}
      {enabled ? (
        <View style={[styles.row, { gap: spacing.sm }]}>
          <Text variant="mono" color={error ? 'danger' : 'secondary'} style={styles.flex} numberOfLines={2}>
            {error ?? notice ?? ''}
          </Text>
          {picked ? (
            <Button title={strings.change} variant="secondary" onPress={() => submit('change')} disabled={!choice} loading={busy === 'change'} />
          ) : decision.status !== 'confirmed' ? (
            <Button title={strings.confirm} variant="secondary" onPress={() => submit('confirm')} loading={busy === 'confirm'} />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

// ---- CHANGES ----

/** What the builder changed: files with +/− counts, hunks with old/new line numbers. A line sets the message's context. */
export function ChangesPane({ build, context, onContext }: { build: BuildDetail; context?: NoteContext; onContext: (c: NoteContext) => void }) {
  const control = controlOf(build, 'changes');
  if (!control.ok) return <Quiet text={control.why} />;
  return <Changes build={build} context={context} onContext={onContext} />;
}

function Changes({ build, context, onContext }: { build: BuildDetail; context?: NoteContext; onContext: (c: NoteContext) => void }) {
  const { data, error } = useChanges(build.buildId, isActive(build.state) && build.live !== false);
  if (!data) return error ? <Quiet text={error} /> : <ActivityIndicator style={styles.quiet} />;
  return (
    <View>
      <Quiet text={strings.changesHead(data.head, data.base)} />
      {data.files.length === 0 ? <Quiet text={strings.noChanges} /> : null}
      {data.files.map((file) => (
        <FileDiff key={file.path} file={file} context={context} onContext={onContext} />
      ))}
    </View>
  );
}

function FileDiff({ file, context, onContext }: { file: ChangedFile; context?: NoteContext; onContext: (c: NoteContext) => void }) {
  const [open, setOpen] = useState(true);
  return (
    <View>
      <GroupLabel
        label={file.path}
        onPress={file.truncated ? undefined : () => setOpen((o) => !o)}
        expanded={open}
        right={
          <Text variant="label">
            <Text variant="label" color="success">{`+${file.additions}`}</Text>
            <Text variant="label" color="danger">{` −${file.deletions}`}</Text>
          </Text>
        }
      />
      {file.truncated ? <Quiet text={strings.tooBig} /> : null}
      {open && !file.truncated
        ? file.hunks.map((hunk, h) => (
            <View key={`${hunk.header}-${h}`}>
              <Text variant="mono" color="secondary" style={styles.hunk}>
                {hunk.header}
              </Text>
              {hunk.lines.map((line, i) => (
                <DiffRow key={i} path={file.path} line={line} context={context} onContext={onContext} />
              ))}
            </View>
          ))
        : null}
    </View>
  );
}

function DiffRow({ path, line, context, onContext }: { path: string; line: DiffLine; context?: NoteContext; onContext: (c: NoteContext) => void }) {
  const { colors } = useTheme();
  const own = lineContext(path, line);
  const picked = sameContext(context, own);
  const color = line.kind === 'add' ? 'success' : line.kind === 'del' ? 'danger' : 'text';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${path} line ${own.kind === 'line' ? own.line : ''}`}
      onPress={() => onContext(own)}
      style={({ pressed }) => [styles.diffLine, pressed && { backgroundColor: colors.surface }]}>
      <Text variant="mono" color={picked ? 'accent' : 'secondary'} style={styles.num}>
        {line.old ?? ''}
      </Text>
      <Text variant="mono" color={picked ? 'accent' : 'secondary'} style={styles.num}>
        {line.new ?? ''}
      </Text>
      <Text variant="mono" color={color} style={styles.flex}>
        {`${diffSign(line.kind)} ${line.text}`}
      </Text>
    </Pressable>
  );
}

// ---- GATE ----

/** The latest manual gate's checks, then each attempt's gate report. A failed check sets the message's context. */
export function GatePane({ build, context, onContext }: { build: BuildDetail; context?: NoteContext; onContext: (c: NoteContext) => void }) {
  const manual = latestManualGate(build.events);
  const pick = (check: Parameters<typeof checkContext>[0]) => onContext(checkContext(check));
  const pickedName = context?.kind === 'check' ? context.name : undefined;
  return (
    <View>
      {gatePending(build.events) ? <Quiet text={strings.gateRunning} /> : null}
      {manual?.gate ? (
        <View>
          <GroupLabel label={`${strings.latestManual(manual.by)} · ${manual.gate.verdict} · ${manual.gate.passed}/${manual.gate.total}`} />
          {(manual.gate.checks ?? []).map((check) => (
            <CheckRow key={check.name} check={pickedName === check.name ? { ...check, name: `▸ ${check.name}` } : check} onPress={() => pick(check)} />
          ))}
        </View>
      ) : null}
      <Gates build={build} title={false} onCheckPress={pick} />
      {!manual && build.attempts.length === 0 ? <Quiet text={buildNoGate} /> : null}
    </View>
  );
}

const buildNoGate = 'No gate run yet.';

// ---- INSIGHTS ----

export function InsightsPane({ build, insights }: { build: BuildDetail; insights: { data?: SessionInsights | null; error?: string; refresh: () => void } }) {
  const control = controlOf(build, 'insights');
  const { busy, error, run } = useAction();
  const actor = useActingAs((s) => s.name);
  if (!control.ok) return <Quiet text={control.why} />;
  const data = insights.data;
  const generate = () => run('generate', () => getApi().generateBuildInsights(build.buildId, actorName(actor))).then(insights.refresh);
  if (!data) return insights.error ? <Quiet text={insights.error} /> : <ActivityIndicator style={styles.quiet} />;
  if (data.status === null || data.status === 'failed') {
    return (
      <View style={styles.generate}>
        {data.status === 'failed' ? <Quiet text={strings.insightsFailed} /> : null}
        <Button title={strings.generate} variant="secondary" onPress={generate} loading={busy === 'generate'} />
        <Quiet text={error} />
      </View>
    );
  }
  if (data.status === 'started') {
    return (
      <View style={[styles.row, styles.quiet, { gap: 8 }]}>
        <ActivityIndicator size="small" />
        <Text variant="mono" color="secondary">
          {strings.analysing}
        </Text>
      </View>
    );
  }
  return <Insights insights={data} />;
}

function Insights({ insights }: { insights: SessionInsights }) {
  const { spacing } = useTheme();
  const line = insightsLine(insights);
  return (
    <View>
      <Quiet text={line} />
      {insights.issues.length ? <GroupLabel label={`${strings.issues} · ${insights.issues.length}`} /> : null}
      {insights.issues.map((issue, i) => (
        <Row key={i} style={styles.compactRow}>
          <Cell>
            <Text variant="label" color="warning">
              {issue.label.toUpperCase()}
            </Text>
            <Text variant="subheading">{issue.title}</Text>
            <Text variant="caption">{issue.issue}</Text>
            <Text variant="mono" color="secondary">
              {issue.impact}
            </Text>
          </Cell>
        </Row>
      ))}
      {insights.actionItems.length ? <GroupLabel label={strings.actionItems} /> : null}
      {insights.actionItems.map((item, i) => (
        <Row key={i} style={styles.compactRow}>
          <Cell>
            <Text variant="label" color="secondary">
              {item.type.toUpperCase()}
            </Text>
            <Text variant="caption">{item.item}</Text>
          </Cell>
        </Row>
      ))}
      {insights.skillUsage.good.length + insights.skillUsage.bad.length ? <GroupLabel label={strings.skillUsage} /> : null}
      {[...insights.skillUsage.good.map((s) => ({ ...s, good: true })), ...insights.skillUsage.bad.map((s) => ({ ...s, good: false }))].map((s, i) => (
        <Row key={i} style={styles.compactRow}>
          <Cell width={44}>
            <StatusWord label={s.good ? strings.good : strings.bad} tone={s.good ? 'success' : 'danger'} />
          </Cell>
          <Cell>
            <Text variant="mono">{s.skill}</Text>
            <Text variant="caption" color="secondary">
              {s.reason}
            </Text>
          </Cell>
        </Row>
      ))}
      {insights.suggestedPrompt ? (
        <View style={{ gap: spacing.xs }}>
          <GroupLabel label={strings.suggestedPrompt} />
          <Text variant="label" color="secondary">
            {strings.original.toUpperCase()}
          </Text>
          <Text variant="mono" color="secondary" selectable>
            {insights.suggestedPrompt.original}
          </Text>
          <Text variant="label" color="secondary" style={styles.meta}>
            {strings.suggested.toUpperCase()}
          </Text>
          <Text variant="mono" selectable>
            {insights.suggestedPrompt.suggested}
          </Text>
          {insights.suggestedPrompt.feedback.map((f, i) => (
            <Text key={i} variant="caption" color="secondary">
              {`${f.summary}: ${f.details}`}
            </Text>
          ))}
        </View>
      ) : null}
      {insights.timeline.length ? <GroupLabel label={strings.timeline} /> : null}
      {insights.timeline.map((t, i) => (
        <Row key={i} style={styles.compactRow}>
          <Cell width={24}>
            <Text variant="mono" color="secondary">
              {String(i + 1).padStart(2, '0')}
            </Text>
          </Cell>
          <Cell>
            <Text variant="subheading">{t.title}</Text>
            <Text variant="caption" color="secondary">
              {t.description}
            </Text>
          </Cell>
        </Row>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  row: { flexDirection: 'row', alignItems: 'center' },
  wrap: { flexDirection: 'row', flexWrap: 'wrap' },
  quiet: { paddingVertical: 10 },
  compactRow: { paddingVertical: 7 },
  meta: { marginTop: 6 },
  card: { borderBottomWidth: StyleSheet.hairlineWidth },
  choice: { borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 8, paddingVertical: 4 },
  input: { minHeight: 40, borderWidth: 1 },
  hunk: { paddingTop: 8, paddingBottom: 4 },
  diffLine: { flexDirection: 'row', gap: 6, paddingVertical: 1 },
  num: { width: NUM_WIDTH, textAlign: 'right' },
  generate: { gap: 8, paddingVertical: 10, alignItems: 'flex-start' },
});
