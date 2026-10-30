import { createContext, use } from 'react';
import { Platform, type TextStyle } from 'react-native';

import { useColorScheme } from '@/hooks/use-color-scheme';

import { useAppearance } from './appearance';
import { resolveColorScheme } from './appearance-preference';

// Direction C · Ticket: paper and ink, plain black in dark mode (no tint), aqua used sparingly
// (selected checkboxes, focus, the lowest-price mark, links). Status colors carry meaning only.
// WCAG AA (≥ 4.5:1) on background / surface:
//   light: text 17.3 / 15.7 · secondary 5.5 / 5.0 · accent 5.1 / 4.65 · success 5.1 / 4.64 · warning 5.1 / 4.59 · danger 6.3 / 5.7
//          primaryText on primary 17.3 · accentText on accent 5.4
//   dark:  text 17.9 / 16.0 · secondary 6.8 / 6.0 · accent 11.6 / 10.3 · success 12.1 / 10.8 · warning 11.8 / 10.5 · danger 8.8 / 7.8
//          primaryText on primary 17.9 · accentText on accent 11.6
// Light accent, success and warning are a shade darker than the design page (#08788C, #2E7D32, #9A6200), which
// measured 4.4–4.5:1 on the slip.
const palette = {
  light: {
    background: '#FAFAF7',
    // The slip: receipt panel, input fields, skeletons.
    surface: '#F0EFE8',
    surfaceMuted: '#F0EFE8',
    surfaceRaised: '#E4E3DB',
    border: '#DAD9D1',
    text: '#161616',
    textSecondary: '#66665F',
    primary: '#161616',
    primaryPressed: '#000000',
    primaryText: '#FAFAF7',
    accent: '#07758A',
    accentText: '#FFFFFF',
    success: '#2B7A2F',
    warning: '#966000',
    danger: '#B3261E',
    info: '#161616',
    overlay: 'rgba(0,0,0,0.6)',
  },
  dark: {
    background: '#000000',
    surface: '#121212',
    surfaceMuted: '#121212',
    surfaceRaised: '#262626',
    border: '#2A2A2A',
    text: '#EDEDED',
    textSecondary: '#929292',
    primary: '#EDEDED',
    primaryPressed: '#CFCFCF',
    primaryText: '#000000',
    accent: '#4FD1E3',
    accentText: '#000000',
    success: '#7BD88F',
    warning: '#F0B95A',
    danger: '#F28B82',
    info: '#EDEDED',
    overlay: 'rgba(0,0,0,0.82)',
  },
} as const;

export type Colors = { [K in keyof typeof palette.light]: string };

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
/** Small corners only: 6 for blocks and fields, 4 for the slip and images, 3 for checkboxes. */
export const radius = { sm: 3, md: 4, lg: 6, pill: 999 } as const;

/** Monospaced face for every number, code, caps label and table header. No font package: system faces only. */
export const monoFamily = Platform.select({
  ios: 'Menlo',
  web: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace',
  default: 'monospace',
});

const mono: TextStyle = { fontFamily: monoFamily, fontVariant: ['tabular-nums'] };

export const typography = {
  /** Product name on a screen. */
  title: { fontSize: 22, lineHeight: 26, fontWeight: '600', letterSpacing: -0.4 },
  heading: { fontSize: 17, lineHeight: 22, fontWeight: '600', letterSpacing: -0.2 },
  /** Row titles in tables. */
  subheading: { fontSize: 14, lineHeight: 19, fontWeight: '600' },
  body: { fontSize: 15, lineHeight: 21, fontWeight: '400' },
  caption: { fontSize: 13, lineHeight: 18, fontWeight: '400' },
  /** Caps labels, section rules, table headers: pass upper-case text. */
  label: { ...mono, fontSize: 10.5, lineHeight: 14, fontWeight: '600', letterSpacing: 1.2 },
  /** Domains, meta lines, codes. */
  mono: { ...mono, fontSize: 12, lineHeight: 17, fontWeight: '400' },
  /** Numbers in table cells. */
  number: { ...mono, fontSize: 15, lineHeight: 20, fontWeight: '600' },
  /** Stats strip counts. */
  stat: { ...mono, fontSize: 20, lineHeight: 24, fontWeight: '600' },
  /** Big price on the receipt. */
  price: { ...mono, fontSize: 34, lineHeight: 38, fontWeight: '700', letterSpacing: -1 },
} as const satisfies Record<string, TextStyle>;

export type TypographyVariant = keyof typeof typography;

export interface Theme {
  dark: boolean;
  colors: Colors;
  spacing: typeof spacing;
  radius: typeof radius;
  typography: typeof typography;
}

/** Forces a color scheme for a subtree, e.g. the camera screen, which is always dark. */
export const ForcedScheme = createContext<'light' | 'dark' | undefined>(undefined);

/** Colors for the user's Light / Dark / Automatic choice (Automatic follows the phone). */
export function useTheme(): Theme {
  const system = useColorScheme();
  const preference = useAppearance((s) => s.preference);
  const forced = use(ForcedScheme);
  const dark = (forced ?? resolveColorScheme(preference, system)) === 'dark';
  return { dark, colors: dark ? palette.dark : palette.light, spacing, radius, typography };
}

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

/** Foreground color for a status tone (status words are colored text, not pills). */
export function toneColor(colors: Colors, tone: Tone): string {
  switch (tone) {
    case 'accent':
      return colors.accent;
    case 'success':
      return colors.success;
    case 'warning':
      return colors.warning;
    case 'danger':
      return colors.danger;
    case 'info':
      return colors.info;
    default:
      return colors.textSecondary;
  }
}
