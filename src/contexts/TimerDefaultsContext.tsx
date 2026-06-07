import React, { createContext, useContext, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  TIMER_DEFAULTS,
  type TimerConfigValues,
} from '../components/TimerSteppers';

const STORAGE_KEY = 'wolfmod.timerDefaults';

type TimerDefaultsContextValue = {
  timerDefaults: TimerConfigValues;
  setTimerDefaults: (next: TimerConfigValues) => void;
};

const TimerDefaultsContext = createContext<TimerDefaultsContextValue>({
  timerDefaults: TIMER_DEFAULTS,
  setTimerDefaults: () => {},
});

// Accept only a well-formed numeric value per key; fall back to the baked-in
// default for anything missing or malformed so a stale/partial blob can't poison
// a new game's config.
function sanitize(value: unknown): TimerConfigValues {
  const out = { ...TIMER_DEFAULTS };
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    for (const key of Object.keys(TIMER_DEFAULTS) as (keyof TimerConfigValues)[]) {
      const n = v[key];
      if (typeof n === 'number' && Number.isFinite(n)) out[key] = n;
    }
  }
  return out;
}

export function TimerDefaultsProvider({ children }: { children: React.ReactNode }) {
  const [timerDefaults, setState] = useState<TimerConfigValues>(TIMER_DEFAULTS);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const stored = await AsyncStorage.getItem(STORAGE_KEY);
      if (cancelled || !stored) return;
      try {
        setState(sanitize(JSON.parse(stored)));
      } catch {
        // Corrupt blob — keep defaults.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setTimerDefaults = (next: TimerConfigValues) => {
    setState(next);
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  };

  return (
    <TimerDefaultsContext.Provider value={{ timerDefaults, setTimerDefaults }}>
      {children}
    </TimerDefaultsContext.Provider>
  );
}

export function useTimerDefaults(): TimerDefaultsContextValue {
  return useContext(TimerDefaultsContext);
}
