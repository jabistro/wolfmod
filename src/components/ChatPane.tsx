import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  Keyboard,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMutation, usePaginatedQuery, useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import { showAlert } from './ThemedAlert';
import { useChatReadState } from '../hooks/useChatReadState';

type Channel = 'village' | 'wolves' | 'dead' | 'break';

/** Trailing-edge debounce of a value — coalesces rapid changes. */
function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}

const CHANNEL_LABEL: Record<Channel, string> = {
  village: 'VILLAGE',
  wolves: 'WOLVES',
  dead: 'GHOSTS',
  break: 'BREAK ROOM',
};

// iMessage-style bubbles: my messages in system blue, everyone else's in a
// grey that's a touch lighter than wolf-card so the blocks read clearly on the
// dark surface. Both use white text.
const MY_BUBBLE_BG = '#0A84FF';
const OTHER_BUBBLE_BG = '#3A3A47';

// Bright, distinct hues that pop on the dark background and read clearly as a
// name color + an avatar fill (dark initial sits on top). These are decorative
// per-player identity colors — NOT team signals — so the spread of hues and the
// initial inside the circle keep them from reading like the red/blue team pills.
const NAME_PALETTE = [
  '#FF6B6B', '#FFA94D', '#FFD43B', '#A9E34B',
  '#69DB7C', '#38D9A9', '#3BC9DB', '#4DABF7',
  '#748FFC', '#B197FC', '#F783AC', '#FF8787',
];

/**
 * Stable color for a player, derived from their (immutable) ID — so every
 * device computes the identical color with no schema field or sync needed.
 */
