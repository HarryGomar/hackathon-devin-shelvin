import { HeaderHeightContext } from 'expo-router/react-navigation';
import { use, useEffect, useRef, useState, type ComponentRef } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { getApi } from '@/api/client';
import type { AgentEvent, BuildControl, BuildDetail, NoteContext } from '@/api/types';
import { clockTime, costText, eventTag, eventTone } from '@/features/builds/format';
import { strings as buildStrings } from '@/features/builds/strings';
import { openPage } from '@/features/results/open-page';
import { toneColor, useTheme } from '@/theme';
import { Button, Cell, ErrorBanner, Row, SegmentedControl, Skeleton, StatusWord, Text } from '@/ui';

import { actorName, useActingAs } from './acting-as';
import { boardWord, contextLabel, controlOf, eventContext, gatePending, quoteText, retryNote, sameContext } from './format';
import { ChangesPane, DecisionsPane, GatePane, InsightsPane } from './side-panes';
import { strings } from './strings';
import { useAction, useConsoleBuild, useInsights } from './use-console';

type SideTab = 'decisions' | 'changes' | 'gate' | 'insights';
type Tab = 'trace' | SideTab;

const SIDE_TABS: SideTab[] = ['decisions', 'changes', 'gate', 'insights'];
const TIME_WIDTH = 62;
const SIDE_WIDTH = 400;

/**
 * One build in the console. Wide: TRACE (header, question, every event, composer) beside DECISIONS · CHANGES · GATE ·
 * INSIGHTS. Narrow: the header, then one of TRACE · DECISIONS · CHANGES · GATE · INSIGHTS, the composer pinned below.
 */
