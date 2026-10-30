import AsyncStorage from '@react-native-async-storage/async-storage';
import { Appearance, Platform } from 'react-native';
import { create } from 'zustand';

import { parseAppearancePreference, type AppearancePreference } from './appearance-preference';

export type { AppearancePreference } from './appearance-preference';

const STORAGE_KEY = 'pro-scan.appearance';

interface AppearanceState {
  preference: AppearancePreference;
  /** True once the saved preference has been read (or the user picked one). */
  loaded: boolean;
  setPreference(preference: AppearancePreference): void;
}

// On iOS/Android the override also reaches system-drawn parts (glass header, keyboard, switches, alerts).
function applyToSystem(preference: AppearancePreference) {
  if (Platform.OS === 'web') return;
  try {
    Appearance.setColorScheme(preference === 'system' ? 'auto' : preference);
  } catch {
    // Older runtimes without the override keep following the phone; useTheme still applies the choice.
  }
}

/** Light / Dark / Automatic, saved on the device. */
export const useAppearance = create<AppearanceState>((set) => ({
  preference: 'system',
  loaded: false,
  setPreference(preference) {
    set({ preference, loaded: true });
    applyToSystem(preference);
    AsyncStorage.setItem(STORAGE_KEY, preference).catch(() => {});
  },
}));

/** Resolves when the saved preference is applied; never rejects. */
export const appearanceLoaded: Promise<void> = (async () => {
  let preference: AppearancePreference = 'system';
  try {
    preference = parseAppearancePreference(await AsyncStorage.getItem(STORAGE_KEY));
  } catch {
    // Storage unavailable: follow the phone.
  }
  // A pick made while we were reading wins.
  if (useAppearance.getState().loaded) return;
  useAppearance.setState({ preference, loaded: true });
  applyToSystem(preference);
})();
