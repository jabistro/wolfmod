import React, { createContext, useContext, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Theme } from '../data/themeArt';
import { setFontTheme } from '../theme/fonts';

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

  // Keep the module-level font theme (read by the global Text patch) in sync
  // with the active theme so text repaints with the right family on re-render.
  setFontTheme(theme);

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
