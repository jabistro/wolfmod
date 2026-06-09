import { useCallback, useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type ReadChannel = 'village' | 'wolves' | 'dead' | 'break';
export type ChannelMarks = Record<ReadChannel, number>;

const CHANNELS: ReadChannel[] = ['village', 'wolves', 'dead', 'break'];
const ZERO: ChannelMarks = { village: 0, wolves: 0, dead: 0, break: 0 };

type Persisted = { v: 1; marks: ChannelMarks; anchors: ChannelMarks };

export type ChatReadState = {
  /**
   * False until persisted state has loaded AND (on a fresh game) the existing
   * transcript has been seeded as read. Gate badge rendering on this so a fresh
   * load never flashes a wall of "unread".
   */
  ready: boolean;
  /** Per-channel high-water mark of messages actually SEEN on screen. */
  readMarks: ChannelMarks;
  /** Per-channel top-of-viewport message ts, for restoring scroll on reopen. */
  anchors: ChannelMarks;
  /** Advance a channel's seen mark (no-op if not newer). */
  markSeen: (channel: ReadChannel, sentAt: number) => void;
  /** Remember the top-of-viewport message for a channel (scroll anchor). */
  setAnchor: (channel: ReadChannel, sentAt: number) => void;
  /**
   * First-ever load only (nothing persisted): treat the existing transcript as
   * already read, so a player who's been present while messages accrued doesn't
   * open to a giant unread count. No-op once seeded or if state was restored.
   */
  seedIfFresh: (latest: ChannelMarks) => void;
};

/**
 * Telegram-style per-channel read state for the in-game chat, persisted to
 * AsyncStorage per (game, player). Survives the pane's remount on every phase
 * change and the message list's remount on every expand — and app restarts —
 * so "where you left off" sticks for the whole game.
 *
 * `readMarks` advances only as messages are actually seen on screen (driven by
 * the ChatPane's viewability tracking), which is what powers the live-
 * decrementing unread count and the "UNREAD MESSAGES" divider sliding down to
 * the last-seen message when you reopen a channel.
 */
export function useChatReadState(
  gameId: string,
  playerId: string | undefined,
): ChatReadState {
  const [readMarks, setReadMarks] = useState<ChannelMarks>(ZERO);
  const [anchors, setAnchors] = useState<ChannelMarks>(ZERO);
  const [ready, setReady] = useState(false);
  const freshRef = useRef(false); // storage was empty on load → needs seeding
  const seededRef = useRef(false);

  const key = playerId ? `wolfmod.chatRead.${gameId}.${playerId}` : null;

  // Load persisted state once we know who the player is.
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    setReady(false);
    seededRef.current = false;
    (async () => {
      let raw: string | null = null;
      try {
        raw = await AsyncStorage.getItem(key);
      } catch {
        raw = null;
      }
      if (cancelled) return;
      if (raw) {
        try {
          const p = JSON.parse(raw) as Persisted;
          setReadMarks({ ...ZERO, ...p.marks });
          setAnchors({ ...ZERO, ...p.anchors });
          freshRef.current = false;
          setReady(true);
          return;
        } catch {
          // fall through to fresh
        }
      }
      // Nothing usable stored → wait for seedIfFresh before showing counts.
      setReadMarks(ZERO);
      setAnchors(ZERO);
      freshRef.current = true;
    })();
    return () => {
      cancelled = true;
    };
  }, [key]);

  // Debounced persist whenever marks/anchors change (after first load).
  const writeRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!key || !ready) return;
    if (writeRef.current) clearTimeout(writeRef.current);
    writeRef.current = setTimeout(() => {
      const payload: Persisted = { v: 1, marks: readMarks, anchors };
      AsyncStorage.setItem(key, JSON.stringify(payload)).catch(() => {});
    }, 600);
    return () => {
      if (writeRef.current) clearTimeout(writeRef.current);
    };
  }, [key, ready, readMarks, anchors]);

  const markSeen = useCallback((channel: ReadChannel, sentAt: number) => {
    setReadMarks(prev =>
      sentAt > (prev[channel] ?? 0) ? { ...prev, [channel]: sentAt } : prev,
    );
  }, []);

  const setAnchor = useCallback((channel: ReadChannel, sentAt: number) => {
    setAnchors(prev =>
      sentAt !== (prev[channel] ?? 0) ? { ...prev, [channel]: sentAt } : prev,
    );
  }, []);

  const seedIfFresh = useCallback((latest: ChannelMarks) => {
    if (!freshRef.current || seededRef.current) return;
    seededRef.current = true;
    setReadMarks(prev => {
      const next = { ...prev };
      for (const c of CHANNELS) next[c] = Math.max(next[c] ?? 0, latest[c] ?? 0);
      return next;
    });
    setReady(true);
  }, []);

  return { ready, readMarks, anchors, markSeen, setAnchor, seedIfFresh };
}
