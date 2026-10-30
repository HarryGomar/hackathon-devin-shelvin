import { useState } from 'react';
import { StyleSheet, TextInput, View, type KeyboardTypeOptions } from 'react-native';

import { useTheme } from '@/theme';
import { Button, Text } from '@/ui';

import { isDraftValid, type IdentityDraft } from './identity';
import { strings } from './strings';

const FIELDS: { key: keyof IdentityDraft; required?: boolean; keyboardType?: KeyboardTypeOptions }[] = [
  { key: 'brand', required: true },
  { key: 'productName', required: true },
  { key: 'variant' },
  { key: 'size' },
  { key: 'barcode', keyboardType: 'number-pad' },
  { key: 'manufacturer' },
];

/** Text inputs for every identity field. Brand and product name are required. */
export function EditForm({ initial, onSave, onCancel }: { initial: IdentityDraft; onSave: (draft: IdentityDraft) => void; onCancel?: () => void }) {
  const { colors, radius, spacing, typography } = useTheme();
  const [draft, setDraft] = useState(initial);
  const valid = isDraftValid(draft);

  return (
    <View style={{ gap: spacing.md }}>
      {FIELDS.map(({ key, required, keyboardType }) => (
        <View key={key} style={{ gap: spacing.xs }}>
          <Text variant="label" color="secondary">
            {strings.fields[key].toUpperCase()}
            {required ? ' *' : ''}
          </Text>
          <TextInput
            value={draft[key]}
            onChangeText={(text) => setDraft((d) => ({ ...d, [key]: text }))}
            placeholder={strings.placeholders[key]}
            placeholderTextColor={colors.textSecondary}
            selectionColor={colors.accent}
            cursorColor={colors.accent}
            keyboardType={keyboardType}
            autoCapitalize={key === 'barcode' ? 'none' : 'words'}
            autoCorrect={false}
            accessibilityLabel={strings.fields[key]}
            style={[
              key === 'barcode' ? typography.number : typography.body,
              styles.input,
              { color: colors.text, backgroundColor: colors.background, borderColor: colors.text, borderRadius: radius.lg, paddingHorizontal: spacing.md },
            ]}
          />
        </View>
      ))}
      {!valid ? (
        <Text variant="mono" color="secondary">
          {strings.requiredHint}
        </Text>
      ) : null}
      <View style={[styles.actions, { gap: spacing.sm }]}>
        {onCancel ? (
          <View style={styles.flex}>
            <Button title={strings.cancel} variant="secondary" onPress={onCancel} />
          </View>
        ) : null}
        <View style={styles.flex}>
          <Button title={strings.save} variant="primary" disabled={!valid} onPress={() => onSave(draft)} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  input: { minHeight: 44, borderWidth: 1 },
  actions: { flexDirection: 'row', marginTop: 4 },
});
