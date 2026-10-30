import { useState } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '@/theme';
import { useAppearance, type AppearancePreference } from '@/theme/appearance';
import { APPEARANCE_PREFERENCES } from '@/theme/appearance-preference';
import { Icon, Text, type IconName } from '@/ui';

import { homeStrings as s } from './strings';

const ICONS: Record<AppearancePreference, { name: IconName; fallback: string }> = {
  system: { name: 'circle.lefthalf.filled', fallback: '◐' },
  light: { name: 'sun.max', fallback: '☀' },
  dark: { name: 'moon', fallback: '☾' },
};

/** Header icon showing the current appearance; opens a small Automatic / Light / Dark menu. */
export function AppearanceButton() {
  const { colors } = useTheme();
  const preference = useAppearance((st) => st.preference);
  const [open, setOpen] = useState(false);
  const icon = ICONS[preference];
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={s.appearanceButton(s.appearanceOptions[preference])}
        onPress={() => setOpen(true)}
        style={({ pressed }) => [styles.headerButton, { opacity: pressed ? 0.6 : 1 }]}>
        <Icon name={icon.name} size={18} color={colors.text} fallback={icon.fallback} />
      </Pressable>
      <AppearanceMenu visible={open} onClose={() => setOpen(false)} />
    </>
  );
}

function AppearanceMenu({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { colors, dark, radius, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const preference = useAppearance((st) => st.preference);
  const setPreference = useAppearance((st) => st.setPreference);

  const choose = (value: AppearancePreference) => {
    setPreference(value);
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} supportedOrientations={['portrait']}>
      <Pressable accessibilityLabel={s.appearanceTitle} style={styles.backdrop} onPress={onClose}>
        <View
          accessibilityRole="menu"
          style={[
            styles.menu,
            {
              top: insets.top + 56,
              right: spacing.lg,
              backgroundColor: colors.background,
              borderColor: dark ? colors.textSecondary : colors.text,
              borderRadius: radius.lg,
              padding: spacing.xs,
              boxShadow: dark ? undefined : '0 6px 18px rgba(0,0,0,0.10)',
            },
          ]}>
          <Text variant="label" color="secondary" style={{ paddingHorizontal: spacing.md, paddingTop: spacing.sm, paddingBottom: spacing.xs }}>
            {s.appearanceTitle.toUpperCase()}
          </Text>
          {APPEARANCE_PREFERENCES.map((value) => {
            const selected = value === preference;
            const icon = ICONS[value];
            return (
              <Pressable
                key={value}
                accessibilityRole="menuitem"
                accessibilityState={{ selected }}
                onPress={() => choose(value)}
                style={({ pressed }) => [
                  styles.row,
                  {
                    gap: spacing.md,
                    paddingHorizontal: spacing.md,
                    borderRadius: radius.md,
                    backgroundColor: pressed || selected ? colors.surface : 'transparent',
                  },
                ]}>
                <Icon name={icon.name} size={18} color={colors.text} fallback={icon.fallback} />
                <View style={styles.flex}>
                  <Text variant="subheading">{s.appearanceOptions[value]}</Text>
                  {value === 'system' ? (
                    <Text variant="caption" color="secondary">
                      {s.appearanceSystemHint}
                    </Text>
                  ) : null}
                </View>
                {selected ? <Icon name="checkmark" size={16} color={colors.accent} fallback="✓" /> : <View style={styles.check} />}
              </Pressable>
            );
          })}
        </View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  headerButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  backdrop: { flex: 1 },
  menu: { position: 'absolute', width: 232, borderWidth: 1 },
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 48 },
  check: { width: 16 },
});
