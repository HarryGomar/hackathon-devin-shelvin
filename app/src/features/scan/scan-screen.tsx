import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Platform, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, ErrorBanner, Icon, SegmentedControl, Strip, StripCell, Text, type IconName } from '@/ui';
import { ForcedScheme, radius, spacing } from '@/theme';

import { preparePhoto } from './photo';
import { beginSampleBarcodeScan, beginSamplePhotoScan, beginScan } from './start';
import { scanStrings as s } from './strings';

type Mode = 'barcode' | 'photo';
type CameraStatus = 'checking' | 'ask' | 'denied' | 'no-camera' | 'error' | 'granted';

const BARCODE_TYPES = ['ean13', 'ean8', 'upc_a', 'upc_e'] as const;
const WHITE = '#FFFFFF';
const DIM_WHITE = 'rgba(255,255,255,0.75)';
const CHROME = 'rgba(0,0,0,0.72)';

function successHaptic() {
  if (Platform.OS !== 'web') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
}

/** The camera is always dark, whatever the app's appearance. */
export default function ScanRoute() {
  return (
    <ForcedScheme value="dark">
      <ScanScreen />
    </ForcedScheme>
  );
}

function ScanScreen() {
  const params = useLocalSearchParams<{ mode?: string }>();
  const insets = useSafeAreaInsets();
  const [mode, setMode] = useState<Mode>(params.mode === 'photo' ? 'photo' : 'barcode');
  const [permission, requestPermission] = useCameraPermissions();
  // Web may have no webcam at all; native devices always have one.
  const [hasCamera, setHasCamera] = useState<boolean | undefined>(Platform.OS === 'web' ? undefined : true);
  const [mountError, setMountError] = useState<string>();
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState<'photo' | 'sample' | undefined>();
  const [error, setError] = useState<string>();
  const cameraRef = useRef<CameraView>(null);
  const scannedRef = useRef(false);
  const askedRef = useRef(false);

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    CameraView.isAvailableAsync()
      .then(setHasCamera)
      .catch(() => setHasCamera(false));
  }, []);

  // Ask once on open; after that the user taps "Allow camera" or uses Settings.
  useEffect(() => {
    if (hasCamera && permission && !permission.granted && permission.canAskAgain && !askedRef.current) {
      askedRef.current = true;
      requestPermission();
    }
  }, [hasCamera, permission, requestPermission]);

  const status: CameraStatus =
    hasCamera === false
      ? 'no-camera'
      : hasCamera === undefined || !permission
        ? 'checking'
        : permission.granted
          ? mountError
            ? 'error'
            : 'granted'
          : permission.canAskAgain
            ? 'ask'
            : 'denied';

  const close = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };

  const onBarcodeScanned = (result: BarcodeScanningResult) => {
    if (scannedRef.current) return;
    scannedRef.current = true;
    successHaptic();
    beginScan({ kind: 'barcode', code: result.data, format: result.type }, 'replace');
  };

  const takePhoto = async () => {
    if (!cameraRef.current || busy) return;
    setBusy('photo');
    setError(undefined);
    try {
      const picture = await cameraRef.current.takePictureAsync({ quality: 0.9 });
      const input = await preparePhoto(picture.uri);
      successHaptic();
      beginScan(input, 'replace');
    } catch {
      setError(s.photoError);
      setBusy(undefined);
    }
  };

  const onUseSamplePhoto = async () => {
    if (busy) return;
    setBusy('sample');
    setError(undefined);
    try {
      await beginSamplePhotoScan('replace');
    } catch {
      setError(s.photoError);
      setBusy(undefined);
    }
  };

  return (
    <View style={styles.root}>
      <StatusBar style="light" />

      {status === 'granted' ? (
        <>
          <CameraView
            ref={cameraRef}
            style={StyleSheet.absoluteFill}
            facing="back"
            mode="picture"
            barcodeScannerSettings={{ barcodeTypes: [...BARCODE_TYPES] }}
            onBarcodeScanned={mode === 'barcode' ? onBarcodeScanned : undefined}
            onCameraReady={() => setReady(true)}
            onMountError={(e) => setMountError(e.message)}
          />
          {mode === 'barcode' ? <View pointerEvents="none" style={styles.reticle} /> : null}
        </>
      ) : (
        <View style={[styles.center, { paddingTop: insets.top + 64 }]}>
          <PermissionState status={status} message={mountError} onAllow={requestPermission} />
        </View>
      )}

      <View style={[styles.topBar, { paddingTop: insets.top + spacing.sm }]}>
        <Pressable accessibilityRole="button" accessibilityLabel={s.close} onPress={close} hitSlop={12} style={styles.closeButton}>
          <Icon name="xmark" size={18} color={WHITE} fallback="✕" />
        </Pressable>
      </View>

      <View style={[styles.bottom, { paddingBottom: insets.bottom + spacing.lg }]}>
        {error ? <ErrorBanner message={error} /> : null}
        {status === 'granted' ? (
          <>
            <Text variant="mono" style={styles.hint}>
              {mode === 'barcode' ? s.barcodeHint : s.photoHint}
            </Text>
            {mode === 'photo' ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={s.shutter}
                accessibilityState={{ disabled: !ready || !!busy }}
                disabled={!ready || !!busy}
                onPress={takePhoto}
                style={({ pressed }) => [styles.shutter, { opacity: !ready || busy ? 0.5 : pressed ? 0.7 : 1 }]}>
                <View style={styles.shutterInner} />
              </Pressable>
            ) : null}
            <SegmentedControl<Mode>
              options={[
                { value: 'barcode', label: s.modeBarcode },
                { value: 'photo', label: s.modePhoto },
              ]}
              value={mode}
              onChange={setMode}
            />
          </>
        ) : null}
        <Text variant="label" style={styles.samplesTitle}>
          {s.samplesTitle.toUpperCase()}
        </Text>
        <Strip>
          <StripCell first label={s.sampleBarcode} icon="barcode" iconFallback="▥" disabled={!!busy} onPress={() => beginSampleBarcodeScan('replace')} />
          <StripCell label={s.samplePhoto} icon="photo" iconFallback="▣" loading={busy === 'sample'} disabled={!!busy} onPress={onUseSamplePhoto} />
        </Strip>
      </View>

      {busy === 'photo' ? (
        <View style={styles.processing}>
          <ActivityIndicator color={WHITE} size="large" />
          <Text style={styles.white}>{s.processing}</Text>
        </View>
      ) : null}
    </View>
  );
}

