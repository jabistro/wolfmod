import React, { createContext, useContext, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Theme } from '../data/themeArt';
import { setFontTheme } from '../theme/fonts';
import { preloadArt } from '../utils/preloadArt';

const STORAGE_KEY = 'wolfmod.theme';

type ThemeContextValue = {
  theme: Theme;
  setTheme: (theme: Theme) => void;
};

const ThemeContext = createContext<ThemeContextValue>({
  theme: 'ghibli',
  setTheme: () => {},
});

function isValidTheme(value: unknown): value is Theme {
  return value === 'ghibli' || value === 'chibi' || value === '16bit';
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>('ghibli');

  // Keep the font-theme store (read by the global Text patch, and subscribed to
  // by every Text/TextInput) in sync with the active theme. Done in an effect,
  // not during render, because setFontTheme now notifies subscribers — updating
  // them mid-render would warn.
  useEffect(() => {
    setFontTheme(theme);
    // Warm the image caches for the active deck (fire-and-forget). Covers the
    // first-mount fetch/decode lag during the splash on load, and re-warms the
    // new deck's art the moment the user switches themes.
    preloadArt(theme);
  }, [theme]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const stored = await AsyncStorage.getItem(STORAGE_KEY);
      if (!cancelled && isValidTheme(stored)) {
        setThemeState(stored);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setTheme = (next: Theme) => {
    setThemeState(next);
    AsyncStorage.setItem(STORAGE_KEY, next);
  };

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
