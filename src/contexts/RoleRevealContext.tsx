import React, { createContext, useContext, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const LYNCH_KEY = 'wolfmod.revealOnLynch';
const NIGHT_KEY = 'wolfmod.revealOnNightDeath';

// Host-local DEFAULTS for the "role reveal" variant. These seed a new game at
// create time (createGame snapshots them onto the game doc); the game doc is
// the source of truth once a game starts, so every remote phone agrees for the
// whole game regardless of its own local preference. Both default OFF — the
// app's core fun is the hidden-role mystery (see the cloak machinery), so
// revealing eliminated roles is an explicit opt-in.
type RoleRevealContextValue = {
  revealOnLynch: boolean;
  setRevealOnLynch: (next: boolean) => void;
  revealOnNightDeath: boolean;
  setRevealOnNightDeath: (next: boolean) => void;
};

const RoleRevealContext = createContext<RoleRevealContextValue>({
  revealOnLynch: false,
  setRevealOnLynch: () => {},
  revealOnNightDeath: false,
  setRevealOnNightDeath: () => {},
});

export function RoleRevealProvider({ children }: { children: React.ReactNode }) {
  const [revealOnLynch, setLynch] = useState(false);
  const [revealOnNightDeath, setNight] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [lynch, night] = await Promise.all([
        AsyncStorage.getItem(LYNCH_KEY),
        AsyncStorage.getItem(NIGHT_KEY),
      ]);
      if (cancelled) return;
      if (lynch !== null) setLynch(lynch === 'true');
      if (night !== null) setNight(night === 'true');
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setRevealOnLynch = (next: boolean) => {
    setLynch(next);
    AsyncStorage.setItem(LYNCH_KEY, next ? 'true' : 'false');
  };
  const setRevealOnNightDeath = (next: boolean) => {
    setNight(next);
    AsyncStorage.setItem(NIGHT_KEY, next ? 'true' : 'false');
  };

  return (
    <RoleRevealContext.Provider
      value={{
        revealOnLynch,
        setRevealOnLynch,
        revealOnNightDeath,
        setRevealOnNightDeath,
      }}
    >
      {children}
    </RoleRevealContext.Provider>
  );
}

export function useRoleReveal(): RoleRevealContextValue {
  return useContext(RoleRevealContext);
}
