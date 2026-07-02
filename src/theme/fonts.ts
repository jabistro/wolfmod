import type { Theme } from '../data/themeArt';

// Per-theme font families keyed by weight bucket. React Native (esp. Android)
// won't synthesize weights from a single family, so each weight maps to the
// matching named family that we load in App.tsx.
type WeightFamilies = {
  regular: string; // 100-499
  medium: string; // 500-599
  semibold: string; // 600-699
  bold: string; // 700-799
  extrabold: string; // 800+
};

const FAMILIES: Record<Theme, WeightFamilies> = {
  ghibli: {
    regular: 'Quicksand_400Regular',
    medium: 'Quicksand_500Medium',
    semibold: 'Quicksand_600SemiBold',
    bold: 'Quicksand_700Bold',
    extrabold: 'Quicksand_700Bold', // Quicksand tops out at 700
  },
  chibi: {
    regular: 'Baloo2_400Regular',
    medium: 'Baloo2_500Medium',
    semibold: 'Baloo2_600SemiBold',
    bold: 'Baloo2_700Bold',
    extrabold: 'Baloo2_800ExtraBold',
  },
  '16bit': {
    // Press Start 2P ships a single weight; everything maps to it.
    regular: 'PressStart2P_400Regular',
    medium: 'PressStart2P_400Regular',
    semibold: 'PressStart2P_400Regular',
    bold: 'PressStart2P_400Regular',
    extrabold: 'PressStart2P_400Regular',
  },
};

// Press Start 2P renders much larger/wider than a normal font at the same px,
// so shrink every font size under the 16bit theme to keep layouts intact.
// Single knob — nudge if 16bit text feels too small or still overflows.
export const FONT_SCALE: Record<Theme, number> = {
  ghibli: 1,
  chibi: 1,
  '16bit': 0.65,
};

// Module-level current theme, kept in sync by ThemeProvider. The global Text
// patch reads this at render time (it can't use React context/hooks). It also
// exposes a subscribe/getSnapshot pair so the patched Text/TextInput wrappers
// can hook it via useSyncExternalStore — that way a theme change repaints ALL
// text in the app immediately, even on screens that don't consume useTheme.
let currentTheme: Theme = 'ghibli';
const themeListeners = new Set<() => void>();

export function setFontTheme(theme: Theme): void {
  if (theme === currentTheme) return;
  currentTheme = theme;
  themeListeners.forEach(listener => listener());
}

export function getFontTheme(): Theme {
  return currentTheme;
}

// Stable subscribe fn for useSyncExternalStore; returns an unsubscribe.
export function subscribeFontTheme(listener: () => void): () => void {
  themeListeners.add(listener);
  return () => {
    themeListeners.delete(listener);
  };
}

// Convenience for the rare text node the global patch can't reach (e.g.
// Animated.Text, which captures the original Text at init). Returns the themed
// family and, when a base fontSize is given, the theme-scaled size. Call from a
// component that also reads the theme (useTheme) so it repaints on theme change.
export function themedFont(
  weight?: number | string | null,
  fontSize?: number,
): { fontFamily: string; fontSize?: number } {
  const style: { fontFamily: string; fontSize?: number } = {
    fontFamily: familyForWeight(weight),
  };
  if (typeof fontSize === 'number') {
    style.fontSize = fontSize * (FONT_SCALE[getFontTheme()] ?? 1);
  }
  return style;
}

export function familyForWeight(weight?: number | string | null): string {
  const fam = FAMILIES[currentTheme] ?? FAMILIES.ghibli;
  if (weight == null) return fam.regular;
  if (weight === 'bold') return fam.bold;
  if (weight === 'normal') return fam.regular;
  const n = typeof weight === 'number' ? weight : parseInt(weight, 10);
  if (Number.isNaN(n)) return fam.regular;
  if (n >= 800) return fam.extrabold;
  if (n >= 700) return fam.bold;
  if (n >= 600) return fam.semibold;
  if (n >= 500) return fam.medium;
  return fam.regular;
}
