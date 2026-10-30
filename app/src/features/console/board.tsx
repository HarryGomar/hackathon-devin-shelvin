import { StyleSheet, View } from 'react-native';

import type { AgentRun, BuildHistory } from '@/api/types';
import { Cell, GroupLabel, Row, StatsStrip, StatusWord, Text } from '@/ui';

import { boardGroups, boardWord, cardMeta, cardNote, stripTotals } from './format';
import { strings } from './strings';

const STATE_WIDTH = 84;

/** BUILDERS · NEEDS YOU · CHECKS over the listed builds. Tapping NEEDS YOU selects the first build that needs you. */
export function ConsoleStrip({ history, onSelect }: { history: BuildHistory; onSelect: (id: string) => void }) {
  const t = stripTotals(history);
  const first = t.firstNeedingYou;
  return (
    <StatsStrip
      items={[
        { value: `${t.running}/${t.parallel}`, label: strings.builders, tone: 'accent', sub: strings.buildersSub(t.todayCost) },
        { value: t.needsYou, label: strings.needsYou, tone: 'warning', sub: strings.needsYouSub(first?.domain), onPress: first ? () => onSelect(first.buildId) : undefined },
        { value: t.failedGates, label: strings.checks, tone: 'danger', sub: strings.checksSub(t.allowedPaths, t.refused) },
      ]}
    />
  );
}

/** Builds under NEEDS YOU · BUILDING · QUEUED · PASSED · FAILED; an empty group is just its label. */
export function Board({ builds, selected, onSelect }: { builds: AgentRun[]; selected?: string; onSelect: (id: string) => void }) {
  return (
    <View>
      {boardGroups(builds).map((group) => (
        <View key={group.key}>
          <GroupLabel
            label={group.label}
            right={
              <Text variant="label" color="secondary">
                {String(group.builds.length).padStart(2, '0')}
              </Text>
            }
          />
          {group.builds.map((run) => (
            <BoardCard key={run.buildId} run={run} selected={run.buildId === selected} onPress={() => onSelect(run.buildId)} />
          ))}
        </View>
      ))}
    </View>
  );
}

function BoardCard({ run, selected, onPress }: { run: AgentRun; selected: boolean; onPress: () => void }) {
  const word = boardWord(run);
  const meta = cardMeta(run);
  return (
    <Row onPress={onPress} accessibilityLabel={`${run.domain}, ${word.label}${selected ? ', selected' : ''}`}>
      <Cell>
        <Text variant="subheading" color={selected ? 'accent' : 'text'} numberOfLines={1} style={selected && styles.selected}>
          {selected ? `▸ ${run.domain}` : run.domain}
        </Text>
        <Text variant="mono" color="secondary" numberOfLines={2} style={styles.meta}>
          {cardNote(run)}
        </Text>
        {meta ? (
          <Text variant="mono" color="secondary" numberOfLines={1}>
            {meta}
          </Text>
        ) : null}
      </Cell>
      <Cell width={STATE_WIDTH} align="right">
        <View style={styles.stateHit}>
          <StatusWord {...word} />
        </View>
      </Cell>
    </Row>
  );
}

const styles = StyleSheet.create({
  selected: { fontWeight: '700' },
  meta: { marginTop: 2 },
  stateHit: { minHeight: 19, justifyContent: 'center' },
});