export function BuildPane({ id, wide, onBack, onSelect }: { id: string; wide: boolean; onBack?: () => void; onSelect: (id: string) => void }) {
  const { colors, spacing } = useTheme();
  const [tab, setTab] = useState<Tab>(wide ? 'decisions' : 'trace');
  const sideTab: SideTab = tab === 'trace' ? 'decisions' : tab;
  const [insightsOpened, setInsightsOpened] = useState(false);
  const insights = useInsights(id, insightsOpened);
  const { data: build, error, refresh } = useConsoleBuild(id, insights.data?.status === 'started');
  const [context, setContext] = useState<NoteContext>();
  const [retryMode, setRetryMode] = useState(false);
  const headerHeight = use(HeaderHeightContext) ?? 0;

  const pickTab = (next: Tab) => {
    if (next === 'insights') setInsightsOpened(true);
    setTab(next);
  };

  if (!build) {
    return (
      <View style={[styles.flex, { gap: spacing.md }]}>
        {onBack ? <BackLink onPress={onBack} /> : null}
        {error ? <ErrorBanner message={`${strings.buildFailed} ${error}`} onRetry={refresh} /> : <PaneSkeleton />}
      </View>
    );
  }

  const side = (which: SideTab) =>
    which === 'decisions' ? (
      <DecisionsPane build={build} onChanged={refresh} />
    ) : which === 'changes' ? (
      <ChangesPane build={build} context={context} onContext={setContext} />
    ) : which === 'gate' ? (
      <GatePane build={build} context={context} onContext={setContext} />
    ) : (
      <InsightsPane build={build} insights={insights} />
    );

  const trace = <Trace build={build} context={context} onContext={setContext} />;
  const composer = (
    <Composer
      build={build}
      context={context}
      onClearContext={() => setContext(undefined)}
      retryMode={retryMode}
      onRetryMode={setRetryMode}
      onSent={() => {
        setContext(undefined);
        refresh();
      }}
      onRetried={onSelect}
    />
  );
  const header = <PaneHeader build={build} onRetry={() => setRetryMode(true)} onAction={refresh} onSelect={onSelect} />;
  const sideOptions = SIDE_TABS.map((value) => ({ value, label: strings.tabs[value] }));

  if (wide) {
    return (
      <View style={[styles.flex, styles.panes, { gap: spacing.lg }]}>
        <View style={[styles.flex, { gap: spacing.sm }]}>
          {header}
          {trace}
          {composer}
        </View>
        <View style={[styles.side, { gap: spacing.sm, borderLeftColor: colors.border, paddingLeft: spacing.lg }]}>
          <SegmentedControl options={sideOptions} value={sideTab} onChange={pickTab} />
          <ScrollView style={styles.flex} contentContainerStyle={{ paddingBottom: spacing.xl }} keyboardShouldPersistTaps="handled">
            {side(sideTab)}
          </ScrollView>
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={headerHeight}>
      <View style={[styles.flex, { gap: spacing.sm }]}>
        {onBack ? <BackLink onPress={onBack} /> : null}
        {header}
        <SegmentedControl options={[{ value: 'trace' as Tab, label: strings.tabs.trace }, ...sideOptions]} value={tab} onChange={pickTab} />
        {tab === 'trace' ? (
          trace
        ) : (
          <ScrollView style={styles.flex} contentContainerStyle={{ paddingBottom: spacing.lg }} keyboardShouldPersistTaps="handled">
            {side(tab)}
          </ScrollView>
        )}
        {composer}
      </View>
    </KeyboardAvoidingView>
  );
}

function BackLink({ onPress }: { onPress: () => void }) {
  return (
    <Pressable accessibilityRole="link" onPress={onPress} hitSlop={8} style={styles.back}>
      <Text variant="label" color="accent">
        {strings.back.toUpperCase()}
      </Text>
    </Pressable>
  );
}

/** Domain and state, builder · attempt · cost, links, and Stop / Gate now / Another attempt. */
function PaneHeader({ build, onRetry, onAction, onSelect }: { build: BuildDetail; onRetry: () => void; onAction: () => void; onSelect: (id: string) => void }) {
  const { spacing } = useTheme();
  const actor = useActingAs((s) => s.name);
  const { busy, error, run } = useAction();
  const [hint, setHint] = useState<BuildControl>();
  const [confirmStop, setConfirmStop] = useState(false);
  const meta = [
    buildStrings.providers[build.provider] ?? build.provider,
    build.maxAttempts > 0 ? buildStrings.attempt(build.attempt, build.maxAttempts) : undefined,
    costText(build.cost),
  ]
    .filter(Boolean)
    .join(' · ');
  const hintControl = hint ? controlOf(build, hint) : undefined;

  useEffect(() => {
    if (!confirmStop) return;
    const t = setTimeout(() => setConfirmStop(false), 4000);
    return () => clearTimeout(t);
  }, [confirmStop]);

  const stop = () => {
    if (!confirmStop) return setConfirmStop(true);
    setConfirmStop(false);
    run('stop', () => getApi().stopBuild(build.buildId, actorName(actor))).then(onAction);
  };
  const gate = () => run('gate', () => getApi().gateBuild(build.buildId, actorName(actor))).then(onAction);

  return (
    <View style={{ gap: spacing.xs }}>
      <View style={[styles.row, { gap: spacing.md }]}>
        <Text variant="heading" style={styles.flex} numberOfLines={1} accessibilityRole="header">
          {build.domain}
        </Text>
        <StatusWord {...boardWord(build)} />
      </View>
      <View style={[styles.wrap, { columnGap: spacing.lg }]}>
        <Text variant="mono" color="secondary">
          {meta}
        </Text>
        {build.continues ? <LinkText label={strings.continues(build.continues)} onPress={() => onSelect(build.continues!)} /> : null}
        {build.sessionUrl ? <LinkText label={buildStrings.sessionLink(build.provider)} onPress={() => openPage(build.sessionUrl!)} /> : null}
        {build.prUrl ? <LinkText label={buildStrings.prLink} onPress={() => openPage(build.prUrl!)} /> : null}
      </View>
      <View style={[styles.wrap, { gap: spacing.sm, marginTop: spacing.xs }]}>
        <ControlButton control="stop" build={build} label={confirmStop ? strings.confirmStop : strings.stop} danger busy={busy === 'stop'} onPress={stop} onHint={setHint} />
        <ControlButton control="gate" build={build} label={strings.gateNow} busy={busy === 'gate'} onPress={gate} onHint={setHint} />
        <ControlButton control="retry" build={build} label={strings.retry} onPress={onRetry} onHint={setHint} />
      </View>
      {hintControl && !hintControl.ok ? (
        <Text variant="mono" color="secondary">
          {`${strings.controls[hint!]}: ${hintControl.why}`}
        </Text>
      ) : null}
      {error ? (
        <Text variant="mono" color="danger">
          {error}
        </Text>
      ) : null}
      {build.question ? <QuestionBanner question={build.question} /> : null}
      {gatePending(build.events) ? (
        <View style={[styles.row, { gap: spacing.sm }]}>
          <ActivityIndicator size="small" />
          <Text variant="mono" color="secondary">
            {strings.gateRunning}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function LinkText({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="link" accessibilityLabel={label} onPress={onPress} hitSlop={8}>
      {({ pressed }) => (
        <Text variant="mono" color="accent" style={[styles.link, pressed && styles.pressed]}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}

/**
 * An outlined mono caps button for a build control. When the backend says no, it is muted and pressing (or hovering on
 * web) shows why instead.
 */
function ControlButton({
  control,
  build,
  label,
  danger,
  busy,
  onPress,
  onHint,
}: {
  control: BuildControl;
  build: BuildDetail;
  label: string;
  danger?: boolean;
  busy?: boolean;
  onPress: () => void;
  onHint: (c: BuildControl | undefined) => void;
}) {
  const { colors, radius, spacing } = useTheme();
  const c = controlOf(build, control);
  const fg = !c.ok ? colors.textSecondary : danger ? colors.danger : colors.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={c.ok ? undefined : c.why}
      accessibilityState={{ disabled: !c.ok, busy: !!busy }}
      disabled={busy}
      onPress={() => (c.ok ? onPress() : onHint(control))}
      onHoverIn={() => !c.ok && onHint(control)}
      onHoverOut={() => onHint(undefined)}
      style={({ pressed }) => [
        styles.control,
        { borderColor: c.ok && danger ? colors.danger : colors.border, borderRadius: radius.lg, paddingHorizontal: spacing.md, backgroundColor: pressed ? colors.surface : 'transparent' },
      ]}>
      {busy ? <ActivityIndicator size="small" color={fg} /> : null}
      <Text variant="mono" style={[styles.controlLabel, { color: fg }]} numberOfLines={1}>
        {label.toUpperCase()}
      </Text>
    </Pressable>
  );
}

/** DEVIN IS ASKING: the question between hairlines, no fill. */
function QuestionBanner({ question }: { question: string }) {
  const { colors, spacing } = useTheme();
  return (
    <View accessibilityRole="alert" style={[styles.banner, { borderColor: colors.border, paddingVertical: spacing.sm, gap: spacing.xs, marginTop: spacing.xs }]}>
      <StatusWord label={strings.devinAsking} tone="warning" />
      <Text variant="body" selectable>
        {question}
      </Text>
      <Text variant="mono" color="secondary">
        {strings.answerBelow}
      </Text>
    </View>
  );
}

/** Every event, oldest first; follows the newest. A line sets what the next message is about. */
function Trace({ build, context, onContext }: { build: BuildDetail; context?: NoteContext; onContext: (c: NoteContext) => void }) {
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const seen = useRef(-1);
  const count = build.events.length;
  return (
    <ScrollView
      ref={scroll}
      style={styles.flex}
      keyboardShouldPersistTaps="handled"
      onContentSizeChange={() => {
        if (count !== seen.current) {
          scroll.current?.scrollToEnd({ animated: seen.current >= 0 });
          seen.current = count;
        }
      }}>
      {count === 0 ? (
        <Text variant="mono" color="secondary" style={styles.empty}>
          {strings.noEvents}
        </Text>
      ) : (
        build.events.map((event, i) => <EventLine key={`${event.at}-${i}`} event={event} context={context} onContext={onContext} />)
      )}
    </ScrollView>
  );
}

function EventLine({ event, context, onContext }: { event: AgentEvent; context?: NoteContext; onContext: (c: NoteContext) => void }) {
  const { colors } = useTheme();
  const own = eventContext(event);
  const picked = sameContext(context, own);
  const manual = event.kind === 'gate' && event.gate?.manual;
  const failed = manual ? (event.gate?.checks ?? []).filter((c) => !c.passed) : [];
  return (
    <Row style={styles.compactRow} onPress={() => onContext(own)} accessibilityLabel={`${eventTag(event)}: ${event.message}`}>
      <Cell width={TIME_WIDTH}>
        <Text variant="mono" color={picked ? 'accent' : 'secondary'}>
          {clockTime(event.at)}
        </Text>
      </Cell>
      <Cell>
        <Text variant="label" style={[styles.tag, { color: toneColor(colors, eventTone(event)) }]}>
          {manual ? `${eventTag(event)} · ${strings.manual.toUpperCase()}` : eventTag(event)}
        </Text>
        {event.kind === 'person' && event.context ? (
          <Text variant="mono" color="secondary" style={styles.quote}>
            {quoteText(event.context)}
          </Text>
        ) : null}
        {event.kind === 'decision' && event.decision ? <Text variant="subheading">{event.decision.choice}</Text> : null}
        <Text variant="caption" color={event.kind === 'decision' ? 'secondary' : 'text'}>
          {event.message}
        </Text>
        {failed.map((check) => (
          <Text key={check.name} variant="mono" color="danger" style={styles.meta}>
            {`↳ ${check.name}`}
            <Text variant="mono" color="secondary">{`  ${check.detail}`}</Text>
          </Text>
        ))}
      </Cell>
    </Row>
  );
}

/**
 * Pinned under the trace: what the message is about (removable), the message, and Send to Devin. When the build can't
 * take a message, it says why and offers another attempt with the note instead.
 */
function Composer({
  build,
  context,
  onClearContext,
  retryMode,
  onRetryMode,
  onSent,
  onRetried,
}: {
  build: BuildDetail;
  context?: NoteContext;
  onClearContext: () => void;
  retryMode: boolean;
  onRetryMode: (on: boolean) => void;
  onSent: () => void;
  onRetried: (id: string) => void;
}) {
  const { colors, radius, spacing, typography } = useTheme();
  const actor = useActingAs((s) => s.name);
  const [text, setText] = useState('');
  const [notice, setNotice] = useState<string>();
  const { busy, error, run } = useAction();
  const message = controlOf(build, 'message');
  const retry = controlOf(build, 'retry');
  const mode = retryMode || (!message.ok && retry.ok) ? 'retry' : 'message';
  const allowed = mode === 'retry' ? retry.ok : message.ok;
  const canSend = allowed && !!text.trim() && !busy;

  const send = async () => {
    if (!canSend) return;
    setNotice(undefined);
    const by = actorName(actor);
    if (mode === 'retry') {
      const result = await run('retry', () => getApi().retryBuild(build.buildId, { message: retryNote(text.trim(), context), by }));
      if (!result) return;
      setText('');
      onRetryMode(false);
      onClearContext();
      onRetried(result.buildId);
      return;
    }
    const sent = await run('message', () => getApi().messageBuild(build.buildId, { message: text.trim(), by, ...(context ? { context } : {}) }));
    if (!sent) return;
    setText('');
    setNotice(strings.sent);
    onSent();
  };

  return (
    <View style={[styles.composer, { borderTopColor: colors.border, paddingTop: spacing.sm, gap: spacing.xs }]}>
      {context ? (
        <View style={[styles.row, { gap: spacing.sm }]}>
          <Text variant="label" color="secondary">
            {strings.about.toUpperCase()}
          </Text>
          <Text variant="mono" color="accent" numberOfLines={1} style={styles.flex}>
            {contextLabel(context)}
          </Text>
          <Pressable accessibilityRole="button" accessibilityLabel={strings.removeContext} onPress={onClearContext} hitSlop={10}>
            <Text variant="mono" color="secondary">
              ✕
            </Text>
          </Pressable>
        </View>
      ) : null}
      {!message.ok ? (
        <Text variant="mono" color="secondary">
          {message.why}
        </Text>
      ) : null}
      <TextInput
        value={text}
        onChangeText={setText}
        multiline
        editable={allowed}
        placeholder={mode === 'retry' ? strings.retryPlaceholder : strings.placeholder}
        placeholderTextColor={colors.textSecondary}
        selectionColor={colors.accent}
        cursorColor={colors.accent}
        accessibilityLabel={mode === 'retry' ? strings.retryPlaceholder : strings.placeholder}
        onKeyPress={(e) => {
          const ev = e.nativeEvent as { key: string; metaKey?: boolean; ctrlKey?: boolean };
          if (Platform.OS === 'web' && ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) send();
        }}
        style={[
          typography.caption,
          styles.input,
          { color: colors.text, borderColor: allowed ? colors.text : colors.border, borderRadius: radius.lg, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
        ]}
      />
      <View style={[styles.row, { gap: spacing.sm }]}>
        <Text variant="mono" color={error ? 'danger' : 'secondary'} style={styles.flex} numberOfLines={2}>
          {error ?? notice ?? ''}
        </Text>
        {retryMode && message.ok ? <Button title={strings.cancelRetry} variant="ghost" onPress={() => onRetryMode(false)} /> : null}
        <Button title={mode === 'retry' ? strings.retryWithNote : strings.send} onPress={send} disabled={!canSend} loading={!!busy} />
      </View>
    </View>
  );
}

function PaneSkeleton() {
  const { spacing } = useTheme();
  return (
    <View style={{ gap: spacing.md }}>
      <Skeleton width="50%" height={20} />
      <Skeleton width="35%" height={12} />
      {[0, 1, 2, 3, 4].map((i) => (
        <Skeleton key={i} height={14} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  // minHeight 0: a pane is as tall as the window, and its trace and side lists scroll inside it.
  flex: { flex: 1, minWidth: 0, minHeight: 0 },
  panes: { flexDirection: 'row', alignItems: 'stretch' },
  row: { flexDirection: 'row', alignItems: 'center' },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', rowGap: 6 },
  side: { width: SIDE_WIDTH, borderLeftWidth: StyleSheet.hairlineWidth },
  back: { alignSelf: 'flex-start', paddingVertical: 4 },
  link: { fontWeight: '700', textDecorationLine: 'underline' },
  pressed: { opacity: 0.6 },
  control: { minHeight: 36, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderWidth: 1 },
  controlLabel: { fontWeight: '600', letterSpacing: 0.6 },
  banner: { borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth },
  empty: { paddingVertical: 10 },
  compactRow: { paddingVertical: 7 },
  tag: { marginBottom: 2 },
  quote: { marginBottom: 2 },
  meta: { marginTop: 2 },
  composer: { borderTopWidth: StyleSheet.hairlineWidth },
  input: { minHeight: 44, maxHeight: 140, borderWidth: 1, textAlignVertical: 'top' },
});