function colorForPlayer(playerId: string): string {
  let h = 0;
  for (let i = 0; i < playerId.length; i++) {
    h = (h * 31 + playerId.charCodeAt(i)) >>> 0;
  }
  return NAME_PALETTE[h % NAME_PALETTE.length];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Telegram-style emoji prominence. A message that is *only* emoji (one or many)
// renders with no bubble background and at a larger size; a single emoji renders
// biggest of all. Any non-emoji character (even one) keeps the normal bubble.
//
// Matches an emoji "cluster": a pictographic base + optional variation/skin-tone
// modifiers + ZWJ-joined sequences (e.g. 👨‍👩‍👧). Built via new RegExp so an
// engine without Unicode property-escape support degrades gracefully (the
// try/catch leaves EMOJI_RE null → every message reads as normal text).
let EMOJI_RE: RegExp | null = null;
try {
  const mod = '(\\uFE0F|[\\u{1F3FB}-\\u{1F3FF}])*';
  const base = `\\p{Extended_Pictographic}${mod}`;
  EMOJI_RE = new RegExp(`${base}(\\u200D${base})*`, 'gu');
} catch {
  EMOJI_RE = null;
}

/**
 * Number of emoji clusters when `text` is emoji-only (ignoring whitespace);
 * 0 when it contains any other character. 1 = single emoji, etc.
 */
function emojiOnlyCount(text: string): number {
  if (!EMOJI_RE) return 0;
  const trimmed = text.trim();
  if (!trimmed) return 0;
  const matches = trimmed.match(EMOJI_RE);
  if (!matches) return 0;
  // Emoji-only iff stripping every cluster + whitespace leaves nothing behind.
  const remainder = trimmed.replace(EMOJI_RE, '').replace(/\s+/g, '');
  if (remainder.length > 0) return 0;
  return matches.length;
}

/** Font size for an emoji-only message: single emoji biggest, 2+ a tier down. */
function emojiFontSize(count: number): number {
  return count <= 1 ? 46 : 26;
}

// Render a moderator message body with any mentioned player names tinted their
// chat color (matches their avatar/messages), so it's clear who's referenced.
function renderModeratorBody(
  body: string,
  mentions?: { name: string; id: string }[],
): React.ReactNode {
  if (!mentions || mentions.length === 0) return body;
  // Longest names first so e.g. "Joe" wins over "Jo" in the alternation.
  // Case-insensitive so names tint inside UPPERCASE headlines too.
  const sorted = [...mentions].sort((a, b) => b.name.length - a.name.length);
  const colorByName = new Map(
    sorted.map(m => [m.name.toLowerCase(), colorForPlayer(m.id)]),
  );
  const pattern = new RegExp(
    `(${sorted.map(m => escapeRegExp(m.name)).join('|')})`,
    'gi',
  );
  return body.split(pattern).map((part, i) => {
    const color = colorByName.get(part.toLowerCase());
    return color ? (
      <Text key={i} style={{ color, fontWeight: '800' }}>
        {part}
      </Text>
    ) : (
      part
    );
  });
}

type Props = {
  gameId: Id<'games'>;
  deviceClientId: string;
  // Expand state is owned by RemoteGameLayout (it sizes the two regions).
  expanded: boolean;
  onToggleExpanded: () => void;
  // How many px of keyboard overlap the OS already absorbed by resizing the
  // RN view (measured by RemoteGameLayout). We pad only the leftover.
  keyboardHandledPx?: number;
};

type TrialInfo = {
  subPhase: 'accusation' | 'defense' | 'prevote';
  endsAt: number;
  pausedRemainingMs: number | null;
  accusedName: string;
  accuserName: string;
  iAmSpeaker: boolean;
};

type DayStats = {
  aliveCount: number;
  dayEndsAt: number | null;
  dayPausedRemainingMs: number | null;
  nominationsRemaining: number;
  maxNominationsPerDay: number;
};

// Compact discussion clock shown in the chat header (relocated from the day
// screen's big timer so it stays visible while the chat covers it). Same
// flash pacing as the on-screen clock: >20s white, 11–20 yellow/white,
// ≤10 red/white, 0 red.
function DayClockMini({ day }: { day: DayStats }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);
  const paused = day.dayPausedRemainingMs != null;
  const remMs = paused
    ? day.dayPausedRemainingMs!
    : Math.max(0, (day.dayEndsAt ?? now) - now);
  const sec = Math.max(0, Math.ceil(remMs / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  const color =
    sec <= 10
      ? sec % 2 === 0
        ? '#B03A2E'
        : '#F0EDE8'
      : sec <= 20
        ? sec % 2 === 0
          ? '#D4A017'
          : '#F0EDE8'
        : '#F0EDE8';
  return (
    <Text
      style={{ color, fontSize: 18, fontWeight: '800', fontVariant: ['tabular-nums'] }}
    >
      {m}:{String(s).padStart(2, '0')}
    </Text>
  );
}

// Night decision countdown in the chat header (wolves' pack clock OR an
// individual actor's NIGHT ACTIONS timer), so a player can glance at gameplay
// in chat and still watch their clock. Flashes red/white in the final 10s,
// lands on red at 0.
function DecisionClockMini({ endsAt }: { endsAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);
  const sec = Math.max(0, Math.ceil((endsAt - now) / 1000));
  const color =
    sec <= 10 && sec % 2 === 0 ? '#B03A2E' : sec === 0 ? '#B03A2E' : '#F0EDE8';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return (
    <Text
      style={{ color, fontSize: 18, fontWeight: '800', fontVariant: ['tabular-nums'] }}
    >
      {m}:{String(s).padStart(2, '0')}
    </Text>
  );
}

// Trial countdown banner shown just above the composer during the accusation /
// defense / prevote steps — replaces the big on-screen trial timers so the
// speaker watches their clock while typing.
function TrialBanner({ trial }: { trial: TrialInfo }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);
  const remainingMs =
    trial.pausedRemainingMs != null
      ? trial.pausedRemainingMs
      : Math.max(0, trial.endsAt - now);
  const sec = Math.max(0, Math.ceil(remainingMs / 1000));
  const label =
    trial.subPhase === 'accusation'
      ? trial.iAmSpeaker
        ? 'YOUR ACCUSATION — MAKE YOUR CASE'
        : `${trial.accuserName.toUpperCase()} — ACCUSATION`
      : trial.subPhase === 'defense'
        ? trial.iAmSpeaker
          ? 'YOUR DEFENSE'
          : `${trial.accusedName.toUpperCase()} — DEFENSE`
        : 'VOTING SOON — READ THE DEFENSE';
  return (
    <View
      className="flex-row items-center justify-center px-3 py-2 border-t border-wolf-card"
      style={{ gap: 10 }}
    >
      <Text className="text-wolf-muted text-[11px] font-bold tracking-widest">
        {label}
      </Text>
      <Text
        className="text-wolf-accent font-extrabold"
        style={{ fontSize: 20, fontVariant: ['tabular-nums'] }}
      >
        {sec}s
      </Text>
    </View>
  );
}

type WolfRosterEntry = {
  name: string;
  role: string;
  alive: boolean;
  isMe: boolean;
};

// Pinned at the top of the WOLVES chat so the pack can see who's on their team
// — and which wolf is which — without leaving the chat to study the seating
// ring. Mirrors the red-tinted "Name (Role)" pack box from the role reveal.
// Dead pack members are dimmed + struck through (no longer part of the kill).
function WolfRoster({ roster }: { roster: WolfRosterEntry[] }) {
  if (roster.length === 0) return null;
  // "YOUR PACK" only if the viewer is (or was) a wolf; a dead villager
  // spectating the channel sees the neutral "THE PACK".
  const iAmPack = roster.some(w => w.isMe);
  return (
    <View
      style={{
        marginHorizontal: 12,
        marginTop: 8,
        borderWidth: 1,
        borderColor: 'rgba(255,59,48,0.5)',
        backgroundColor: 'rgba(255,59,48,0.08)',
        borderRadius: 12,
        paddingVertical: 8,
        paddingHorizontal: 12,
      }}
    >
      <Text
        className="font-bold tracking-widest"
        style={{ color: '#FF3B30', fontSize: 10, marginBottom: 6 }}
      >
        {iAmPack ? 'YOUR PACK' : 'THE PACK'}
      </Text>
      <View className="flex-row flex-wrap" style={{ gap: 6 }}>
        {roster.map(w => (
          <View
            key={w.name}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              backgroundColor: w.isMe
                ? 'rgba(255,59,48,0.22)'
                : 'rgba(0,0,0,0.25)',
              borderRadius: 999,
              paddingVertical: 3,
              paddingHorizontal: 9,
              opacity: w.alive ? 1 : 0.45,
            }}
          >
            <Text
              className="font-bold"
              style={{
                color: '#F0EDE8',
                fontSize: 12,
                textDecorationLine: w.alive ? 'none' : 'line-through',
              }}
            >
              {w.name}
              {w.isMe ? ' (you)' : ''}
            </Text>
            <Text
              className="font-normal"
              style={{ color: '#C9A99A', fontSize: 12 }}
            >
              {' · '}
              {w.role}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

/**
 * Remote-mode chat surface. All access (which tabs exist, whether the
 * composer is live, the muted reason) comes from the server `chatState`
 * query — this component never re-derives permissions, it just renders
 * what it's told. See convex/chat.ts.
 */
export default function ChatPane({
  gameId,
  deviceClientId,
  expanded,
  onToggleExpanded,
  keyboardHandledPx = 0,
}: Props) {
  const insets = useSafeAreaInsets();
  const state = useQuery(api.chat.chatState, { gameId, deviceClientId });
  const sendMessage = useMutation(api.chat.sendMessage);
  const submitTrial = useMutation(api.day.submitTrialStatement);
  const pauseDay = useMutation(api.day.pauseDayClock);
  const resumeDay = useMutation(api.day.resumeDayClock);
  const pauseTrial = useMutation(api.day.pauseTrialClock);
  const startTrial = useMutation(api.day.startTrialClock);

  const isMorning = state?.phase === 'morning';
  const dayPaused = state?.day?.dayPausedRemainingMs != null;
  // A trial is in flight (accusation / defense / prevote / vote) — the host can
  // pause it just like open discussion. `state.paused` (isGamePaused) reflects
  // the frozen sub-phase clock here, so it drives both the icon and resume.
  const inTrial = !!state?.trial || state?.voteActive === true;
  const gamePaused = state?.paused === true;
  // Vote results just tallied → force the bottom on (re)open so the result card
  // is what everyone sees, never a restored pre-vote scroll spot. LIVING players
  // only — dead spectators stay wherever they're reading (they're not voting and
  // shouldn't get yanked, least of all on the GHOSTS channel).
  const voteResultsShowing =
    !!state?.voteResultsShowing && state?.me?.alive === true;

  async function toggleDayClock() {
    if (!state?.day) return;
    try {
      if (dayPaused) {
        await resumeDay({ gameId, callerDeviceClientId: deviceClientId });
      } else {
        await pauseDay({ gameId, callerDeviceClientId: deviceClientId });
      }
    } catch (e) {
      showAlert('Error', e instanceof Error ? e.message : String(e));
    }
  }

  // Pause / resume the active trial (accusation / defense / prevote / vote).
  // Freezes the sub-phase clock; isGamePaused flips everyone to the break room
  // just like a discussion pause.
  async function toggleTrialClock() {
    try {
      if (gamePaused) {
        await startTrial({ gameId, callerDeviceClientId: deviceClientId });
      } else {
        await pauseTrial({ gameId, callerDeviceClientId: deviceClientId });
      }
    } catch (e) {
      showAlert('Error', e instanceof Error ? e.message : String(e));
    }
  }

  // Track keyboard height ourselves and pad the pane by it. KeyboardAvoidingView
  // is unreliable on Android — and under SDK 54's edge-to-edge mode the window
  // doesn't auto-resize — so the OS keyboard otherwise paints over the composer.
  const [kbHeight, setKbHeight] = useState(0);
  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvt, e =>
      setKbHeight(e.endCoordinates?.height ?? 0),
    );
    const hideSub = Keyboard.addListener(hideEvt, () => setKbHeight(0));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  const channels = state?.channels ?? [];
  const myPlayerId = state?.me?.playerId;

  const [active, setActive] = useState<Channel>('village');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);

  // Keep the active tab valid as channels appear/disappear (e.g. on death the
  // GHOSTS tab shows up; if the current tab vanishes, fall back to the first).
  useEffect(() => {
    if (channels.length === 0) return;
    if (!channels.some(c => c.channel === active)) {
      setActive(channels[0].channel as Channel);
    }
  }, [channels, active]);

  // Auto-focus the WOLVES tab when night opens it for the pack, and flip back
  // to VILLAGE at dawn. Edge-triggered (only on the transition), so a wolf can
  // still manually switch tabs within a phase without getting yanked back.
  const wolvesCanPost = !!channels.find(c => c.channel === 'wolves')?.canPost;
  const prevWolvesCanPost = useRef(false);
  useEffect(() => {
    if (wolvesCanPost && !prevWolvesCanPost.current) {
      setActive('wolves');
    } else if (!wolvesCanPost && prevWolvesCanPost.current) {
      setActive(cur => (cur === 'wolves' ? 'village' : cur));
    }
    prevWolvesCanPost.current = wolvesCanPost;
  }, [wolvesCanPost]);

  // Pause → LIVING players move to the BREAK ROOM (gameplay channels go
  // read-only); unpause → focus snaps back to VILLAGE. The dead are left on
  // their tab — their ghost channel stays live through the pause. Edge-triggered.
  const paused = !!state?.paused && state?.me?.alive === true;
  const prevPaused = useRef(false);
  useEffect(() => {
    if (paused && !prevPaused.current) {
      setActive('break');
    } else if (!paused && prevPaused.current) {
      setActive(cur => (cur === 'break' ? 'village' : cur));
    }
    prevPaused.current = paused;
  }, [paused]);

  const activeMeta = channels.find(c => c.channel === active);

  const { results, status, loadMore } = usePaginatedQuery(
    api.chat.listMessages,
    { gameId, deviceClientId, channel: active },
    { initialNumItems: 30 },
  );

  // ─── Telegram-style read state ────────────────────────────────────────────
  // Per-channel "seen" marks + scroll anchors, persisted across phase changes
  // and restarts. The pane remounts on every phase, and the message list
  // remounts on every expand/tab-switch, so this state can't live in the list.
  const read = useChatReadState(gameId, myPlayerId ?? undefined);
  const listRef = useRef<FlatList>(null);

  // Server unread counts drive the OTHER tabs' badges + the collapsed-bar
  // total. Fed the persisted marks, debounced so scrolling (which advances the
  // active channel's mark continuously) doesn't thrash the subscription.
  const serverMarks = useDebounced(read.readMarks, 700);
  const unread = useQuery(api.chat.unreadCounts, {
    gameId,
    deviceClientId,
    lastSeen: serverMarks,
  });
  useEffect(() => {
    if (unread) read.seedIfFresh(unread.latest);
  }, [unread, read.seedIfFresh]);
  // The debounced server marks start at zero and lag the real marks for one
  // debounce window on mount — which would flash inflated counts on the other
  // tabs. Latch "primed" once the server query reflects the loaded marks, and
  // only trust its (non-active) counts after that. Non-active channels' marks
  // never change while you're elsewhere, so once primed they stay correct.
  const [serverPrimed, setServerPrimed] = useState(false);
  useEffect(() => {
    if (!serverPrimed && read.ready && serverMarks === read.readMarks) {
      setServerPrimed(true);
    }
  }, [serverPrimed, read.ready, serverMarks, read.readMarks]);

  // The active channel's unread is computed CLIENT-side from the loaded
  // transcript, so it decrements the instant a message scrolls into view with
  // no server round-trip. Only another PLAYER's messages are unread — our own
  // and moderator/system cards (no authorPlayerId: dawn report, dusk notice,
  // GAME ON) are app-presented narration, never an unread badge/divider.
  const isUnreadFrom = (m: any): boolean =>
    m.authorPlayerId != null && m.authorPlayerId !== myPlayerId;
  const activeMark = read.readMarks[active] ?? 0;
  const activeUnread = results.reduce(
    (n, m) => (m.sentAt > activeMark && isUnreadFrom(m) ? n + 1 : n),
    0,
  );
  const channelUnread = (ch: Channel): number => {
    if (!read.ready) return 0;
    if (ch === active) return activeUnread;
    return serverPrimed ? unread?.counts?.[ch] ?? 0 : 0;
  };
  const totalUnread = (Object.keys(CHANNEL_LABEL) as Channel[]).reduce(
    (sum, ch) => sum + channelUnread(ch),
    0,
  );

  // "UNREAD MESSAGES" divider position: anchored to the read mark AS OF the
  // moment the channel is opened/focused, then frozen for the session so it
  // doesn't jump while you read. Recomputed (slides down) on each reopen.
  // readMarks is intentionally excluded from the deps — that's what freezes it.
  const [bannerAnchor, setBannerAnchor] = useState<number | null>(null);
  useEffect(() => {
    dividerJumpedRef.current = false; // fresh staging for the caret button
    if (expanded && read.ready) setBannerAnchor(read.readMarks[active]);
    else if (!expanded) setBannerAnchor(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, active, read.ready]);

  // Inject the divider into the newest-first list at the read/unread boundary
  // (visually: just above the oldest unread message).
  const showBanner =
    bannerAnchor != null &&
    results.some(m => m.sentAt > bannerAnchor! && isUnreadFrom(m));
  const listData = React.useMemo<any[]>(() => {
    if (!showBanner || bannerAnchor == null) return results as any[];
    const idx = results.findIndex(m => m.sentAt <= bannerAnchor);
    const at = idx === -1 ? results.length : idx;
    const copy: any[] = (results as any[]).slice();
    copy.splice(at, 0, { _id: '__unread_divider__', __divider: true });
    return copy;
  }, [results, showBanner, bannerAnchor]);
  // Latest list data for async callbacks (restore retries) that would otherwise
  // close over a stale snapshot before older messages have paged in.
  const listDataRef = useRef(listData);
  listDataRef.current = listData;

  // Viewability → advance the read mark (newest message seen) and remember the
  // top-of-viewport message as the scroll anchor for reopen. Kept in stable
  // refs so the FlatList callback identity never changes.
  const activeRef = useRef(active);
  activeRef.current = active;
  const markSeenRef = useRef(read.markSeen);
  markSeenRef.current = read.markSeen;
  const setAnchorRef = useRef(read.setAnchor);
  setAnchorRef.current = read.setAnchor;
  const minVisibleIndexRef = useRef(0);
  const suppressSeenRef = useRef(false);
  // The most recent settled viewport (channel + newest-visible ts + top-of-
  // viewport ts), updated on EVERY viewability change even while seen-marking is
  // suppressed during the restore window. The restore's settle() flushes it once
  // suppression lifts — without that, a channel short enough that its message(s)
  // are fully visible without scrolling never fires another viewability event,
  // so its unread badge would stay stuck (see settle below).
  const lastViewableRef = useRef<{
    channel: Channel;
    maxTs: number;
    topTs: number;
  } | null>(null);
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 50 }).current;
  const onViewableItemsChanged = useRef(
    (info: { viewableItems: Array<{ item: any; index: number | null }> }) => {
      let minIdx = Number.POSITIVE_INFINITY;
      for (const vi of info.viewableItems) {
        if (typeof vi.index === 'number' && vi.index < minIdx) minIdx = vi.index;
      }
      if (minIdx !== Number.POSITIVE_INFINITY) minVisibleIndexRef.current = minIdx;
      const real = info.viewableItems.filter(
        vi =>
          vi.item && !vi.item.__divider && typeof vi.item.sentAt === 'number',
      );
      if (real.length === 0) return;
      let maxTs = 0;
      let top = real[0];
      for (const vi of real) {
        if (vi.item.sentAt > maxTs) maxTs = vi.item.sentAt;
        // Top of the viewport in an inverted list = largest index = oldest.
        if ((vi.index ?? 0) > (top.index ?? 0)) top = vi;
      }
      // Always remember the settled viewport so the restore window can flush it.
      lastViewableRef.current = {
        channel: activeRef.current,
        maxTs,
        topTs: top.item.sentAt,
      };
      // While force-restoring scroll on open, don't let the briefly-rendered
      // bottom rows mark the newest messages as read — settle() applies the
      // FINAL settled viewport instead.
      if (suppressSeenRef.current) return;
      markSeenRef.current(activeRef.current, maxTs);
      setAnchorRef.current(activeRef.current, top.item.sentAt);
    },
  ).current;

  // Follow-vs-freeze + scroll-to-bottom caret. In an inverted list, offset ~0
  // is the newest message (bottom); inverted handles "ride along at the bottom
  // / stay put when scrolled up" natively.
  const [atBottom, setAtBottom] = useState(true);
  // Latched once we've jumped to the divider, so the next tap always goes to
  // the bottom — robust regardless of the inverted list's viewPosition quirks.
  // Resets when you reach the bottom or switch channels (fresh scroll-up).
  const dividerJumpedRef = useRef(false);
  const onListScroll = (e: any) => {
    const y = e.nativeEvent.contentOffset.y;
    const next = y <= 24;
    if (next) dividerJumpedRef.current = false;
    setAtBottom(prev => (prev !== next ? next : prev));
  };
  const onCaretPress = () => {
    const divIdx = listData.findIndex(it => it.__divider);
    // First tap → the unread divider (if we're still scrolled up above it);
    // next tap (or no unread) → all the way to the newest message.
    const goDivider =
      divIdx >= 0 &&
      !dividerJumpedRef.current &&
      minVisibleIndexRef.current > divIdx;
    if (goDivider) {
      dividerJumpedRef.current = true;
      listRef.current?.scrollToIndex({
        index: divIdx,
        viewPosition: 1, // place the divider toward the top of the viewport
        animated: true,
      });
    } else {
      dividerJumpedRef.current = false;
      listRef.current?.scrollToOffset({ offset: 0, animated: true });
    }
  };
  const onScrollToIndexFailed = (info: {
    index: number;
    averageItemLength: number;
  }) => {
    listRef.current?.scrollToOffset({
      offset: info.averageItemLength * info.index,
      animated: false,
    });
    setTimeout(() => {
      listRef.current?.scrollToIndex({
        index: info.index,
        viewPosition: 1,
        animated: true,
      });
    }, 120);
  };

  // When a trial begins (someone is put on trial), yank LIVING players to the
  // bottom of the VILLAGE chat so they immediately see who's accused — the chat
  // also auto-expands for them (chatDominant → shouldOpen in RemoteGameLayout).
  // One-shot, edge-triggered on the trial appearing: afterward they're free to
  // scroll wherever they like, never stuck. The ref is honored by the restore
  // effect below so a concurrent tab/expand remount lands at the bottom too.
  const snapToBottomOnTrialRef = useRef(false);
  const trialOpen = !!state?.trial;
  const iAmAlive = state?.me?.alive === true;
  const prevTrialOpenRef = useRef(false);
  useEffect(() => {
    if (trialOpen && !prevTrialOpenRef.current && iAmAlive) {
      snapToBottomOnTrialRef.current = true;
      setActive('village');
      // Delay past the restore effect's own scroll so the bottom snap wins even
      // if we were already parked on VILLAGE (no remount → restore won't re-run).
      setTimeout(() => {
        listRef.current?.scrollToOffset({ offset: 0, animated: true });
      }, 120);
    }
    prevTrialOpenRef.current = trialOpen;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trialOpen, iAmAlive]);

  // Position the list each time a channel is (re)opened — the list remounts on
  // every expand and every tab switch. Priority: (1) the saved scroll position
  // if you've read here before, else (2) the UNREAD MESSAGES divider so you
  // start at the first unread, else (3) the bottom (newest). Hold off marking
  // anything seen until we've positioned, so the briefly-rendered bottom rows
  // don't clear the unread we're about to scroll to.
  const restoreSessionRef = useRef('');
  // True until this mount's first restore runs. The pane remounts on every
  // phase change (each phase is its own screen), so a fresh mount means we just
  // arrived in a new phase.
  const firstRestoreRef = useRef(true);
  useEffect(() => {
    if (!expanded || !read.ready) return;
    const session = `${active}:${gameId}`;
    restoreSessionRef.current = session;
    suppressSeenRef.current = true;
    const isFirstRestore = firstRestoreRef.current;
    firstRestoreRef.current = false;
    // Snap to the bottom (newest) — ignoring both the saved anchor AND the
    // unread divider — in two cases:
    //  (1) A fresh mount: we just arrived in a new phase and the latest message
    //      is the point — the dawn report at the start of a post-night day, or
    //      the GAME ON at day 1. This is what takes EVERYONE, living and ghost,
    //      to the night's result in #village when morning breaks.
    //  (2) Freshly-posted vote results (living players only — voteResultsShowing
    //      is gated on alive, so ghosts are never yanked mid-day).
    // Everything else (same-mount tab switch / expand-after-collapse) restores
    // the saved anchor or the unread divider so you keep your place.
    //  (3) A trial just began (living players) — see snapToBottomOnTrialRef.
    const goBottom =
      isFirstRestore || voteResultsShowing || snapToBottomOnTrialRef.current;
    snapToBottomOnTrialRef.current = false;
    const anchorTs = goBottom ? 0 : read.anchors[active] ?? 0;
    // Whether we expect something to scroll to (a saved spot or unread). Also
    // consult the server count for the target channel, since after a tab switch
    // the per-channel `results` (and thus activeUnread) can briefly lag.
    const expectTarget =
      !goBottom &&
      (anchorTs > 0 || activeUnread > 0 || (unread?.counts?.[active] ?? 0) > 0);
    const settle = () => {
      setTimeout(() => {
        if (restoreSessionRef.current === session) {
          suppressSeenRef.current = false;
          // Apply the final settled viewport now that suppression has lifted.
          // Covers short channels whose message(s) are fully visible without
          // scrolling: viewability fired once (during suppression) and won't
          // fire again, so the badge would otherwise never clear. markSeen is
          // monotonic and we only ever pass the currently-visible maxTs, so a
          // scrolled-up restore still leaves the unread-below messages unread.
          const lv = lastViewableRef.current;
          if (lv && lv.channel === active) {
            read.markSeen(active, lv.maxTs);
            read.setAnchor(active, lv.topTs);
          }
        }
      }, 300);
    };
    let tries = 0;
    const attempt = () => {
      if (restoreSessionRef.current !== session) return; // superseded
      const data = listDataRef.current;
      // Snap to the newest (see goBottom above), regardless of saved position.
      if (goBottom) {
        listRef.current?.scrollToOffset({ offset: 0, animated: false });
        settle();
        return;
      }
      let idx = anchorTs
        ? data.findIndex(it => !it.__divider && it.sentAt === anchorTs)
        : -1;
      // No saved position (or it hasn't paged in) → fall back to the divider.
      if (idx < 0) idx = data.findIndex(it => it.__divider);
      if (idx >= 0) {
        listRef.current?.scrollToIndex({
          index: idx,
          viewPosition: 1,
          animated: false,
        });
        settle();
      } else if (expectTarget && tries++ < 12) {
        setTimeout(attempt, 120); // wait for messages / divider to materialize
      } else {
        settle(); // nothing to scroll to → bottom is correct
      }
    };
    setTimeout(attempt, 60);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, active, read.ready, voteResultsShowing]);

  // Live-follow: while you're parked at the bottom of an open, active channel,
  // messages stream in as you watch them — nothing is being missed — so keep
  // both the read mark AND the divider anchor pinned to the newest message.
  // This is why a message that lands while the chat is already open (e.g. the
  // moderator's "GAME ON!" at the start of Day 1) never raises an unread badge
  // or an UNREAD MESSAGES divider. The freeze that preserves an unread line
  // only kicks in once you scroll up (atBottom → false) to read back, and the
  // open-time restore-scroll keeps you off the bottom for genuinely-unread
  // channels, so this doesn't swallow real unread runs. Skipped during the
  // restore-scroll window so the briefly-rendered bottom rows don't clear it.
  useEffect(() => {
    if (!expanded || !read.ready || !atBottom || suppressSeenRef.current) return;
    if (results.length === 0) return;
    const newestTs = results[0]?.sentAt; // inverted list: index 0 = newest
    if (typeof newestTs !== 'number') return;
    read.markSeen(active, newestTs);
    setBannerAnchor(newestTs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, read.ready, atBottom, active, results]);

  // When it's my accusation/defense window, SEND posts my statement AND ends
  // my turn (advances the trial) — see submitTrialStatement.
  const trial = state?.trial ?? null;
  const iAmSpeaker = !!trial?.iAmSpeaker && active === 'village';

  async function handleSend() {
    const body = draft.trim();
    if (!body || sending || !activeMeta?.canPost) return;
    setSending(true);
    try {
      if (iAmSpeaker) {
        await submitTrial({ gameId, deviceClientId, body });
      } else {
        await sendMessage({ gameId, deviceClientId, channel: active, body });
      }
      setDraft('');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      showAlert('Message not sent', msg);
    } finally {
      setSending(false);
    }
  }

  // Auto-send the speaker's draft just before their timer expires, so it isn't
  // lost to the server's silent fallback advance. Fires once per turn, ~600ms
  // early to win the race against the scheduled autoAdvanceTrial.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const autoSentRef = useRef<string | null>(null);
  useEffect(() => {
    if (!trial?.iAmSpeaker || trial.pausedRemainingMs != null) return;
    const key = `${trial.subPhase}:${trial.endsAt}`;
    const id = setInterval(() => {
      if (Date.now() >= trial.endsAt - 600 && autoSentRef.current !== key) {
        autoSentRef.current = key;
        submitTrial({ gameId, deviceClientId, body: draftRef.current.trim() })
          .then(() => setDraft(''))
          .catch(() => {});
        clearInterval(id);
      }
    }, 200);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trial?.iAmSpeaker, trial?.subPhase, trial?.endsAt, trial?.pausedRemainingMs]);

  if (!state?.enabled) return null;

  return (
    <View
      className="bg-wolf-surface border-t border-wolf-card"
      style={{
        // Expanded: flex into the region RemoteGameLayout left below the game
        // header, so the chat snaps right under it on every device (no computed
        // height). The header (clock) + composer stay put when the keyboard
        // opens; only the message list shrinks. Collapsed: auto height (bar).
        flex: expanded ? 1 : undefined,
        // Lift the composer above the keyboard by the overlap the OS DIDN'T
        // already absorb (measured view-resize, from RemoteGameLayout). The
        // +insets covers the nav-bar strip the keyboard height omits on
        // non-resizing devices; resizing devices net out to a tiny gap.
        paddingBottom:
          kbHeight > 0
            ? Math.max(0, kbHeight + insets.bottom - keyboardHandledPx)
            : Math.max(insets.bottom, 8),
      }}
    >
      {/* Header bar. Collapsed → just "CHAT". Expanded shows context: the
          morning action (BEGIN DAY / waiting), or live discussion stats
          (alive · clock · noms) so the timer stays visible while the chat
          covers the on-screen one. */}
      <TouchableOpacity
        onPress={onToggleExpanded}
        activeOpacity={0.8}
        className="flex-row items-center px-4 py-3"
        style={{ gap: 8 }}
      >
        {isMorning ? (
          <>
            <Text className="text-wolf-muted text-xs font-bold tracking-widest">
              CHAT
            </Text>
            <View style={{ flex: 1, alignItems: 'center' }}>
              {/* Fully auto-progressed — no host tap. The day rolls in on its
                  own (instantly, or after a brief cloak dwell when a Hunter /
                  Hunter Wolf is in play). */}
              <Text className="text-wolf-muted text-[11px] font-bold tracking-widest text-center">
                {state?.gameOver ? 'REVEALING RESULTS…' : 'DAY BEGINS SHORTLY…'}
              </Text>
            </View>
          </>
        ) : expanded && state?.day ? (
          <>
            <Text className="text-wolf-muted text-[11px] font-bold tracking-widest">
              {state.day.aliveCount} ALIVE
            </Text>
            <View
              style={{
                flex: 1,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 10,
              }}
            >
              {state.isHost && (
                <TouchableOpacity
                  onPress={toggleDayClock}
                  hitSlop={8}
                  className="w-7 h-7 rounded-full bg-wolf-card items-center justify-center"
                >
                  <Text className="text-wolf-text" style={{ fontSize: 12 }}>
                    {dayPaused ? '▶' : '❚❚'}
                  </Text>
                </TouchableOpacity>
              )}
              <DayClockMini day={state.day} />
            </View>
            <Text className="text-wolf-muted text-[11px] font-bold tracking-widest">
              NOMS {state.day.nominationsRemaining}/
              {state.day.maxNominationsPerDay}
            </Text>
          </>
        ) : expanded && state?.isHost && state?.phase === 'day' && inTrial ? (
          // A trial is in flight — give the host the same pause control they
          // have in open discussion. Pausing freezes the trial clock and sends
          // everyone to the BREAK ROOM (see isGamePaused).
          <View
            style={{
              flex: 1,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 10,
            }}
          >
            <TouchableOpacity
              onPress={toggleTrialClock}
              hitSlop={8}
              className="w-7 h-7 rounded-full bg-wolf-card items-center justify-center"
            >
              <Text className="text-wolf-text" style={{ fontSize: 12 }}>
                {gamePaused ? '▶' : '❚❚'}
              </Text>
            </TouchableOpacity>
            <Text className="text-wolf-muted text-[11px] font-bold tracking-widest">
              {gamePaused ? 'PAUSED' : state?.voteActive ? 'VOTING' : 'ON TRIAL'}
            </Text>
          </View>
        ) : expanded && state?.decisionClock != null ? (
          <>
            <Text className="text-wolf-red text-[11px] font-bold tracking-widest">
              DECIDE
            </Text>
            <View style={{ flex: 1, alignItems: 'center' }}>
              <DecisionClockMini endsAt={state.decisionClock} />
            </View>
          </>
        ) : (
          <Text
            className="text-wolf-muted text-xs font-bold tracking-widest"
            style={{ flex: 1 }}
          >
            CHAT
          </Text>
        )}
        {!expanded && totalUnread > 0 && (
          <View
            style={{
              minWidth: 20,
              height: 20,
              borderRadius: 10,
              paddingHorizontal: 5,
              backgroundColor: '#B03A2E',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text style={{ color: '#F0EDE8', fontSize: 11, fontWeight: '800' }}>
              {totalUnread > 99 ? '99+' : totalUnread}
            </Text>
          </View>
        )}
        <View
          style={{
            marginLeft: 8,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 4,
            paddingHorizontal: 10,
            paddingVertical: 4,
            borderRadius: 999,
            backgroundColor: expanded ? '#B03A2E' : '#2E7D46',
          }}
        >
          <Text
            style={{
              color: '#F0EDE8',
              fontSize: 11,
              fontWeight: '900',
              letterSpacing: 1,
            }}
          >
            {expanded ? 'CLOSE' : 'OPEN'}
          </Text>
          <Text
            style={{ color: '#F0EDE8', fontSize: 12, lineHeight: 12, fontWeight: '900' }}
          >
            {expanded ? '▼' : '▲'}
          </Text>
        </View>
      </TouchableOpacity>

      {expanded && (
        // Fills the rest of the fixed-height pane below the header. The message
        // list (flex:1 inside) absorbs all the give, so when the keyboard opens
        // the header (clock) and composer stay put and only the list shrinks.
        <View style={{ flex: 1 }}>
          {/* Channel tabs */}
          {channels.length > 1 && (
            <View className="flex-row px-3 pb-2" style={{ gap: 8 }}>
              {channels.map(c => {
                const isActive = c.channel === active;
                const tabUnread = channelUnread(c.channel as Channel);
                return (
                  <TouchableOpacity
                    key={c.channel}
                    onPress={() => setActive(c.channel as Channel)}
                    className={`flex-row items-center rounded-full px-3 py-1.5 ${
                      isActive ? 'bg-wolf-accent' : 'bg-wolf-card'
                    }`}
                    style={{ gap: 6 }}
                  >
                    <Text
                      className={`text-[11px] font-bold tracking-widest ${
                        isActive ? 'text-wolf-bg' : 'text-wolf-muted'
                      }`}
                    >
                      {CHANNEL_LABEL[c.channel as Channel]}
                    </Text>
                    {tabUnread > 0 && (
                      <View
                        style={{
                          minWidth: 16,
                          height: 16,
                          borderRadius: 8,
                          paddingHorizontal: 4,
                          backgroundColor: '#B03A2E',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <Text
                          style={{
                            color: '#F0EDE8',
                            fontSize: 10,
                            fontWeight: '800',
                          }}
                        >
                          {tabUnread > 99 ? '99+' : tabUnread}
                        </Text>
                      </View>
                    )}
                  </TouchableOpacity>
                );
              })}
            </View>
          )}

          {/* Pinned wolf-pack roster on the WOLVES tab — who's on the team and
              which wolf is which, so the pack can decide without leaving chat. */}
          {active === 'wolves' && state?.wolfRoster && (
            <WolfRoster roster={state.wolfRoster} />
          )}

          {/* Message list (inverted: newest at the bottom). Flexes to fill
              the tall expanded pane between the tabs and the composer. */}
          <View style={{ flex: 1 }}>
            <FlatList
              ref={listRef}
              data={listData}
              inverted
              keyExtractor={m => m._id}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 8 }}
              onScroll={onListScroll}
              scrollEventThrottle={16}
              onViewableItemsChanged={onViewableItemsChanged}
              viewabilityConfig={viewabilityConfig}
              onScrollToIndexFailed={onScrollToIndexFailed}
              onEndReached={() => {
                if (status === 'CanLoadMore') loadMore(30);
              }}
              onEndReachedThreshold={0.4}
              ListEmptyComponent={
                <Text className="text-wolf-muted text-xs text-center mt-6">
                  No messages yet.
                </Text>
              }
              renderItem={({ item }) => {
                // Full-width "UNREAD MESSAGES" divider at the read/unread
                // boundary captured when this channel was opened.
                if (item.__divider) {
                  return (
                    <View style={{ paddingVertical: 8 }}>
                      <View
                        style={{
                          backgroundColor: 'rgba(15,19,28,0.9)',
                          borderRadius: 8,
                          paddingVertical: 5,
                          paddingHorizontal: 12,
                        }}
                      >
                        <Text
                          style={{
                            color: '#9DB2C9',
                            textAlign: 'center',
                            fontSize: 11,
                            fontWeight: '800',
                            letterSpacing: 1.5,
                          }}
                        >
                          UNREAD MESSAGES
                        </Text>
                      </View>
                    </View>
                  );
                }
                // Dawn report card: bold + scannable. Gold "DAY N", then the
                // elimination line big, with any eliminated name tinted its
                // own chat color so it's easy to spot who died.
                // End-of-game: a big, proud WIN banner. The game has already
                // jumped to the end-game screen behind the chat — closing the
                // chat reveals the role logs.
                if (item.winBanner) {
                  const w = item.winBanner.winner;
                  const banner =
                    w === 'wolf'
                      ? { label: 'WOLVES WIN', bg: '#8B1818', border: '#B03A2E' }
                      : w === 'chupacabra'
                        ? { label: 'CHUPACABRA WINS', bg: '#6B4423', border: '#C08A4A' }
                        : { label: 'VILLAGE WINS', bg: '#1F4E80', border: '#5BA0E5' };
                  return (
                    <View className="my-3 self-stretch items-center px-2">
                      <View
                        className="rounded-2xl px-6 py-5 self-stretch items-center"
                        style={{
                          backgroundColor: banner.bg,
                          borderWidth: 2,
                          borderColor: banner.border,
                        }}
                      >
                        <Text
                          className="text-wolf-text font-extrabold tracking-widest text-center"
                          style={{ fontSize: 26 }}
                        >
                          {banner.label}
                        </Text>
                        <Text
                          className="text-wolf-text text-center"
                          style={{ fontSize: 12, marginTop: 8, opacity: 0.85 }}
                        >
                          Close chat to view end-game information.
                        </Text>
                      </View>
                    </View>
                  );
                }
                if (item.dawnReport) {
                  const dr = item.dawnReport;
                  return (
                    <View className="my-3 self-stretch items-center px-2">
                      <Text className="text-wolf-muted text-[10px] tracking-widest mb-1">
                        MODERATOR
                      </Text>
                      <View
                        className="rounded-xl px-4 py-3 items-center"
                        style={{
                          borderWidth: 1,
                          borderColor: '#D4A017',
                          backgroundColor: '#1A1A24',
                          maxWidth: '92%',
                        }}
                      >
                        <Text
                          className="text-wolf-accent font-bold tracking-widest"
                          style={{ fontSize: 13 }}
                        >
                          DAY {dr.dayLabel}
                        </Text>
                        <View style={{ height: 8 }} />
                        {dr.eliminated.length === 0 ? (
                          <Text
                            className="text-wolf-text font-extrabold text-center"
                            style={{ fontSize: 18, letterSpacing: 0.5 }}
                          >
                            NO ONE HAS BEEN ELIMINATED
                          </Text>
                        ) : (
                          dr.eliminated.map((e: { id: string; name: string }, i: number) => (
                            <Text
                              key={i}
                              className="font-extrabold text-center"
                              style={{
                                fontSize: 18,
                                letterSpacing: 0.5,
                                marginTop: i > 0 ? 4 : 0,
                              }}
                            >
                              <Text style={{ color: colorForPlayer(e.id) }}>
                                {e.name.toUpperCase()}
                              </Text>
                              <Text className="text-wolf-text">
                                {' '}
                                HAS BEEN ELIMINATED
                              </Text>
                            </Text>
                          ))
                        )}
                      </View>
                    </View>
                  );
                }
                // Hunter / Hunter Wolf death-shot: a prominent elimination card
                // (matches the dawn report's big-white treatment so it never
                // reads as a quiet footnote). Both names tinted their chat color.
                if (item.shotReport) {
                  const sr = item.shotReport as {
                    shooter: { id: string; name: string };
                    target: { id: string; name: string };
                  };
                  return (
                    <View className="my-3 self-stretch items-center px-2">
                      <Text className="text-wolf-muted text-[10px] tracking-widest mb-1">
                        MODERATOR
                      </Text>
                      <View
                        className="rounded-xl px-4 py-3 items-center"
                        style={{
                          borderWidth: 1,
                          borderColor: '#D4A017',
                          backgroundColor: '#1A1A24',
                          maxWidth: '92%',
                        }}
                      >
                        <Text
                          className="font-extrabold text-center"
                          style={{ fontSize: 18, letterSpacing: 0.5 }}
                        >
                          <Text style={{ color: colorForPlayer(sr.target.id) }}>
                            {sr.target.name.toUpperCase()}
                          </Text>
                          <Text className="text-wolf-text"> HAS BEEN ELIMINATED</Text>
                        </Text>
                        <Text
                          className="text-wolf-muted text-center"
                          style={{ fontSize: 13, marginTop: 6 }}
                        >
                          <Text className="text-wolf-muted">Shot by </Text>
                          <Text
                            style={{
                              color: colorForPlayer(sr.shooter.id),
                              fontWeight: '700',
                            }}
                          >
                            {sr.shooter.name}
                          </Text>
                        </Text>
                      </View>
                    </View>
                  );
                }
                // Mad Bomber detonation (public death — lynch / Hunter shot):
                // prominent card listing everyone the blast took, attributed to
                // the bomber. Mirrors the shot card's treatment.
                if (item.blastReport) {
                  const br = item.blastReport as {
                    bomber: { id: string; name: string };
                    victims: { id: string; name: string }[];
                  };
                  return (
                    <View className="my-3 self-stretch items-center px-2">
                      <Text className="text-wolf-muted text-[10px] tracking-widest mb-1">
                        MODERATOR
                      </Text>
                      <View
                        className="rounded-xl px-4 py-3 items-center"
                        style={{
                          borderWidth: 1,
                          borderColor: '#D4A017',
                          backgroundColor: '#1A1A24',
                          maxWidth: '92%',
                        }}
                      >
                        <Text
                          className="text-wolf-red font-extrabold tracking-widest"
                          style={{ fontSize: 13, marginBottom: 6 }}
                        >
                          THE BOMB GOES OFF
                        </Text>
                        {br.victims.map((v, i) => (
                          <Text
                            key={v.id}
                            className="font-extrabold text-center"
                            style={{
                              fontSize: 18,
                              letterSpacing: 0.5,
                              marginTop: i > 0 ? 4 : 0,
                            }}
                          >
                            <Text style={{ color: colorForPlayer(v.id) }}>
                              {v.name.toUpperCase()}
                            </Text>
                            <Text className="text-wolf-text"> HAS BEEN ELIMINATED</Text>
                          </Text>
                        ))}
                        <Text
                          className="text-wolf-muted text-center"
                          style={{ fontSize: 13, marginTop: 6 }}
                        >
                          <Text className="text-wolf-muted">Caught in </Text>
                          <Text
                            style={{
                              color: colorForPlayer(br.bomber.id),
                              fontWeight: '700',
                            }}
                          >
                            {br.bomber.name}
                          </Text>
                          <Text className="text-wolf-muted">'s blast</Text>
                        </Text>
                      </View>
                    </View>
                  );
                }
                // Morning roll call: "who's still in the game?" Each name tinted
                // its chat-identity color (matches that player's avatar/messages)
                // so recognition carries over from the rest of the chat.
                if (item.roster) {
                  const roster = item.roster as { id: string; name: string }[];
                  return (
                    <View className="my-3 self-stretch items-center px-2">
                      <Text className="text-wolf-muted text-[10px] tracking-widest mb-1">
                        MODERATOR
                      </Text>
                      <View
                        className="rounded-xl px-5 py-3 items-center"
                        style={{
                          borderWidth: 1,
                          borderColor: '#D4A017',
                          backgroundColor: '#1A1A24',
                          maxWidth: '92%',
                        }}
                      >
                        <Text
                          className="text-wolf-accent font-bold tracking-widest"
                          style={{ fontSize: 13 }}
                        >
                          STILL IN THE GAME ({roster.length})
                        </Text>
                        <View style={{ height: 8 }} />
                        {roster.map((p, i) => (
                          <Text
                            key={p.id}
                            className="font-extrabold text-center"
                            style={{
                              fontSize: 16,
                              letterSpacing: 0.5,
                              marginTop: i > 0 ? 3 : 0,
                              color: colorForPlayer(p.id),
                            }}
                          >
                            {p.name}
                          </Text>
                        ))}
                      </View>
                    </View>
                  );
                }
                // Post-vote tally card: blue LIVES / red DIES boxes listing who
                // voted which way (like the local results screen), with the
                // plain outcome posted as a separate moderator message below.
                if (item.voteResult) {
                  const vr = item.voteResult;
                  return (
                    <View className="my-3 self-stretch items-center px-2">
                      <Text className="text-wolf-muted text-[10px] tracking-widest">
                        VOTE RESULTS
                      </Text>
                      <Text className="text-wolf-text font-bold tracking-widest mb-2">
                        {vr.nomineeName.toUpperCase()}
                      </Text>
                      <View
                        className="flex-row self-stretch"
                        style={{ gap: 10 }}
                      >
                        <View
                          className="flex-1 rounded-xl px-3 py-2"
                          style={{
                            borderWidth: 1,
                            borderColor: '#5BA0E5',
                            backgroundColor: '#16263B',
                          }}
                        >
                          <Text
                            className="text-center font-extrabold tracking-widest mb-1"
                            style={{ color: '#5BA0E5', fontSize: 12 }}
                          >
                            LIVES ({vr.livesVoters.length})
                          </Text>
                          {vr.livesVoters.length === 0 ? (
                            <Text className="text-wolf-muted text-center text-xs">
                              —
                            </Text>
                          ) : (
                            vr.livesVoters.map((n: string, i: number) => (
                              <Text
                                key={i}
                                className="text-wolf-text text-center"
                                style={{ fontSize: 13 }}
                              >
                                {n}
                              </Text>
                            ))
                          )}
                        </View>
                        <View
                          className="flex-1 rounded-xl px-3 py-2"
                          style={{
                            borderWidth: 1,
                            borderColor: '#B03A2E',
                            backgroundColor: '#3A1A16',
                          }}
                        >
                          <Text
                            className="text-center font-extrabold tracking-widest mb-1"
                            style={{ color: '#B03A2E', fontSize: 12 }}
                          >
                            DIES ({vr.diesVoters.length})
                          </Text>
                          {vr.diesVoters.length === 0 ? (
                            <Text className="text-wolf-muted text-center text-xs">
                              —
                            </Text>
                          ) : (
                            vr.diesVoters.map((n: string, i: number) => (
                              <Text
                                key={i}
                                className="text-wolf-text text-center"
                                style={{ fontSize: 13 }}
                              >
                                {n}
                              </Text>
                            ))
                          )}
                        </View>
                      </View>
                    </View>
                  );
                }
                // Engine "moderator" announcement (e.g. the dawn night report):
                // a centered, bold, bordered callout — not a chat bubble.
                if (item.system) {
                  return (
                    <View className="my-3 self-stretch items-center px-2">
                      <Text className="text-wolf-muted text-[10px] tracking-widest mb-1">
                        {item.authorName.toUpperCase()}
                      </Text>
                      <View
                        className="rounded-xl px-4 py-3 items-center"
                        style={{
                          borderWidth: 1,
                          borderColor: '#D4A017',
                          backgroundColor: '#1A1A24',
                          maxWidth: '92%',
                        }}
                      >
                        {item.headline && (
                          <Text
                            className="text-wolf-accent text-center font-bold tracking-widest"
                            style={{
                              fontSize: 13,
                              marginBottom: item.body ? 8 : 0,
                            }}
                          >
                            {renderModeratorBody(item.headline, item.mentions)}
                          </Text>
                        )}
                        {item.body ? (
                          <Text
                            className="text-wolf-text text-center"
                            style={{
                              fontSize: item.headline ? 13 : 14,
                              fontWeight: item.headline ? '400' : '700',
                              lineHeight: 20,
                            }}
                          >
                            {renderModeratorBody(item.body, item.mentions)}
                          </Text>
                        ) : null}
                      </View>
                    </View>
                  );
                }
                const mine = item.authorPlayerId === myPlayerId;
                // My own messages: gold bubble, right-aligned, no avatar — keeps
                // "me vs everyone else" instantly clear.
                if (mine) {
                  // Emoji-only → no bubble, bigger glyphs (Telegram-style).
                  const ec = emojiOnlyCount(item.body ?? '');
                  if (ec > 0) {
                    const fs = emojiFontSize(ec);
                    return (
                      <View className="mb-2 max-w-[82%] self-end pr-1">
                        <Text style={{ fontSize: fs, lineHeight: fs * 1.18 }}>
                          {item.body}
                        </Text>
                      </View>
                    );
                  }
                  return (
                    <View className="mb-2 max-w-[82%] self-end">
                      <View
                        className="rounded-2xl px-3 py-2"
                        style={{ backgroundColor: MY_BUBBLE_BG }}
                      >
                        <Text className="text-wolf-text" style={{ fontSize: 14 }}>
                          {item.body}
                        </Text>
                      </View>
                    </View>
                  );
                }
                // Everyone else: colored initial avatar + colored name so you
                // can tell who's talking at a glance when chat moves fast.
                const color = colorForPlayer(item.authorPlayerId ?? item._id);
                const initial =
                  item.authorName.trim().charAt(0).toUpperCase() || '?';
                return (
                  <View
                    className="flex-row mb-2 max-w-[86%] self-start"
                    style={{ gap: 8 }}
                  >
                    <View
                      style={{
                        width: 34,
                        height: 34,
                        borderRadius: 17,
                        backgroundColor: color,
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <Text
                        style={{
                          color: '#0F0F14',
                          fontWeight: '800',
                          fontSize: 15,
                        }}
                      >
                        {initial}
                      </Text>
                    </View>
                    <View style={{ flexShrink: 1 }}>
                      <Text
                        style={{
                          color,
                          fontSize: 11,
                          fontWeight: '700',
                          marginBottom: 2,
                          marginLeft: 2,
                        }}
                      >
                        {item.authorName}
                      </Text>
                      {(() => {
                        // Emoji-only → no bubble, bigger glyphs (Telegram-style).
                        const ec = emojiOnlyCount(item.body ?? '');
                        if (ec > 0) {
                          const fs = emojiFontSize(ec);
                          return (
                            <Text
                              style={{
                                fontSize: fs,
                                lineHeight: fs * 1.18,
                                alignSelf: 'flex-start',
                                marginLeft: 2,
                              }}
                            >
                              {item.body}
                            </Text>
                          );
                        }
                        return (
                          <View
                            className="rounded-2xl px-3 py-2"
                            style={{
                              alignSelf: 'flex-start',
                              backgroundColor: OTHER_BUBBLE_BG,
                            }}
                          >
                            <Text
                              className="text-wolf-text"
                              style={{ fontSize: 14 }}
                            >
                              {item.body}
                            </Text>
                          </View>
                        );
                      })()}
                    </View>
                  </View>
                );
              }}
            />
            {/* Scroll-to-bottom caret. Appears when scrolled up; staged: first
                tap → unread divider, next tap → newest. Bubble shows how many
                unread wait below (decrements as they scroll into view). */}
            {!atBottom && (
              <TouchableOpacity
                onPress={onCaretPress}
                activeOpacity={0.8}
                style={{
                  position: 'absolute',
                  right: 12,
                  bottom: 12,
                  width: 40,
                  height: 40,
                  borderRadius: 20,
                  backgroundColor: '#22222F',
                  borderWidth: 1,
                  borderColor: '#3A3A48',
                  alignItems: 'center',
                  justifyContent: 'center',
                  elevation: 4,
                  shadowColor: '#000',
                  shadowOpacity: 0.4,
                  shadowRadius: 4,
                  shadowOffset: { width: 0, height: 2 },
                }}
              >
                <Text style={{ color: '#F0EDE8', fontSize: 16, marginTop: -1 }}>
                  ▾
                </Text>
                {read.ready && activeUnread > 0 && (
                  <View
                    style={{
                      position: 'absolute',
                      top: -7,
                      minWidth: 18,
                      height: 18,
                      borderRadius: 9,
                      paddingHorizontal: 5,
                      backgroundColor: '#B03A2E',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Text
                      style={{
                        color: '#F0EDE8',
                        fontSize: 10,
                        fontWeight: '800',
                      }}
                    >
                      {activeUnread > 99 ? '99+' : activeUnread}
                    </Text>
                  </View>
                )}
              </TouchableOpacity>
            )}
          </View>

          {/* Trial countdown (accusation / defense / prevote) sits right above
              the composer so the speaker watches their clock while typing. */}
          {state?.trial && active === 'village' && (
            <TrialBanner trial={state.trial} />
          )}

          {/* Composer or muted reason */}
          {activeMeta?.canPost ? (
            <View
              className="flex-row items-end px-3 py-2 border-t border-wolf-card"
              style={{ gap: 8 }}
            >
              <TextInput
                value={draft}
                onChangeText={setDraft}
                placeholder="Message…"
                placeholderTextColor="#5A5560"
                multiline
                maxLength={1000}
                className="flex-1 bg-wolf-card text-wolf-text rounded-2xl px-4 py-2.5"
                style={{ maxHeight: 100 }}
                onSubmitEditing={handleSend}
                blurOnSubmit={false}
              />
              <TouchableOpacity
                onPress={handleSend}
                disabled={!draft.trim() || sending}
                style={{
                  opacity: !draft.trim() || sending ? 0.4 : 1,
                  backgroundColor: MY_BUBBLE_BG,
                }}
                className="rounded-full px-5 py-2.5"
              >
                <Text className="text-wolf-text font-extrabold tracking-wider">
                  SEND
                </Text>
              </TouchableOpacity>
            </View>
          ) : activeMeta?.lockedReason === null ? null : (
            <View className="px-4 py-3 border-t border-wolf-card">
              <Text className="text-wolf-muted text-center text-sm italic">
                {activeMeta?.lockedReason ?? 'You can only listen here.'}
              </Text>
            </View>
          )}
        </View>
      )}
    </View>
  );
}
