import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';

import { parseActingAs } from './format';

const STORAGE_KEY = 'pro-scan.console.acting-as';

interface ActingAsState {
  name: string;
  setName(name: string): void;
}

/** Who the console acts as ("Acting as"), saved on the device; sent as `by` on every action. */
export const useActingAs = create<ActingAsState>((set) => ({
  name: parseActingAs(undefined),
  setName(name) {
    set({ name });
    AsyncStorage.setItem(STORAGE_KEY, name).catch(() => {});
  },
}));

AsyncStorage.getItem(STORAGE_KEY)
  .then((saved) => {
    if (saved !== null) useActingAs.setState({ name: saved });
  })
  .catch(() => {});

/** The name to send: what's typed, or the default when the field is empty. */
export function actorName(name: string) {
  return parseActingAs(name);
}
