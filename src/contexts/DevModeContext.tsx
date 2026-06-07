import React, { createContext, useContext, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'wolfmod.devModeEnabled';

type DevModeContextValue = {
  // The host's preference for showing lobby dev tools. Only meaningful when
  // DEV_FEATURES_AVAILABLE is true; callers must still gate on availability.
  devModeEnabled: boolean;
  setDevModeEnabled: (next: boolean) => void;
};

const DevModeContext = createContext<DevModeContextValue>({
  devModeEnabled: true,
  setDevModeEnabled: () => {},
});

export function DevModeProvider({ children }: { children: React.ReactNode }) {
  // Default ON so playtest builds keep showing the tools until a host opts out.
  const [devModeEnabled, setState] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const stored = await AsyncStorage.getItem(STORAGE_KEY);
      if (!cancelled && stored !== null) setState(stored === 'true');
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setDevModeEnabled = (next: boolean) => {
    setState(next);
    AsyncStorage.setItem(STORAGE_KEY, next ? 'true' : 'false');
  };

  return (
    <DevModeContext.Provider value={{ devModeEnabled, setDevModeEnabled }}>
      {children}
    </DevModeContext.Provider>
  );
}

export function useDevMode(): DevModeContextValue {
  return useContext(DevModeContext);
}
