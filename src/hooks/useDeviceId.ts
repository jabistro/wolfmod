import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'wolfmod.deviceClientId';

function generateId(): string {
  // RFC4122-ish v4 UUID without external deps
  const hex = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      out += '-';
    } else if (i === 14) {
      out += '4';
    } else if (i === 19) {
      out += hex[(Math.random() * 4) | 0 | 8];
    } else {
      out += hex[(Math.random() * 16) | 0];
    }
  }
  return out;
}

/**
 * Returns a stable per-device ID, persisted in AsyncStorage. Used to identify
 * the same player across reconnects within a game.
 *
 * Returns `null` while the value is loading from storage on first render.
 */
export function useDeviceId(): string | null {
  const [id, setId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let stored = await AsyncStorage.getItem(KEY);
      if (!stored) {
        stored = generateId();
        await AsyncStorage.setItem(KEY, stored);
      }
      if (!cancelled) setId(stored);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return id;
}
