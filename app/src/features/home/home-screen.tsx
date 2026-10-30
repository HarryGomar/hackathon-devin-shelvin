import { router } from 'expo-router';
import { useState } from 'react';
import { Keyboard, RefreshControl, StyleSheet, View } from 'react-native';

import { apiMode, searchMode } from '@/api/client';
import { pickPhotoFromLibrary } from '@/features/scan/photo';
import { beginScan } from '@/features/scan/start';
import { useRecentScans } from '@/hooks/use-recent-scans';
import { identifyMode } from '@/services/identify';
import { useTheme } from '@/theme';
import { Button, ErrorBanner, ModeBadge, Screen, Strip, StripCell, Text } from '@/ui';

import { AppearanceButton } from './appearance-menu';
import { ManualBarcode } from './manual-barcode';
import { modeStatus } from './mode';
import { RecentScans } from './recent-scans';
import { homeStrings as s } from './strings';

const MODE = modeStatus({ apiMode, searchMode, identifyMode });

export default function HomeScreen() {
  const { colors, spacing } = useTheme();
  const { scans, loading, error, refresh } = useRecentScans();
  const [refreshing, setRefreshing] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [photoError, setPhotoError] = useState<string>();

  const onRefresh = async () => {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  };

  const choosePhoto = async () => {
    setPhotoError(undefined);
    setPicking(true);
    try {
      const input = await pickPhotoFromLibrary();
      if (input) beginScan(input);
    } catch {
      setPhotoError(s.photoError);
    } finally {
      setPicking(false);
    }
  };

  // Close the field (and keyboard) as the scan starts, so Home is clean when the user comes back.
  const submitManual = (code: string) => {
    Keyboard.dismiss();
    setManualOpen(false);
    beginScan({ kind: 'manual', code });
  };

  return (
    <Screen edges={['top', 'bottom']} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.textSecondary} />}>
      <View style={[styles.topBar, { gap: spacing.md }]}>
        <Text variant="number" style={styles.brand} accessibilityRole="header">
          {s.brand}
        </Text>
        <View style={styles.status}>
          <ModeBadge label={MODE.label} demo={MODE.demo} accessibilityLabel={s.modeA11y(MODE.label)} />
        </View>
        <AppearanceButton />
      </View>

      <View style={{ gap: spacing.sm + 2 }}>
        <Button
          title={s.scanProduct}
          sub={s.scanProductSub}
          stripe
          end={{ icon: 'arrow.right', fallback: '→' }}
          onPress={() => router.push('/scan')}
        />
        <Strip>
          <StripCell
            first
            label={s.takePhoto}
            accessibilityLabel={s.takePhotoA11y}
            icon="camera"
            iconFallback="◉"
            onPress={() => router.push({ pathname: '/scan', params: { mode: 'photo' } })}
          />
          <StripCell label={s.choosePhoto} accessibilityLabel={s.choosePhotoA11y} icon="photo" iconFallback="▣" loading={picking} onPress={choosePhoto} />
          <StripCell
            label={s.typeBarcode}
            accessibilityLabel={s.typeBarcodeA11y}
            icon="keyboard"
            iconFallback="⌨"
            selected={manualOpen}
            expanded={manualOpen}
            onPress={() => setManualOpen((open) => !open)}
          />
        </Strip>
      </View>

      {photoError ? <ErrorBanner message={photoError} /> : null}
      {manualOpen ? <ManualBarcode onSubmit={submitManual} /> : null}

      <RecentScans scans={scans} loading={loading} error={error} onRetry={refresh} />

      <Button title={s.scraperBuilds} variant="secondary" onPress={() => router.push('/builds')} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  topBar: { flexDirection: 'row', alignItems: 'center', minHeight: 44 },
  status: { flex: 1, alignItems: 'flex-end' },
  brand: { fontSize: 14, fontWeight: '700', letterSpacing: 2 },
});
