export type AppearancePreference = 'system' | 'light' | 'dark';

export const APPEARANCE_PREFERENCES: AppearancePreference[] = ['system', 'light', 'dark'];

/** A stored value back to a preference; anything unknown (or missing) means follow the phone. */
export function parseAppearancePreference(value: unknown): AppearancePreference {
  return value === 'light' || value === 'dark' ? value : 'system';
}

/** The scheme to draw: the user's pick, or the phone's when they chose Automatic. */
export function resolveColorScheme(preference: AppearancePreference, system: string | null | undefined): 'light' | 'dark' {
  if (preference !== 'system') return preference;
  return system === 'dark' ? 'dark' : 'light';
}
