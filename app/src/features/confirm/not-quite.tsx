import { StyleSheet, View } from 'react-native';

import { useTheme } from '@/theme';
import { Button, Cell, Icon, Row, SectionHeader, Text } from '@/ui';

import { alternativeLabel, type Alternative } from './identity';
import { strings } from './strings';

/** "Not quite?": other possible matches as table rows (name · flavor, brand · size, %), plus a way into edit mode. */
export function NotQuite({ alternatives, demo, onSelect, onEdit }: { alternatives: Alternative[]; demo?: boolean; onSelect: (alt: Alternative) => void; onEdit: () => void }) {
  const { colors, spacing } = useTheme();
  return (
    <View style={{ gap: spacing.md }}>
      <View>
        <SectionHeader title={strings.notQuite} right={alternatives.length > 0 ? String(alternatives.length).padStart(2, '0') : undefined} />
        {alternatives.map((alt) => {
          const { title, subtitle } = alternativeLabel(alt);
          return (
            <Row key={`${title}-${alt.size ?? ''}`} accessibilityLabel={[title, subtitle].filter(Boolean).join(', ')} onPress={() => onSelect(alt)}>
              <Cell>
                <Text variant="subheading">{title}</Text>
                {subtitle ? (
                  <Text variant="mono" color="secondary" style={styles.sub}>
                    {subtitle}
                  </Text>
                ) : null}
              </Cell>
              <Cell width={44} align="right">
                <Text variant="mono" color={demo ? 'secondary' : 'text'} style={styles.percent}>
                  {demo ? '—' : `${Math.round(alt.confidence * 100)}%`}
                </Text>
              </Cell>
              <View style={styles.chevron}>
                <Icon name="chevron.right" size={12} color={colors.textSecondary} fallback="›" />
              </View>
            </Row>
          );
        })}
      </View>
      <Button title={strings.edit} variant="secondary" icon="pencil" iconFallback="✎" onPress={onEdit} />
    </View>
  );
}

const styles = StyleSheet.create({
  sub: { marginTop: 2 },
  percent: { lineHeight: 20 },
  chevron: { paddingTop: 4 },
});
