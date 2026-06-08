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

type Channel = 'village' | 'wolves' | 'dead' | 'break';

const CHANNEL_LABEL: Record<Channel, string> = {
  village: 'VILLAGE',
  wolves: 'WOLVES',
  dead: 'GHOSTS',
  break: 'BREAK ROOM',
};

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
  const beginDay = useMutation(api.night.beginDay);
  const pauseDay = useMutation(api.day.pauseDayClock);
  const resumeDay = useMutation(api.day.resumeDayClock);
  const [beginningDay, setBeginningDay] = useState(false);

  const isMorning = state?.phase === 'morning';
  const dayPaused = state?.day?.dayPausedRemainingMs != null;

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

  async function handleBeginDay() {
    if (beginningDay) return;
    setBeginningDay(true);
    try {
      await beginDay({ gameId, callerDeviceClientId: deviceClientId });
    } catch (e) {
      showAlert('Could not begin day', e instanceof Error ? e.message : String(e));
    } finally {
      setBeginningDay(false);
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
              {state?.isHost ? (
                <TouchableOpacity
                  onPress={handleBeginDay}
                  disabled={beginningDay}
                  activeOpacity={0.75}
                  className="bg-wolf-accent rounded-lg px-5 py-1.5"
                  style={{ opacity: beginningDay ? 0.5 : 1 }}
                >
                  <Text className="text-wolf-bg text-xs font-extrabold tracking-widest">
                    {state?.gameOver ? 'VIEW RESULTS' : 'BEGIN DAY'}
                  </Text>
                </TouchableOpacity>
              ) : (
                <Text className="text-wolf-muted text-[11px] font-bold tracking-widest text-center">
                  {state?.gameOver ? 'REVEALING RESULTS…' : 'DAY BEGINS SHORTLY…'}
                </Text>
              )}
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
        <Text className="text-wolf-muted text-base" style={{ marginLeft: 8 }}>
          {expanded ? '▾' : '▴'}
        </Text>
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
                return (
                  <TouchableOpacity
                    key={c.channel}
                    onPress={() => setActive(c.channel as Channel)}
                    className={`rounded-full px-3 py-1.5 ${
                      isActive ? 'bg-wolf-accent' : 'bg-wolf-card'
                    }`}
                  >
                    <Text
                      className={`text-[11px] font-bold tracking-widest ${
                        isActive ? 'text-wolf-bg' : 'text-wolf-muted'
                      }`}
                    >
                      {CHANNEL_LABEL[c.channel as Channel]}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          )}

          {/* Message list (inverted: newest at the bottom). Flexes to fill
              the tall expanded pane between the tabs and the composer. */}
          <View style={{ flex: 1 }}>
            <FlatList
              data={results}
              inverted
              keyExtractor={m => m._id}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 8 }}
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
                // Dawn report card: bold + scannable. Gold "DAY N", then the
                // elimination line big, with any eliminated name tinted its
                // own chat color so it's easy to spot who died.
                // End-of-game: a big, proud WIN banner. The game has already
                // jumped to the end-game screen behind the chat — closing the
                // chat reveals the role logs.
                if (item.winBanner) {
                  const wolf = item.winBanner.winner === 'wolf';
                  return (
                    <View className="my-3 self-stretch items-center px-2">
                      <View
                        className="rounded-2xl px-6 py-5 self-stretch items-center"
                        style={{
                          backgroundColor: wolf ? '#8B1818' : '#1F4E80',
                          borderWidth: 2,
                          borderColor: wolf ? '#B03A2E' : '#5BA0E5',
                        }}
                      >
                        <Text
                          className="text-wolf-text font-extrabold tracking-widest text-center"
                          style={{ fontSize: 26 }}
                        >
                          {wolf ? 'WOLVES WIN' : 'VILLAGE WINS'}
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
                          dr.eliminated.map((e, i) => (
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
                            vr.livesVoters.map((n, i) => (
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
                            vr.diesVoters.map((n, i) => (
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
                            className="text-wolf-text text-center font-extrabold"
                            style={{
                              fontSize: 18,
                              letterSpacing: 0.5,
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
                  return (
                    <View className="mb-2 max-w-[82%] self-end">
                      <View className="rounded-2xl px-3 py-2 bg-wolf-accent">
                        <Text className="text-wolf-bg" style={{ fontSize: 14 }}>
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
                      <View
                        className="rounded-2xl px-3 py-2 bg-wolf-card"
                        style={{ alignSelf: 'flex-start' }}
                      >
                        <Text className="text-wolf-text" style={{ fontSize: 14 }}>
                          {item.body}
                        </Text>
                      </View>
                    </View>
                  </View>
                );
              }}
            />
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
                style={{ opacity: !draft.trim() || sending ? 0.4 : 1 }}
                className="bg-wolf-accent rounded-full px-5 py-2.5"
              >
                <Text className="text-wolf-bg font-extrabold tracking-wider">
                  SEND
                </Text>
              </TouchableOpacity>
            </View>
          ) : (
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
