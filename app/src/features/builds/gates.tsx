import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import type { BuildDetail, GateCheck, GateReport } from '@/api/types';
import { Cell, GroupLabel, Row, SectionHeader, StatusWord, Text } from '@/ui';

import { gateSummary, isActive, lastGateIndex } from './format';
import { strings } from './strings';

const CHECK_WIDTH = 40;

/**
 * GATE: each attempt's gate run as a collapsible list of checks. The last one starts open. `onCheckPress` makes the
 * failed checks tappable (the console quotes one to the builder).
 */
export function Gates({ build, onCheckPress, title = true }: { build: BuildDetail; onCheckPress?: (check: GateCheck) => void; title?: boolean }) {
  const [open, setOpen] = useState<Record<number, boolean>>({});
  if (build.attempts.length === 0) return null;
  const active = isActive(build.state);
  const lastIndex = lastGateIndex(build.gates);
  return (
    <View>
      {title ? <SectionHeader title={strings.gateTitle} /> : null}
      {build.attempts.map((attempt, i) => {
        const report: GateReport | null = build.gates?.[i] ?? null;
        const label = strings.gateAttempt(attempt.n);
        if (!report) return <GroupLabel key={attempt.n} label={`${label} · ${active && !attempt.endedAt ? strings.gatePending : strings.noGate}`} />;
        const expanded = open[attempt.n] ?? i === lastIndex;
        return (
          <View key={attempt.n}>
            <GroupLabel label={`${label} · ${gateSummary(report)}`} onPress={() => setOpen((o) => ({ ...o, [attempt.n]: !expanded }))} expanded={expanded} />
            {expanded ? report.checks.map((check, j) => <CheckRow key={`${check.name}-${j}`} check={check} onPress={onCheckPress} />) : null}
          </View>
        );
      })}
    </View>
  );
}

/** PASS/FAIL and the check's name and detail. A failed check is tappable when `onPress` is given. */
export function CheckRow({ check, onPress }: { check: GateCheck; onPress?: (check: GateCheck) => void }) {
  return (
    <Row style={styles.compactRow} onPress={onPress && !check.passed ? () => onPress(check) : undefined} accessibilityLabel={`${check.name}: ${check.detail}`}>
      <Cell width={CHECK_WIDTH}>
        <View style={styles.lineHit}>
          <StatusWord label={check.passed ? strings.checkPass : strings.checkFail} tone={check.passed ? 'success' : 'danger'} />
        </View>
      </Cell>
      <Cell>
        <Text variant="mono" style={!check.passed && styles.bold}>
          {check.name}
        </Text>
        {check.detail ? (
          <Text variant="mono" color="secondary" selectable={!onPress} style={styles.meta}>
            {check.detail}
          </Text>
        ) : null}
      </Cell>
    </Row>
  );
}

const styles = StyleSheet.create({
  bold: { fontWeight: '700' },
  meta: { marginTop: 2 },
  lineHit: { minHeight: 19, justifyContent: 'center' },
  compactRow: { paddingVertical: 7 },
});
