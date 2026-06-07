import React, { createContext, useContext, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'wolfmod.playerName';

type PlayerNameContextValue = {
  playerName: string;
  setPlayerName: (next: string) => void;
};

const PlayerNameContext = createContext<PlayerNameContextValue>({
  playerName: '',
  setPlayerName: () => {},
});

export function PlayerNameProvider({ children }: { children: React.ReactNode }) {
  const [playerName, setState] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const stored = await AsyncStorage.getItem(STORAGE_KEY);
      if (!cancelled && typeof stored === 'string') setState(stored);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setPlayerName = (next: string) => {
    setState(next);
    AsyncStorage.setItem(STORAGE_KEY, next);
  };

  return (
    <PlayerNameContext.Provider value={{ playerName, setPlayerName }}>
      {children}
    </PlayerNameContext.Provider>
  );
}

export function usePlayerName(): PlayerNameContextValue {
  return useContext(PlayerNameContext);
}
