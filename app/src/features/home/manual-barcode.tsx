import { useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { SAMPLE_BARCODES } from '@/api/mock/fixtures';
import { useTheme } from '@/theme';
import { Button, Text } from '@/ui';

import { normalizeBarcode } from './format';
import { homeStrings as s } from './strings';

/** Inline barcode field. Calls `onSubmit` with digits only once the length is valid. */
export function ManualBarcode({ onSubmit }: { onSubmit: (code: string) => void }) {
  const { colors, radius, spacing, typography } = useTheme();
  const [value, setValue] = useState('');
  const [showError, setShowError] = useState(false);
  const { code, valid } = normalizeBarcode(value);

  const submit = () => {
    if (!valid) {
      setShowError(true);
      return;
    }
    onSubmit(code);
  };

  return (
    <View style={{ gap: spacing.sm }}>
      <Text variant="label" color="secondary">
        {s.manualLabel.toUpperCase()}
      </Text>
      <View style={[styles.row, { gap: spacing.sm }]}>
        <TextInput
          value={value}
          onChangeText={(text) => {
            setValue(text);
            setShowError(false);
          }}
          onSubmitEditing={submit}
          placeholder={s.manualPlaceholder}
          placeholderTextColor={colors.textSecondary}
          selectionColor={colors.accent}
          cursorColor={colors.accent}
          keyboardType="number-pad"
          returnKeyType="search"
          inputMode="numeric"
          maxLength={16}
          autoFocus
          accessibilityLabel={s.manualLabel}
          style={[
            typography.number,
            styles.input,
            {
              color: colors.text,
              backgroundColor: colors.background,
              borderColor: showError ? colors.danger : colors.text,
              borderRadius: radius.lg,
              paddingHorizontal: spacing.md,
            },
          ]}
        />
        {/* A fixed slot: the button's label is flex: 1, which on iOS would take the whole row and squash the field. */}
        <View style={styles.submit}>
          <Button title={s.manualSubmit} onPress={submit} disabled={code.length === 0} />
        </View>
      </View>
      {showError ? (
        <Text variant="caption" color="danger" accessibilityRole="alert">
          {s.manualInvalid}
        </Text>
      ) : null}
      <Pressable accessibilityRole="button" onPress={() => setValue(SAMPLE_BARCODES.doritosIncognita)} hitSlop={8} style={styles.sample}>
        <Text variant="mono" color="accent">
          {s.manualSample(SAMPLE_BARCODES.doritosIncognita)}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  input: { flex: 1, minWidth: 0, minHeight: 46, borderWidth: 1, letterSpacing: 1.5 },
  submit: { width: 112 },
  sample: { alignSelf: 'flex-start' },
});