function PermissionState({ status, message, onAllow }: { status: Exclude<CameraStatus, 'granted'>; message?: string; onAllow: () => void }) {
  if (status === 'checking') {
    return (
      <>
        <ActivityIndicator color={WHITE} />
        <Text style={styles.dim}>{s.checkingPermission}</Text>
      </>
    );
  }
  const content: Record<typeof status, { icon: IconName; fallback: string; title: string; message: string }> = {
    ask: { icon: 'camera.fill', fallback: '📷', title: s.askTitle, message: s.askMessage },
    denied: { icon: 'camera.fill', fallback: '📷', title: s.deniedTitle, message: Platform.OS === 'web' ? s.deniedMessageWeb : s.deniedMessage },
    'no-camera': { icon: 'video.slash.fill', fallback: '📷', title: s.noCameraTitle, message: s.noCameraMessage },
    error: { icon: 'exclamationmark.triangle.fill', fallback: '!', title: s.cameraErrorTitle, message: message ?? s.noCameraMessage },
  };
  const c = content[status];
  return (
    <>
      <Icon name={c.icon} size={40} color={DIM_WHITE} fallback={c.fallback} />
      <Text variant="heading" style={[styles.white, styles.centerText]}>
        {c.title}
      </Text>
      <Text style={[styles.dim, styles.centerText]}>{c.message}</Text>
      {status === 'ask' ? <Button title={s.askButton} onPress={onAllow} /> : null}
      {status === 'denied' && Platform.OS !== 'web' ? <Button title={s.openSettings} onPress={() => Linking.openSettings()} /> : null}
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  white: { color: WHITE },
  dim: { color: DIM_WHITE },
  centerText: { textAlign: 'center' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md, paddingHorizontal: spacing.xl, paddingBottom: 260 },
  topBar: { position: 'absolute', top: 0, left: 0, right: 0, paddingHorizontal: spacing.lg, flexDirection: 'row' },
  closeButton: { width: 44, height: 44, borderRadius: radius.lg, backgroundColor: CHROME, alignItems: 'center', justifyContent: 'center' },
  reticle: {
    position: 'absolute',
    top: '30%',
    alignSelf: 'center',
    width: '75%',
    maxWidth: 320,
    aspectRatio: 1.7,
    borderWidth: 2,
    borderColor: WHITE,
    borderRadius: radius.lg,
    borderStyle: 'dashed',
  },
  bottom: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    gap: spacing.md,
    backgroundColor: CHROME,
    alignItems: 'stretch',
  },
  hint: { color: WHITE, textAlign: 'center' },
  shutter: { alignSelf: 'center', width: 72, height: 72, borderRadius: 36, borderWidth: 4, borderColor: WHITE, alignItems: 'center', justifyContent: 'center' },
  shutterInner: { width: 56, height: 56, borderRadius: 28, backgroundColor: WHITE },
  samplesTitle: { color: DIM_WHITE, textAlign: 'center' },
  processing: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center', gap: spacing.md },
});
