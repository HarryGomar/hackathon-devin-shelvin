import { ActivityIndicator, StyleSheet, View } from 'react-native';

import type { BuildStats, DecisionLibrary } from '@/api/types';
import { stateWord } from '@/features/builds/format';
import { useTheme } from '@/theme';
import { Cell, GroupLabel, Row, StatusWord, TableHead, Text } from '@/ui';

import { strings } from './strings';
import { useDecisionLibrary } from './use-console';

const COL = 72;

/** DECISIONS: what the next build with each reader starts from, and fresh vs reused builds per reader. */
export function Library({ onSelect }: { onSelect: (buildId: string) => void }) {
  const { data, error } = useDecisionLibrary();
  if (!data) {
    return error ? (
      <Text variant="mono" color="secondary" style={styles.quiet}>
        {error}
      </Text>
    ) : (
      <ActivityIndicator style={styles.quiet} />
    );
  }
  const readers = [...new Set([...data.performance.map((p) => p.reader), ...data.decisions.map((d) => d.reader ?? '')])].filter(Boolean);
  if (readers.length === 0) {
    return (
      <Text variant="mono" color="secondary" style={styles.quiet}>
        {strings.libraryEmpty}
      </Text>
    );
  }
  return (
    <View>
      <Text variant="caption" color="secondary">
        {strings.libraryIntro}
      </Text>
      {readers.map((reader) => (
        <ReaderSection key={reader} reader={reader} library={data} onSelect={onSelect} />
      ))}
    </View>
  );
}

function ReaderSection({ reader, library, onSelect }: { reader: string; library: DecisionLibrary; onSelect: (id: string) => void }) {
  const { spacing } = useTheme();
  const perf = library.performance.find((p) => p.reader === reader);
  const decisions = library.decisions.filter((d) => d.reader === reader);
  return (
    <View style={{ marginBottom: spacing.md }}>
      <GroupLabel label={reader} />
      {perf ? (
        <View style={{ marginBottom: spacing.sm }}>
          <TableHead columns={[{ label: '' }, { label: strings.fresh, width: COL, align: 'right' }, { label: strings.reusedCol, width: COL, align: 'right' }]} />
          <PerfRow label={strings.perf.builds} fresh={perf.fresh} reused={perf.reused} pick={(s) => s.builds} />
          <PerfRow label={strings.perf.passed} fresh={perf.fresh} reused={perf.reused} pick={(s) => s.passed} />
          <PerfRow label={strings.perf.firstTry} fresh={perf.fresh} reused={perf.reused} pick={(s) => s.firstTry} />
          <PerfRow label={strings.perf.attempts} fresh={perf.fresh} reused={perf.reused} pick={(s) => s.avgAttempts} lowerBetter />
          <PerfRow label={strings.perf.acus} fresh={perf.fresh} reused={perf.reused} pick={(s) => s.avgAcus} lowerBetter />
          <PerfRow label={strings.perf.minutes} fresh={perf.fresh} reused={perf.reused} pick={(s) => s.avgMinutes} lowerBetter />
        </View>
      ) : null}
      {decisions.map((d) => {
        const word = d.outcome ? stateWord(d.outcome) : undefined;
        return (
          <Row key={`${d.topic}-${d.buildId}`} onPress={() => onSelect(d.buildId)} accessibilityLabel={`${d.topic}: ${d.choice}, from ${d.domain}`}>
            <Cell>
              <Text variant="label" color="secondary">
                {d.topic.toUpperCase()}
              </Text>
              <Text variant="subheading">{d.choice}</Text>
              <Text variant="mono" color="secondary" numberOfLines={1}>
                {[strings.uses(d.uses), strings.from(d.source ?? d.domain)].join(' · ')}
              </Text>
            </Cell>
            {word ? (
              <Cell width={COL} align="right">
                <StatusWord {...word} />
              </Cell>
            ) : null}
          </Row>
        );
      })}
    </View>
  );
}

/** One stat, fresh vs reused; the better value in success text when the two differ. */
function PerfRow({ label, fresh, reused, pick, lowerBetter }: { label: string; fresh: BuildStats; reused: BuildStats; pick: (s: BuildStats) => number | null; lowerBetter?: boolean }) {
  const a = pick(fresh);
  const b = pick(reused);
  const better = a !== null && b !== null && a !== b && reused.builds > 0 && fresh.builds > 0 ? ((lowerBetter ? b < a : b > a) ? 'reused' : 'fresh') : undefined;
  const show = (v: number | null) => (v === null ? strings.dash : String(Math.round(v * 10) / 10));
  return (
    <Row style={styles.compactRow}>
      <Cell>
        <Text variant="mono" color="secondary">
          {label.toUpperCase()}
        </Text>
      </Cell>
      <Cell width={COL} align="right">
        <Text variant="mono" color={better === 'fresh' ? 'success' : 'text'}>
          {show(a)}
        </Text>
      </Cell>
      <Cell width={COL} align="right">
        <Text variant="mono" color={better === 'reused' ? 'success' : 'text'}>
          {show(b)}
        </Text>
      </Cell>
    </Row>
  );
}

const styles = StyleSheet.create({
  quiet: { paddingVertical: 10 },
  compactRow: { paddingVertical: 5 },
});
