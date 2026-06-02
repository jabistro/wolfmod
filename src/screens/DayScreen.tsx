import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  SafeAreaView,
  ScrollView,
  Modal,
  Pressable,
  ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { StackNavigationProp } from '@react-navigation/stack';
import { useMutation, useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import type { RootStackParamList } from '../navigation/types';
import { useDeviceId } from '../hooks/useDeviceId';
import { SeatingCircle } from '../components/SeatingCircle';
import TimersConfigModal from '../components/TimersConfigModal';
import BuildModal from '../components/BuildModal';
import { showAlert } from '../components/ThemedAlert';
import { InGameLeaveButton } from '../components/InGameLeaveButton';
import { useGameLeaveHandler } from '../hooks/useGameLeaveHandler';
import { HostMissingBanner } from '../components/HostMissingBanner';
import PassHostPickerModal from '../components/PassHostPickerModal';

type Nav = StackNavigationProp<RootStackParamList, 'Day'>;
type Route = RouteProp<RootStackParamList, 'Day'>;

type Nomination = {
  nominee: { _id: Id<'players'>; name: string } | null;
  subPhase: 'accusation' | 'defense' | 'vote' | 'results';
  subPhaseEndsAt: number;
  subPhasePausedRemainingMs: number | null;
  resultsRevealed: boolean;
  votedCount: number;
  eligibleCount: number;
  livesVoters: string[];
  diesVoters: string[];
  myVote: 'lives' | 'dies' | null;
  iAmNominee: boolean;
  accuser: { _id: Id<'players'>; name: string } | null;
  seconder: { _id: Id<'players'>; name: string } | null;
};

type NomTap = {
  targetPlayerId: Id<'players'>;
  nominatorPlayerId: Id<'players'>;
  nominatorName: string;
  isMe: boolean;
  createdAt: number;
};

type PendingTrial = {
  target: { _id: Id<'players'>; name: string };
  accuser: { _id: Id<'players'>; name: string } | null;
  seconder: { _id: Id<'players'>; name: string } | null;
  dwellEndsAt: number;
};

type DayGame = {
  _id: Id<'games'>;
  roomCode: string;
  phase: string;
  dayNumber: number;
  nightNumber: number;
  winner: 'village' | 'wolf' | undefined;
  playerCount: number;
  selectedRoles: string[];
  voteDwellEndsAt: number | null;
  pendingTriggerCount: number;
  dayEndsAt: number | null;
  dayPausedRemainingMs: number | null;
  nominationsUsed: number;
  nominationsRemaining: number;
  maxNominationsPerDay: number;
  config: {
    dayDurationSec: number;
    accusationSec: number;
    defenseSec: number;
    voteTimerSec: number;
    maxNominationsPerDay: number;
    wolfPickerSec: number;
  };
};

// Small attribution line shown under the nominee name on the Trial /
// Vote screens. Surfaces who pushed the highlight tap and who tipped it
// into a trial — important strategic info (a wolf railroading a trial
// looks different from a villager calling out a known wolf). Renders
// nothing when both fields are absent (legacy in-flight rows from before
// the player-driven flow).
function AccusationCredit({ nomination }: { nomination: Nomination }) {
  if (!nomination.accuser && !nomination.seconder) return null;
  return (
    <Text className="text-wolf-muted text-xs tracking-widest text-center mt-1">
      ACCUSED BY {(nomination.accuser?.name ?? '???').toUpperCase()}
      {nomination.seconder
        ? ` · SECONDED BY ${nomination.seconder.name.toUpperCase()}`
        : ''}
    </Text>
  );
}

// Two-block row matching TrialStatusBar's visual rhythm: ACCUSED / name
// on the left, SECONDED / name on the right. If only one is present
// (e.g. a host-forced nomination), that block renders alone and stretches.
// The name preserves the user-typed casing (matches the seat-ring labels)
// and uses flexShrink + minWidth: 0 so it ellipsizes inside the block
// instead of spilling past the right edge.
//
// If the local viewer's id matches the accuser or seconder, that block
// gets a gold border + gold label — self-identification cue for tables
// with duplicate first names ("Christopher C" vs another Christopher).
// Renders gold only on the matching player's own phone; everyone else
// sees the plain card treatment.
function AccusationStatusBar({
  nomination,
  meId,
}: {
  nomination: Nomination;
  meId: Id<'players'>;
}) {
  if (!nomination.accuser && !nomination.seconder) return null;
  const isMyAccusation = nomination.accuser?._id === meId;
  const isMySecond = nomination.seconder?._id === meId;
  const accent = '#D4A017';
  return (
    <View className="mx-4 mb-2 flex-row" style={{ gap: 10 }}>
      {nomination.accuser && (
        <View
          className="flex-1 bg-wolf-card rounded-xl flex-row items-center"
          style={{
            paddingVertical: 8,
            paddingHorizontal: 14,
            gap: 10,
            borderWidth: 1,
            borderColor: isMyAccusation ? accent : 'transparent',
          }}
        >
          <Text
            className="text-xs tracking-widest"
            style={{ color: isMyAccusation ? accent : '#8A8590' }}
          >
            ACCUSED
          </Text>
          <Text
            className="text-wolf-text text-right"
            style={{ fontSize: 14, fontWeight: '600', flexShrink: 1, minWidth: 0, flex: 1 }}
            numberOfLines={1}
            ellipsizeMode="tail"
          >
            {nomination.accuser.name}
          </Text>
        </View>
      )}
      {nomination.seconder && (
        <View
          className="flex-1 bg-wolf-card rounded-xl flex-row items-center"
          style={{
            paddingVertical: 8,
            paddingHorizontal: 14,
            gap: 10,
            borderWidth: 1,
            borderColor: isMySecond ? accent : 'transparent',
          }}
        >
          <Text
            className="text-xs tracking-widest"
            style={{ color: isMySecond ? accent : '#8A8590' }}
          >
            SECONDED
          </Text>
          <Text
            className="text-wolf-text text-right"
            style={{ fontSize: 14, fontWeight: '600', flexShrink: 1, minWidth: 0, flex: 1 }}
            numberOfLines={1}
            ellipsizeMode="tail"
          >
            {nomination.seconder.name}
          </Text>
        </View>
      )}
    </View>
  );
}

function formatTime(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

// Returns a fresh `Date.now()` on every render while a ticking interval forces
// re-renders. Reading `Date.now()` inline (rather than from state) avoids a
// stale-now bug: when a Convex query pushes a fresh `dayEndsAt` between ticks,
// the component re-renders before the interval has updated state — so a
// state-cached `now` would be a few hundred ms behind, making `endsAt - now`
// larger than the true remaining and `Math.ceil` round up to `duration + 1`
// for one frame. That presented as the timer ticking UP before counting down.
function useNow(intervalMs = 200): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick(n => (n + 1) % 1_000_000), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return Date.now();
}

// Day-clock remaining ms (respects pause). Clamped at the configured max so
// client/server clock skew can't produce a "tick up" on first arrival —
// without the clamp, a client clock behind the server's makes `endsAt - now`
// exceed the duration, and `Math.ceil` in `formatTime` rounds up to one
// second over the configured value for the first frame.
function dayRemainingMs(game: DayGame, now: number): number {
  if (game.dayPausedRemainingMs !== null) return game.dayPausedRemainingMs;
  if (game.dayEndsAt === null) return 0;
  const maxMs = game.config.dayDurationSec * 1000;
  return Math.max(0, Math.min(maxMs, game.dayEndsAt - now));
}

// Trial-clock remaining ms (respects pause). Same skew-clamp as above; cap
// is the per-subphase configured duration.
function trialRemainingMs(
  nom: Nomination,
  game: DayGame,
  now: number,
): number {
  if (nom.subPhasePausedRemainingMs !== null) return nom.subPhasePausedRemainingMs;
  const maxMs =
    nom.subPhase === 'accusation'
      ? game.config.accusationSec * 1000
      : nom.subPhase === 'defense'
        ? game.config.defenseSec * 1000
        : nom.subPhase === 'vote'
          ? game.config.voteTimerSec * 1000
          : Infinity;
  return Math.max(0, Math.min(maxMs, nom.subPhaseEndsAt - now));
}

export default function DayScreen() {
  const navigation = useNavigation<Nav>();
  const { params } = useRoute<Route>();
  const deviceClientId = useDeviceId();

  const view = useQuery(
    api.day.dayView,
    deviceClientId
      ? { gameId: params.gameId as Id<'games'>, deviceClientId }
      : 'skip',
  );

  const beginNight = useMutation(api.night.beginNight);

  const phase = view?.game.phase;
  useEffect(() => {
    if (phase === 'night') {
      navigation.replace('Night', { gameId: params.gameId });
    } else if (phase === 'morning') {
      navigation.replace('Morning', { gameId: params.gameId });
    } else if (phase === 'triggers') {
      navigation.replace('Triggers', { gameId: params.gameId });
    } else if (phase === 'ended') {
      navigation.replace('EndGame', { gameId: params.gameId });
    }
  }, [phase, navigation, params.gameId]);

  const [passPickerOpen, setPassPickerOpen] = useState(false);

  const { confirmLeave } = useGameLeaveHandler({
    gameId: params.gameId as Id<'games'>,
    deviceClientId,
    isHost: view?.me.isHost,
    onPassHostFirst: view?.me.isHost
      ? () => setPassPickerOpen(true)
      : undefined,
  });

  if (!deviceClientId || view === undefined) {
    return (
      <SafeAreaView className="flex-1 bg-wolf-bg items-center justify-center">
        <ActivityIndicator color="#D4A017" />
      </SafeAreaView>
    );
  }
  if (view === null) {
    return (
      <SafeAreaView className="flex-1 bg-wolf-bg items-center justify-center px-8">
        <Text className="text-wolf-text text-lg text-center">
          This game no longer exists.
        </Text>
      </SafeAreaView>
    );
  }

  const { game, me, alive, players, currentNomination, nomTaps, pendingTrial } = view;
  const isHost = me.isHost;
  const hostMissing = view.hostMissing;
  const passHostCandidates = isHost
    ? players
        .filter(p => p._id !== me._id && !/^Bot \d+$/.test(p.name))
        .map(p => ({ _id: p._id, name: p.name }))
    : undefined;

  const passPicker = passHostCandidates ? (
    <PassHostPickerModal
      visible={passPickerOpen}
      onClose={() => setPassPickerOpen(false)}
      gameId={game._id}
      deviceClientId={deviceClientId}
      candidates={passHostCandidates}
    />
  ) : null;

  if (currentNomination) {
    const sp = currentNomination.subPhase;
    if (sp === 'results' || currentNomination.resultsRevealed) {
      return (
        <>
          <ResultsView
            game={game}
            deviceClientId={deviceClientId}
            isHost={isHost}
            nomination={currentNomination}
            cascadeDeaths={view.cascadeDeaths}
            onLeavePress={confirmLeave}
            hostMissing={hostMissing}
            meAlive={me.alive}
            passHostCandidates={passHostCandidates}
          />
          {passPicker}
        </>
      );
    }
    if (sp === 'vote') {
      return (
        <>
          <VoteView
            game={game}
            deviceClientId={deviceClientId}
            meAlive={me.alive}
            isHost={isHost}
            nomination={currentNomination}
            onLeavePress={confirmLeave}
            hostMissing={hostMissing}
            passHostCandidates={passHostCandidates}
          />
          {passPicker}
        </>
      );
    }
    return (
      <>
        <TrialView
          game={game}
          deviceClientId={deviceClientId}
          isHost={isHost}
          meId={me._id}
          nomination={currentNomination}
          onLeavePress={confirmLeave}
          hostMissing={hostMissing}
          meAlive={me.alive}
          passHostCandidates={passHostCandidates}
        />
        {passPicker}
      </>
    );
  }

  return (
    <>
    <DiscussionView
      game={game}
      deviceClientId={deviceClientId}
      isHost={isHost}
      meAlive={me.alive}
      meId={me._id}
      meSeatPosition={me.seatPosition}
      alive={alive}
      players={players}
      nomTaps={nomTaps}
      pendingTrial={pendingTrial}
      onLeavePress={confirmLeave}
      hostMissing={hostMissing}
      passHostCandidates={passHostCandidates}
      onBeginNight={async () => {
        try {
          await beginNight({
            gameId: game._id,
            callerDeviceClientId: deviceClientId,
          });
        } catch (e) {
          showAlert(
            'Could not begin night',
            e instanceof Error ? e.message : String(e),
          );
        }
      }}
    />
    {passPicker}
    </>
  );
}

// ───── Trial status bar ────────────────────────────────────────────────────
//
// Two-cell strip shown above the trial / vote / results focal content:
// paused day-clock remaining on the left, nominations remaining on the
// right. Visible to ALL phones so the table knows how much trial budget
// is left at a glance.

function TrialStatusBar({
  dayRemMs,
  nominationsRemaining,
  maxNominationsPerDay,
}: {
  dayRemMs: number;
  nominationsRemaining: number;
  maxNominationsPerDay: number;
}) {
  return (
    <View className="mx-4 mb-4 flex-row" style={{ gap: 10 }}>
      <View
        className="flex-1 bg-wolf-card rounded-xl flex-row items-center justify-between"
        style={{ paddingVertical: 8, paddingHorizontal: 14 }}
      >
        <Text className="text-wolf-muted text-xs tracking-widest">
          TIME REMAINING
        </Text>
        <Text
          className="text-wolf-muted"
          style={{ fontSize: 18, fontWeight: '600', fontVariant: ['tabular-nums'] }}
        >
          {formatTime(dayRemMs)}
        </Text>
      </View>
      <View
        className="bg-wolf-card rounded-xl flex-row items-center"
        style={{ paddingVertical: 8, paddingHorizontal: 14, gap: 10 }}
      >
        <Text className="text-wolf-muted text-xs tracking-widest">
          NOMS LEFT
        </Text>
        <Text
          className="text-wolf-muted"
          style={{ fontSize: 18, fontWeight: '600', fontVariant: ['tabular-nums'] }}
        >
          {nominationsRemaining}/{maxNominationsPerDay}
        </Text>
      </View>
    </View>
  );
}

// ───── Header ──────────────────────────────────────────────────────────────

function DayHeader({
  dayNumber,
  mode,
  roomCode,
  onLeavePress,
}: {
  dayNumber: number;
  mode: string;
  roomCode: string;
  onLeavePress?: () => void;
}) {
  return (
    <View className="px-4 pt-10 pb-3" style={{ position: 'relative' }}>
      <View className="items-center">
        <Text className="text-wolf-muted text-lg font-bold tracking-widest">
          DAY {dayNumber}
        </Text>
        <Text className="text-wolf-accent text-3xl font-extrabold tracking-widest mt-1">
          {mode}
        </Text>
      </View>
      {onLeavePress && <InGameLeaveButton onPress={onLeavePress} />}
      <View
        style={{
          position: 'absolute',
          right: 12,
          top: 40,
          alignItems: 'flex-end',
          zIndex: 10,
        }}
      >
        <Text
          style={{
            color: '#8A8590',
            fontSize: 10,
            fontWeight: '700',
            letterSpacing: 2,
          }}
        >
          ROOM
        </Text>
        <Text
          style={{
            color: '#D4A017',
            fontSize: 16,
            fontWeight: '800',
            letterSpacing: 3,
            marginTop: 1,
          }}
        >
          {roomCode}
        </Text>
      </View>
    </View>
  );
}

// ───── Day action row ──────────────────────────────────────────────────────
//
// Sits below the day timer on every day sub-screen. Three equal columns —
// left (DiscussionView passes "N ALIVE"), center (NOMS LEFT), right (BUILD).
// The host's settings cog lives on its own row beneath this one via
// DayCogRow so the cog stays at the far left without crowding the stats.

function DayActionRow({
  left,
  center,
  showBuild,
  onBuildPress,
}: {
  left?: React.ReactNode;
  center?: React.ReactNode;
  showBuild?: boolean;
  onBuildPress?: () => void;
}) {
  return (
    <View
      className="flex-row items-center mb-2"
      style={{ paddingHorizontal: 16, minHeight: 36 }}
    >
      <View style={{ flex: 1, alignItems: 'flex-start' }}>{left}</View>
      <View style={{ flex: 1, alignItems: 'center' }}>{center}</View>
      <View style={{ flex: 1, alignItems: 'flex-end' }}>
        {showBuild && (
          <TouchableOpacity
            onPress={onBuildPress}
            hitSlop={8}
            style={{ padding: 4 }}
          >
            <Text
              style={{
                color: '#8A8590',
                fontSize: 15,
                fontWeight: '700',
                letterSpacing: 2,
              }}
            >
              BUILD
            </Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

// ───── Day cog row ─────────────────────────────────────────────────────────
//
// Host-only settings cog, far-left, on its own row directly below
// DayActionRow. Kept separate so the stats row can stay symmetrical.

function DayCogRow({
  onPress,
  nomArmed,
  onNomToggle,
  nomDisabled,
}: {
  onPress: () => void;
  /** If set, render a NOM toggle next to the cog (host-only override that
   *  bypasses the 2-tap requirement). Omit on non-discussion views. */
  onNomToggle?: () => void;
  nomArmed?: boolean;
  /** Disable the NOM toggle visually (e.g. day over / noms exhausted). */
  nomDisabled?: boolean;
}) {
  return (
    <View
      className="mb-2 flex-row items-center"
      style={{ paddingHorizontal: 16, gap: 14 }}
    >
      <TouchableOpacity onPress={onPress} hitSlop={8} style={{ padding: 4 }}>
        <Text style={{ color: '#8A8590', fontSize: 26 }}>⚙</Text>
      </TouchableOpacity>
      {onNomToggle && (
        <TouchableOpacity
          onPress={onNomToggle}
          disabled={nomDisabled}
          hitSlop={6}
          style={{
            paddingHorizontal: 12,
            paddingVertical: 6,
            borderRadius: 8,
            backgroundColor: nomArmed ? '#D4A017' : 'transparent',
            borderWidth: 1,
            borderColor: nomArmed ? '#D4A017' : '#3A3A48',
            opacity: nomDisabled ? 0.35 : 1,
          }}
        >
          <Text
            style={{
              color: nomArmed ? '#0F0F14' : '#8A8590',
              fontSize: 14,
              fontWeight: '800',
              letterSpacing: 2,
            }}
          >
            NOM
          </Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

// ───── Day clock bar (above seating circle in DiscussionView) ──────────────

function DayClockBar({
  game,
  isHost,
  deviceClientId,
  dayOver,
}: {
  game: DayGame;
  isHost: boolean;
  deviceClientId: string;
  dayOver: boolean;
}) {
  const now = useNow();
  const pauseDay = useMutation(api.day.pauseDayClock);
  const resumeDay = useMutation(api.day.resumeDayClock);
  const resetDay = useMutation(api.day.resetDayClock);
  const [busy, setBusy] = useState<'toggle' | 'reset' | null>(null);

  const paused = game.dayPausedRemainingMs !== null;
  const remaining = dayRemainingMs(game, now);
  const color = dayOver
    ? '#B03A2E'
    : remaining <= 10000
      ? '#D4A017'
      : '#F0EDE8';

  async function toggle() {
    if (dayOver) return;
    setBusy('toggle');
    try {
      if (paused) {
        await resumeDay({ gameId: game._id, callerDeviceClientId: deviceClientId });
      } else {
        await pauseDay({ gameId: game._id, callerDeviceClientId: deviceClientId });
      }
    } catch (e) {
      showAlert('Error', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }
  async function reset() {
    setBusy('reset');
    try {
      await resetDay({ gameId: game._id, callerDeviceClientId: deviceClientId });
    } catch (e) {
      showAlert('Error', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const showHostButtons = isHost && !dayOver;

  return (
    <View
      className="mx-4 mb-3 bg-wolf-card rounded-xl flex-row items-center"
      style={{ paddingVertical: 12, paddingHorizontal: 16 }}
    >
      <View style={{ width: 52, alignItems: 'flex-start' }}>
        {showHostButtons && (
          <TouchableOpacity
            onPress={toggle}
            disabled={busy !== null}
            className="bg-wolf-surface rounded-full items-center justify-center"
            style={{ width: 52, height: 52, opacity: busy === 'toggle' ? 0.4 : 1 }}
          >
            {paused ? (
              <Text className="text-wolf-text" style={{ fontSize: 20 }}>▶</Text>
            ) : (
              <View className="flex-row" style={{ gap: 4 }}>
                <View style={{ width: 5, height: 18, backgroundColor: '#F0EDE8', borderRadius: 1 }} />
                <View style={{ width: 5, height: 18, backgroundColor: '#F0EDE8', borderRadius: 1 }} />
              </View>
            )}
          </TouchableOpacity>
        )}
      </View>
      <View className="flex-1 items-center">
        {(dayOver || paused) && (
          <Text className="text-wolf-muted text-xs tracking-widest">
            {dayOver ? 'TIME UP' : 'PAUSED'}
          </Text>
        )}
        <Text
          className="font-extrabold"
          style={{
            color,
            fontSize: 40,
            fontVariant: ['tabular-nums'],
            marginTop: 2,
          }}
        >
          {formatTime(remaining)}
        </Text>
      </View>
      <View style={{ width: 52, alignItems: 'flex-end' }}>
        {showHostButtons && (
          <TouchableOpacity
            onPress={reset}
            disabled={busy !== null}
            className="bg-wolf-surface rounded-full items-center justify-center"
            style={{ width: 52, height: 52, opacity: busy === 'reset' ? 0.4 : 1 }}
          >
            <Text
              className="text-wolf-text"
              style={{
                fontSize: 22,
                lineHeight: 22,
                marginTop: -2,
                includeFontPadding: false,
              }}
            >
              ↺
            </Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

// ───── Discussion view ─────────────────────────────────────────────────────

function DiscussionView({
  game,
  deviceClientId,
  isHost,
  meAlive,
  meId,
  meSeatPosition,
  alive,
  players,
  nomTaps,
  pendingTrial,
  onBeginNight,
  onLeavePress,
  hostMissing,
  passHostCandidates,
}: {
  game: DayGame;
  deviceClientId: string;
  isHost: boolean;
  meAlive: boolean;
  meId: Id<'players'>;
  meSeatPosition?: number;
  alive: Array<{ _id: Id<'players'>; name: string; seatPosition?: number }>;
  players: Array<{
    _id: Id<'players'>;
    name: string;
    seatPosition?: number;
    alive: boolean;
  }>;
  nomTaps: NomTap[];
  pendingTrial: PendingTrial | null;
  onBeginNight: () => Promise<void>;
  onLeavePress: () => void;
  hostMissing: boolean;
  passHostCandidates?: Array<{ _id: Id<'players'>; name: string }>;
}) {
  const insets = useSafeAreaInsets();
  const now = useNow();
  const toggleNomTap = useMutation(api.day.toggleNomTap);
  const hostForceNominate = useMutation(api.day.hostForceNominate);
  const [cogOpen, setCogOpen] = useState(false);
  const [buildOpen, setBuildOpen] = useState(false);
  // Host override: when armed, the host's next seat tap fires a trial
  // directly (bypasses the 2-tap consensus). Solo-test escape hatch. The
  // toggle is silent — other phones see only the resulting trial, with
  // the host as accuser and no seconder. Tapping NOM again disarms.
  const [nomArmed, setNomArmed] = useState(false);

  const dayRemMs = dayRemainingMs(game, now);
  const dayExpired = dayRemMs <= 0;
  const noNomsLeft = game.nominationsRemaining <= 0;
  const dayOver = dayExpired || noNomsLeft;
  // While a pending-trial dwell is in flight, the seat fill animation is
  // running on every phone and the screen is about to switch to the trial
  // view — freeze nominations, taps, NOM button, and BEGIN NIGHT until
  // the server promotes the dwell into a real currentNomination.
  const pending = pendingTrial !== null;

  // When the day closes mid-armed (e.g. last nom consumed by another path)
  // or a pending trial starts, drop the armed state so the highlighted
  // button doesn't look stuck.
  useEffect(() => {
    if ((dayOver || pending) && nomArmed) setNomArmed(false);
  }, [dayOver, pending, nomArmed]);

  // Tap rejection lands here when the server's "no noms left / day expired
  // / target dead / target is self" gates fire. Surface as a themed alert
  // so a stray tap doesn't silently no-op.
  async function handleSeatPress(p: { _id: Id<'players'>; alive?: boolean }) {
    if (dayOver) return; // client-side disabled below; belt + braces
    if (p.alive === false) return;
    if (p._id === meId) return;

    // Host force-nominate path. Allowed even when the host is dead, since
    // the host can keep moderating after elimination.
    if (nomArmed && isHost) {
      try {
        await hostForceNominate({
          gameId: game._id,
          callerDeviceClientId: deviceClientId,
          targetPlayerId: p._id,
        });
      } catch (e) {
        showAlert(
          'Could not nominate',
          e instanceof Error ? e.message : String(e),
        );
      } finally {
        setNomArmed(false);
      }
      return;
    }

    // Regular player-tap path. Dead spectators can't tap.
    if (!meAlive) return;
    try {
      await toggleNomTap({
        gameId: game._id,
        callerDeviceClientId: deviceClientId,
        targetPlayerId: p._id,
      });
    } catch (e) {
      showAlert(
        'Could not nominate',
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  // Selectable = alive, non-self, day still open, no pending dwell, and
  // the viewer can act. Dead spectators can normally not tap — but when
  // the (possibly-dead) host has the NOM override armed, the ring opens
  // up for them too.
  const canTap = !dayOver && !pending && (meAlive || (isHost && nomArmed));
  const selectableIds: ReadonlySet<string> | undefined = canTap
    ? new Set(
        alive
          .filter(p => p._id !== meId)
          .map(p => p._id as unknown as string),
      )
    : undefined;

  return (
    <SafeAreaView className="flex-1 bg-wolf-bg">
      <DayHeader
        dayNumber={game.dayNumber}
        mode="DISCUSSION"
        roomCode={game.roomCode}
        onLeavePress={onLeavePress}
      />

      {hostMissing && (
        <HostMissingBanner
          gameId={game._id}
          deviceClientId={deviceClientId}
        />
      )}

      <DayClockBar
        game={game}
        isHost={isHost}
        deviceClientId={deviceClientId}
        dayOver={dayOver}
      />

      <DayActionRow
        left={
          <Text
            className="text-wolf-muted font-bold tracking-widest"
            style={{ fontSize: 14 }}
          >
            {alive.length} ALIVE
          </Text>
        }
        center={
          <Text
            className="text-wolf-muted font-bold tracking-widest"
            style={{ fontSize: 14 }}
          >
            NOMS LEFT: {game.nominationsRemaining}/{game.maxNominationsPerDay}
          </Text>
        }
        showBuild
        onBuildPress={() => setBuildOpen(true)}
      />
      {isHost && (
        <DayCogRow
          onPress={() => setCogOpen(true)}
          nomArmed={nomArmed}
          nomDisabled={dayOver || pending}
          onNomToggle={() => setNomArmed(a => !a)}
        />
      )}

      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24, alignItems: 'center' }}>
        <SeatingCircle
          totalSeats={game.playerCount}
          players={players}
          meId={meId}
          viewerSeatIndex={meSeatPosition}
          selectableIds={selectableIds}
          nomTaps={
            pending
              ? []
              : nomTaps.map(t => ({
                  targetPlayerId: t.targetPlayerId as unknown as string,
                  nominatorName: t.nominatorName,
                  isMe: t.isMe,
                }))
          }
          pendingTrialTargetId={pendingTrial?.target._id ?? null}
          // Pass the absolute server deadline so the animation duration is
          // computed once at effect-start time. Passing a derived `now`-
          // dependent ms here causes the effect to re-fire every tick →
          // setValue(0) flashes mid-fill.
          pendingTrialDwellEndsAt={pendingTrial?.dwellEndsAt ?? null}
          onPress={canTap ? handleSeatPress : undefined}
        />
        {pendingTrial ? (
          <View className="mt-6 items-center">
            <Text className="text-wolf-accent text-2xl font-extrabold tracking-widest text-center">
              {pendingTrial.target.name.toUpperCase()}
            </Text>
            <Text className="text-wolf-muted text-xs tracking-widest text-center mt-1">
              IS ON THE STAND
            </Text>
            <Text className="text-wolf-muted text-xs tracking-widest text-center mt-3">
              ACCUSED BY {(pendingTrial.accuser?.name ?? '???').toUpperCase()}
              {pendingTrial.seconder
                ? ` · SECONDED BY ${pendingTrial.seconder.name.toUpperCase()}`
                : ''}
            </Text>
          </View>
        ) : dayOver ? (
          <View
            className="mt-6 rounded-xl px-5 py-4"
            style={{ borderWidth: 1, borderColor: '#3A3A48', backgroundColor: '#1A1A24' }}
          >
            <Text className="text-wolf-accent text-sm font-extrabold tracking-widest text-center">
              {dayExpired && noNomsLeft
                ? 'DAY OVER — TIME AND NOMINATIONS UP'
                : dayExpired
                  ? 'DAY OVER — TIME IS UP'
                  : 'DAY OVER — NO NOMINATIONS LEFT'}
            </Text>
            <Text className="text-wolf-muted text-xs text-center mt-1">
              {isHost
                ? 'Tap BEGIN NIGHT when the table is ready.'
                : 'Waiting for the host to begin night.'}
            </Text>
          </View>
        ) : nomArmed && isHost ? (
          <Text className="text-wolf-accent text-xs text-center mt-4 font-bold tracking-widest">
            HOST OVERRIDE — TAP A PLAYER TO PUT THEM ON TRIAL
          </Text>
        ) : meAlive ? (
          <Text className="text-wolf-muted text-xs text-center mt-4">
            Tap a player to nominate them. A second tap by anyone puts them
            on trial.
          </Text>
        ) : null}
        {!pendingTrial && !meAlive && !(nomArmed && isHost) && (
          <Text className="text-wolf-muted text-xs text-center mt-4 italic">
            You are out of the game — spectating.
          </Text>
        )}
      </ScrollView>

      {isHost && !pending && (
        <View
          style={{
            paddingHorizontal: 24,
            paddingBottom: Math.max(insets.bottom, 16) + 16,
          }}
        >
          <TouchableOpacity
            onPress={onBeginNight}
            className="bg-wolf-accent rounded-xl py-4 items-center"
            activeOpacity={0.75}
          >
            <Text className="text-wolf-bg text-base font-extrabold tracking-widest">
              BEGIN NIGHT
            </Text>
          </TouchableOpacity>
        </View>
      )}

      {!isHost && !pending && (
        <View
          style={{
            paddingHorizontal: 24,
            paddingBottom: Math.max(insets.bottom, 16) + 16,
          }}
        >
          <Text className="text-wolf-muted text-xs tracking-widest text-center">
            HOST CONTROLS THE FLOOR
          </Text>
        </View>
      )}

      <TimersConfigModal
        visible={cogOpen}
        onClose={() => setCogOpen(false)}
        gameId={game._id}
        deviceClientId={deviceClientId}
        initial={game.config}
        passHostCandidates={passHostCandidates}
        roomCode={game.roomCode}
        canEndGame
      />

      <BuildModal
        visible={buildOpen}
        onClose={() => setBuildOpen(false)}
        selectedRoles={game.selectedRoles}
      />
    </SafeAreaView>
  );
}

// ───── Trial view (accusation / defense) ───────────────────────────────────

function TrialView({
  game,
  deviceClientId,
  isHost,
  meId,
  nomination,
  onLeavePress,
  hostMissing,
  meAlive,
  passHostCandidates,
}: {
  game: DayGame;
  deviceClientId: string;
  isHost: boolean;
  meId: Id<'players'>;
  nomination: Nomination;
  onLeavePress: () => void;
  hostMissing: boolean;
  meAlive: boolean;
  passHostCandidates?: Array<{ _id: Id<'players'>; name: string }>;
}) {
  const insets = useSafeAreaInsets();
  const now = useNow();
  const startClock = useMutation(api.day.startTrialClock);
  const pauseClock = useMutation(api.day.pauseTrialClock);
  const resetClock = useMutation(api.day.resetTrialClock);
  const endAccusation = useMutation(api.day.endAccusation);
  const endDefense = useMutation(api.day.endDefense);
  const cancelNomination = useMutation(api.day.cancelNomination);
  const [busy, setBusy] = useState<'toggle' | 'reset' | 'advance' | 'cancel' | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cogOpen, setCogOpen] = useState(false);
  const [buildOpen, setBuildOpen] = useState(false);

  const isAccusation = nomination.subPhase === 'accusation';
  const phaseLabel = isAccusation ? 'ACCUSATION' : 'DEFENSE';
  const remaining = trialRemainingMs(nomination, game, now);
  const paused = nomination.subPhasePausedRemainingMs !== null;
  const expired = !paused && remaining <= 0;
  const color = expired ? '#B03A2E' : '#F0EDE8';

  async function toggleClock() {
    if (!isHost) return;
    setBusy('toggle');
    try {
      if (paused) {
        await startClock({ gameId: game._id, callerDeviceClientId: deviceClientId });
      } else {
        await pauseClock({ gameId: game._id, callerDeviceClientId: deviceClientId });
      }
    } catch (e) {
      showAlert('Error', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }
  async function reset() {
    setBusy('reset');
    try {
      await resetClock({ gameId: game._id, callerDeviceClientId: deviceClientId });
    } catch (e) {
      showAlert('Error', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }
  async function advance() {
    setBusy('advance');
    try {
      if (isAccusation) {
        await endAccusation({
          gameId: game._id,
          callerDeviceClientId: deviceClientId,
        });
      } else {
        await endDefense({
          gameId: game._id,
          callerDeviceClientId: deviceClientId,
        });
      }
    } catch (e) {
      showAlert('Error', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }
  async function confirmCancelNomination() {
    setBusy('cancel');
    try {
      await cancelNomination({
        gameId: game._id,
        callerDeviceClientId: deviceClientId,
      });
      setCancelOpen(false);
    } catch (e) {
      showAlert('Could not cancel', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  // Paused day clock display (small, top of screen).
  const dayRemMs = dayRemainingMs(game, now);

  return (
    <SafeAreaView className="flex-1 bg-wolf-bg">
      <DayHeader
        dayNumber={game.dayNumber}
        mode="ON TRIAL"
        roomCode={game.roomCode}
        onLeavePress={onLeavePress}
      />

      {hostMissing && (
        <HostMissingBanner
          gameId={game._id}
          deviceClientId={deviceClientId}
        />
      )}

      <View className="items-center mb-3">
        <Text className="text-wolf-text text-3xl font-extrabold tracking-widest">
          {nomination.nominee?.name.toUpperCase() ?? '—'}
        </Text>
      </View>

      <AccusationStatusBar nomination={nomination} meId={meId} />

      <TrialStatusBar
        dayRemMs={dayRemMs}
        nominationsRemaining={game.nominationsRemaining}
        maxNominationsPerDay={game.maxNominationsPerDay}
      />

      <DayActionRow showBuild onBuildPress={() => setBuildOpen(true)} />
      {isHost && <DayCogRow onPress={() => setCogOpen(true)} />}

      <Pressable
        onPress={isHost ? toggleClock : undefined}
        className="flex-1 items-center justify-center px-6"
      >
        <Text className="text-wolf-muted text-xs font-bold tracking-widest">
          {phaseLabel}
        </Text>
        {isHost && (
          <Text className="text-wolf-muted text-xs tracking-widest mt-1">
            {paused
              ? remaining === (isAccusation ? game.config.accusationSec : game.config.defenseSec) * 1000
                ? 'TAP TO START'
                : 'TAP TO RESUME'
              : 'TAP TO PAUSE'}
          </Text>
        )}
        <Text
          className="font-extrabold"
          style={{
            color,
            fontSize: 100,
            fontVariant: ['tabular-nums'],
            marginTop: 12,
          }}
        >
          {formatTime(remaining)}
        </Text>
        {isHost && (
          <TouchableOpacity
            onPress={reset}
            disabled={busy !== null}
            style={{ marginTop: 22, opacity: busy === 'reset' ? 0.4 : 1 }}
            className="bg-wolf-card rounded-full items-center justify-center"
          >
            <View
              style={{
                width: 48,
                height: 48,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text
                className="text-wolf-text text-xl"
                style={{ lineHeight: 20, marginTop: -3, includeFontPadding: false }}
              >
                ↺
              </Text>
            </View>
          </TouchableOpacity>
        )}
      </Pressable>

      <View
        style={{
          paddingHorizontal: 24,
          paddingBottom: Math.max(insets.bottom, 16) + 16,
        }}
      >
        {isHost ? (
          <>
            <TouchableOpacity
              onPress={advance}
              disabled={busy !== null}
              style={{ opacity: busy === 'advance' ? 0.4 : 1 }}
              className="bg-wolf-accent rounded-xl py-5 items-center"
            >
              {busy === 'advance' ? (
                <ActivityIndicator color="#0F0F14" />
              ) : (
                <Text className="text-wolf-bg text-lg font-extrabold tracking-widest">
                  {isAccusation ? 'END ACCUSATION' : 'END DEFENSE'}
                </Text>
              )}
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => setCancelOpen(true)}
              disabled={busy !== null}
              className="py-3 mt-1"
            >
              <Text className="text-wolf-muted text-xs tracking-widest text-center">
                CANCEL NOMINATION
              </Text>
            </TouchableOpacity>
          </>
        ) : (
          <Text className="text-wolf-muted text-xs tracking-widest text-center">
            {isAccusation ? 'ACCUSER IS SPEAKING' : 'ACCUSED IS DEFENDING'}
          </Text>
        )}
      </View>

      {/* Cancel-nomination confirmation modal */}
      <Modal
        visible={cancelOpen}
        transparent
        animationType="fade"
        onRequestClose={() => (busy === 'cancel' ? undefined : setCancelOpen(false))}
      >
        <Pressable
          onPress={() => (busy === 'cancel' ? undefined : setCancelOpen(false))}
          style={{
            flex: 1,
            backgroundColor: 'rgba(0,0,0,0.85)',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
          }}
        >
          <Pressable
            onPress={e => e.stopPropagation()}
            className="bg-wolf-surface rounded-2xl w-full p-6"
          >
            <Text className="text-wolf-text text-lg font-bold mb-2 text-center">
              Cancel nomination?
            </Text>
            <Text className="text-wolf-muted text-sm text-center mb-5">
              {(nomination.nominee?.name ?? 'This player').toUpperCase()} comes off
              the stand and this nomination is refunded to today's budget.
            </Text>
            <TouchableOpacity
              onPress={confirmCancelNomination}
              disabled={busy === 'cancel'}
              style={{ opacity: busy === 'cancel' ? 0.4 : 1 }}
              className="bg-wolf-card rounded-xl py-4 mb-2"
            >
              {busy === 'cancel' ? (
                <ActivityIndicator color="#F0EDE8" />
              ) : (
                <Text className="text-wolf-red text-center font-extrabold tracking-widest">
                  CANCEL NOMINATION
                </Text>
              )}
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => setCancelOpen(false)}
              disabled={busy === 'cancel'}
              className="py-2"
            >
              <Text className="text-wolf-muted text-center">Never mind</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      <TimersConfigModal
        visible={cogOpen}
        onClose={() => setCogOpen(false)}
        gameId={game._id}
        deviceClientId={deviceClientId}
        initial={game.config}
        passHostCandidates={passHostCandidates}
        roomCode={game.roomCode}
        canEndGame
      />

      <BuildModal
        visible={buildOpen}
        onClose={() => setBuildOpen(false)}
        selectedRoles={game.selectedRoles}
      />
    </SafeAreaView>
  );
}

// ───── Vote view ───────────────────────────────────────────────────────────

function VoteView({
  game,
  deviceClientId,
  meAlive,
  isHost,
  nomination,
  onLeavePress,
  hostMissing,
  passHostCandidates,
}: {
  game: DayGame;
  deviceClientId: string;
  meAlive: boolean;
  isHost: boolean;
  nomination: Nomination;
  onLeavePress: () => void;
  hostMissing: boolean;
  passHostCandidates?: Array<{ _id: Id<'players'>; name: string }>;
}) {
  const insets = useSafeAreaInsets();
  const now = useNow();
  const startClock = useMutation(api.day.startTrialClock);
  const pauseClock = useMutation(api.day.pauseTrialClock);
  const resetClock = useMutation(api.day.resetTrialClock);
  const castVote = useMutation(api.day.castVote);
  const [submitting, setSubmitting] = useState<'lives' | 'dies' | null>(null);
  const [busy, setBusy] = useState<'toggle' | 'reset' | null>(null);
  const [cogOpen, setCogOpen] = useState(false);
  const [buildOpen, setBuildOpen] = useState(false);

  const remaining = trialRemainingMs(nomination, game, now);
  const paused = nomination.subPhasePausedRemainingMs !== null;
  const notStartedYet = paused && remaining === game.config.voteTimerSec * 1000;

  async function handleVote(vote: 'lives' | 'dies') {
    if (!meAlive) return;
    setSubmitting(vote);
    try {
      await castVote({
        gameId: game._id,
        callerDeviceClientId: deviceClientId,
        vote,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Vote arrived after the server's grace window — the tally already
      // fired without this player's vote in it. Tell them plainly so they
      // don't wonder why their tap isn't in the result tally.
      if (
        msg.includes('Voting has closed') ||
        msg.includes('Voting has not opened yet')
      ) {
        showAlert(
          'Vote not counted',
          "The timer closed before your vote reached the server. The result for this round is final.",
        );
        return;
      }
      showAlert('Could not vote', msg);
    } finally {
      setSubmitting(null);
    }
  }

  async function toggleClock() {
    if (!isHost) return;
    setBusy('toggle');
    try {
      if (paused) {
        await startClock({ gameId: game._id, callerDeviceClientId: deviceClientId });
      } else {
        await pauseClock({ gameId: game._id, callerDeviceClientId: deviceClientId });
      }
    } catch (e) {
      showAlert('Error', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }
  async function reset() {
    setBusy('reset');
    try {
      await resetClock({ gameId: game._id, callerDeviceClientId: deviceClientId });
    } catch (e) {
      showAlert('Error', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <SafeAreaView className="flex-1 bg-wolf-bg">
      <DayHeader
        dayNumber={game.dayNumber}
        mode="TIME TO VOTE"
        roomCode={game.roomCode}
        onLeavePress={onLeavePress}
      />

      {hostMissing && (
        <HostMissingBanner
          gameId={game._id}
          deviceClientId={deviceClientId}
        />
      )}

      <TrialStatusBar
        dayRemMs={dayRemainingMs(game, now)}
        nominationsRemaining={game.nominationsRemaining}
        maxNominationsPerDay={game.maxNominationsPerDay}
      />

      <DayActionRow showBuild onBuildPress={() => setBuildOpen(true)} />
      {isHost && <DayCogRow onPress={() => setCogOpen(true)} />}

      <View className="flex-1 px-6 items-center justify-center">
        <Text className="text-wolf-muted text-xs font-bold tracking-widest mb-2">
          VOTE ON
        </Text>
        <Text className="text-wolf-text text-4xl font-extrabold tracking-widest mb-2 text-center">
          {nomination.nominee?.name.toUpperCase() ?? '—'}
        </Text>
        <View className="mb-6">
          <AccusationCredit nomination={nomination} />
        </View>

        <Pressable
          onPress={isHost && !notStartedYet ? toggleClock : undefined}
          className="items-center mb-8"
        >
          <Text
            className="text-wolf-accent font-extrabold"
            style={{ fontSize: 72, fontVariant: ['tabular-nums'] }}
          >
            {Math.ceil(remaining / 1000)}
          </Text>
          <Text className="text-wolf-muted text-xs tracking-widest mt-1">
            {paused
              ? notStartedYet
                ? 'SECONDS'
                : isHost
                  ? 'TAP TO RESUME'
                  : 'WAITING FOR HOST'
              : 'SECONDS'}
          </Text>
        </Pressable>

        {isHost && (
          <View className="flex-row mb-4" style={{ gap: 12 }}>
            <TouchableOpacity
              onPress={reset}
              disabled={busy !== null}
              style={{ opacity: busy === 'reset' ? 0.4 : 1 }}
              className="bg-wolf-card rounded-full items-center justify-center"
            >
              <View
                style={{
                  width: 40,
                  height: 40,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Text
                  className="text-wolf-text text-lg"
                  style={{ lineHeight: 18, marginTop: -2, includeFontPadding: false }}
                >
                  ↺
                </Text>
              </View>
            </TouchableOpacity>
          </View>
        )}

        <Text className="text-wolf-muted text-xs tracking-widest mb-2">
          {nomination.votedCount} / {nomination.eligibleCount} VOTED
        </Text>

        {nomination.iAmNominee ? (
          <View className="mt-8 items-center">
            <View
              className="rounded-2xl px-6 py-4"
              style={{ backgroundColor: '#3A2A14', borderWidth: 1, borderColor: '#D4A017' }}
            >
              <Text className="text-wolf-accent text-xs font-bold tracking-widest text-center">
                YOU ARE ON TRIAL
              </Text>
              <Text className="text-wolf-text text-sm text-center mt-2">
                You cannot vote on yourself.
              </Text>
            </View>
          </View>
        ) : meAlive ? (
          (() => {
            // Lock the vote buttons the instant the local timer hits zero so
            // taps that race the server's subPhase → 'results' transition
            // never leave the device. Belt to the server-side check's
            // suspenders.
            const expired = remaining <= 0 && !paused;
            const locked = !!submitting || paused || expired;
            return (
              <View className="flex-row mt-6" style={{ gap: 14 }}>
                <TouchableOpacity
                  onPress={() => handleVote('lives')}
                  disabled={locked}
                  className="rounded-2xl px-12 py-8 items-center"
                  style={{
                    backgroundColor:
                      nomination.myVote === 'lives' ? '#1F4E80' : '#22222F',
                    borderWidth: 2,
                    borderColor:
                      nomination.myVote === 'lives' ? '#5BA0E5' : '#2A2A38',
                    opacity:
                      paused || expired || submitting === 'dies' ? 0.4 : 1,
                  }}
                >
                  <Text className="text-wolf-text text-2xl font-extrabold tracking-widest">
                    LIVES
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => handleVote('dies')}
                  disabled={locked}
                  className="rounded-2xl px-12 py-8 items-center"
                  style={{
                    backgroundColor:
                      nomination.myVote === 'dies' ? '#8B1818' : '#22222F',
                    borderWidth: 2,
                    borderColor:
                      nomination.myVote === 'dies' ? '#B03A2E' : '#2A2A38',
                    opacity:
                      paused || expired || submitting === 'lives' ? 0.4 : 1,
                  }}
                >
                  <Text className="text-wolf-text text-2xl font-extrabold tracking-widest">
                    DIES
                  </Text>
                </TouchableOpacity>
              </View>
            );
          })()
        ) : (
          <Text className="text-wolf-muted text-sm text-center mt-6 italic">
            You are out of the game — spectating.
          </Text>
        )}
      </View>

      <View
        style={{
          paddingHorizontal: 24,
          paddingBottom: Math.max(insets.bottom, 16) + 16,
          alignItems: isHost && notStartedYet ? 'stretch' : 'center',
        }}
      >
        {isHost && notStartedYet ? (
          <TouchableOpacity
            onPress={toggleClock}
            disabled={busy !== null}
            style={{ opacity: busy === 'toggle' ? 0.4 : 1 }}
            className="bg-wolf-accent rounded-xl py-5 items-center"
          >
            {busy === 'toggle' ? (
              <ActivityIndicator color="#0F0F14" />
            ) : (
              <Text className="text-wolf-bg text-lg font-extrabold tracking-widest">
                BEGIN VOTE
              </Text>
            )}
          </TouchableOpacity>
        ) : (
          <Text className="text-wolf-muted text-xs tracking-widest">
            {paused
              ? 'WAITING FOR HOST'
              : isHost
                ? 'RESULTS POST WHEN TIMER ENDS'
                : 'WAITING FOR TIMER'}
          </Text>
        )}
      </View>

      <TimersConfigModal
        visible={cogOpen}
        onClose={() => setCogOpen(false)}
        gameId={game._id}
        deviceClientId={deviceClientId}
        initial={game.config}
        passHostCandidates={passHostCandidates}
        roomCode={game.roomCode}
        canEndGame
      />

      <BuildModal
        visible={buildOpen}
        onClose={() => setBuildOpen(false)}
        selectedRoles={game.selectedRoles}
      />
    </SafeAreaView>
  );
}

// ───── Results view ────────────────────────────────────────────────────────

function ResultsView({
  game,
  deviceClientId,
  isHost,
  nomination,
  cascadeDeaths,
  onLeavePress,
  hostMissing,
  meAlive,
  passHostCandidates,
}: {
  game: DayGame;
  deviceClientId: string;
  isHost: boolean;
  nomination: Nomination;
  cascadeDeaths: Array<{
    _id: Id<'players'>;
    name: string;
    cause: string;
    shotByName: string | null;
  }>;
  onLeavePress: () => void;
  hostMissing: boolean;
  meAlive: boolean;
  passHostCandidates?: Array<{ _id: Id<'players'>; name: string }>;
}) {
  const insets = useSafeAreaInsets();
  const continueGame = useMutation(api.day.continueGameAfterVote);
  const [submitting, setSubmitting] = useState(false);
  const [buildOpen, setBuildOpen] = useState(false);
  const now = useNow();

  // Mid-flight trigger announcement window (existing behavior).
  const triggerView = useQuery(api.triggers.triggerView, {
    gameId: game._id,
    deviceClientId,
  });
  const announcement = triggerView?.game.announcement ?? null;
  const announcementActive =
    announcement != null && now < announcement.endsAt;

  const livesCount = nomination.livesVoters.length;
  const diesCount = nomination.diesVoters.length;
  const lynch = diesCount > livesCount;

  const dwellRemainingMs =
    game.voteDwellEndsAt != null ? Math.max(0, game.voteDwellEndsAt - now) : 0;
  const dwellActive = dwellRemainingMs > 0;
  const triggerActive = game.pendingTriggerCount > 0;
  const continueLocked = dwellActive || triggerActive || announcementActive;

  async function handleContinue() {
    setSubmitting(true);
    try {
      await continueGame({
        gameId: game._id,
        callerDeviceClientId: deviceClientId,
      });
    } catch (e) {
      showAlert('Error', e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <SafeAreaView className="flex-1 bg-wolf-bg">
      <DayHeader
        dayNumber={game.dayNumber}
        mode="VOTE RESULT"
        roomCode={game.roomCode}
        onLeavePress={onLeavePress}
      />

      {hostMissing && (
        <HostMissingBanner
          gameId={game._id}
          deviceClientId={deviceClientId}
        />
      )}

      <TrialStatusBar
        dayRemMs={dayRemainingMs(game, now)}
        nominationsRemaining={game.nominationsRemaining}
        maxNominationsPerDay={game.maxNominationsPerDay}
      />

      <DayActionRow showBuild onBuildPress={() => setBuildOpen(true)} />

      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: 24,
          paddingBottom: 24,
          alignItems: 'center',
        }}
      >
        <View className="mt-2 mb-6 items-center">
          <Text className="text-wolf-muted text-xs font-bold tracking-widest mb-1">
            VOTED ON
          </Text>
          <Text
            className="text-wolf-text text-2xl font-extrabold tracking-widest text-center"
            numberOfLines={2}
          >
            {nomination.nominee?.name.toUpperCase() ?? '—'}
          </Text>
        </View>

        <View className="flex-row self-stretch" style={{ gap: 12 }}>
          <View
            className="flex-1 bg-wolf-card rounded-xl px-4 py-3"
            style={{ borderWidth: 1, borderColor: '#1F4E80' }}
          >
            <Text className="text-xs font-bold tracking-widest mb-2" style={{ color: '#5BA0E5' }}>
              LIVES ({livesCount})
            </Text>
            {nomination.livesVoters.map((n: string, i: number) => (
              <Text key={i} className="text-wolf-text text-sm py-0.5">
                {n}
              </Text>
            ))}
          </View>
          <View
            className="flex-1 bg-wolf-card rounded-xl px-4 py-3"
            style={{ borderWidth: 1, borderColor: '#8B1818' }}
          >
            <Text className="text-xs font-bold tracking-widest mb-2" style={{ color: '#E07070' }}>
              DIES ({diesCount})
            </Text>
            {nomination.diesVoters.map((n: string, i: number) => (
              <Text key={i} className="text-wolf-text text-sm py-0.5">
                {n}
              </Text>
            ))}
          </View>
        </View>

        {!lynch ? (
          <View
            className="mt-6 rounded-2xl px-5 py-5 self-stretch"
            style={{
              backgroundColor: '#22222F',
              borderWidth: 2,
              borderColor: '#8A8590',
              gap: 12,
            }}
          >
            <Text className="text-wolf-text text-2xl font-extrabold tracking-widest text-center">
              LIVES
            </Text>
          </View>
        ) : null}

        {lynch || cascadeDeaths.length > 0 ? (
          <View
            className="mt-6 rounded-2xl px-5 py-5 self-stretch"
            style={{
              backgroundColor: '#22222F',
              borderWidth: 2,
              borderColor: '#D4A017',
              gap: 12,
            }}
          >
            {lynch ? (
              <>
                <Text
                  className="text-wolf-accent text-xs font-extrabold tracking-widest text-center"
                  style={{ letterSpacing: 2 }}
                >
                  ELIMINATED
                </Text>
                <Text className="text-wolf-text text-2xl font-extrabold tracking-widest text-center">
                  {nomination.nominee?.name.toUpperCase() ?? '—'}
                </Text>
              </>
            ) : null}

            {cascadeDeaths.length > 0 ? (
              <>
                {lynch ? (
                  <View
                    style={{
                      height: 1,
                      backgroundColor: '#D4A017',
                      opacity: 0.3,
                      marginTop: 4,
                      marginBottom: 4,
                    }}
                  />
                ) : null}
                <Text
                  className="text-wolf-accent text-xs font-extrabold tracking-widest text-center"
                  style={{ letterSpacing: 2 }}
                >
                  {lynch ? 'ALSO ELIMINATED' : 'ELIMINATED'}
                </Text>
                {cascadeDeaths.map(d => (
                  <View key={d._id} style={{ alignItems: 'center', gap: 2 }}>
                    <Text className="text-wolf-text text-xl font-extrabold tracking-widest text-center">
                      {d.name.toUpperCase()}
                    </Text>
                    {(d.cause === 'hunter' || d.cause === 'hunter-wolf') &&
                    d.shotByName ? (
                      <Text className="text-wolf-muted text-xs font-bold tracking-widest text-center">
                        SHOT BY {d.shotByName.toUpperCase()}
                      </Text>
                    ) : null}
                  </View>
                ))}
              </>
            ) : null}
          </View>
        ) : null}
      </ScrollView>

      <View
        style={{
          paddingHorizontal: 24,
          paddingBottom: Math.max(insets.bottom, 16) + 16,
        }}
      >
        {isHost ? (
          <TouchableOpacity
            onPress={handleContinue}
            disabled={submitting || continueLocked}
            style={{ opacity: submitting || continueLocked ? 0.4 : 1 }}
            className="bg-wolf-accent rounded-xl py-5 items-center"
          >
            {submitting ? (
              <ActivityIndicator color="#0F0F14" />
            ) : continueLocked ? (
              <Text className="text-wolf-bg text-lg font-extrabold tracking-widest">
                {dwellActive
                  ? `WAIT  ${Math.ceil(dwellRemainingMs / 1000)}`
                  : 'RESOLVING…'}
              </Text>
            ) : (
              <Text className="text-wolf-bg text-lg font-extrabold tracking-widest">
                CONTINUE GAME
              </Text>
            )}
          </TouchableOpacity>
        ) : (
          <Text className="text-wolf-muted text-xs tracking-widest text-center">
            {continueLocked
              ? 'TALLYING…'
              : 'WAITING FOR HOST TO CONTINUE'}
          </Text>
        )}
      </View>

      {/* Lynch trigger overlay — unchanged (Hunter / Hunter Wolf / MB picker
          for the just-lynched player). */}
      <LynchTriggerOverlay
        gameId={game._id}
        deviceClientId={deviceClientId}
      />

      <BuildModal
        visible={buildOpen}
        onClose={() => setBuildOpen(false)}
        selectedRoles={game.selectedRoles}
      />
    </SafeAreaView>
  );
}

// ───── Lynch trigger overlay ───────────────────────────────────────────────

function LynchTriggerOverlay({
  gameId,
  deviceClientId,
}: {
  gameId: Id<'games'>;
  deviceClientId: string;
}) {
  const view = useQuery(api.triggers.triggerView, {
    gameId,
    deviceClientId,
  });
  const now = useNow(250);

  if (!view || !view.head || !view.head.isMe) return null;
  const ann = view.game.announcement;
  if (ann && now < ann.endsAt) return null;

  if (view.head.role === 'Hunter' || view.head.role === 'Hunter Wolf') {
    return (
      <HunterModal
        gameId={gameId}
        deviceClientId={deviceClientId}
        deadline={view.game.triggerEndsAt}
        targetables={view.targetables}
        totalSeats={view.game.playerCount}
        myId={view.me._id}
        mySeatPosition={view.me.seatPosition}
      />
    );
  }
  return null;
}

function CountdownText({ deadline }: { deadline: number | null }) {
  const now = useNow();
  if (deadline === null) return null;
  const remaining = Math.max(0, Math.ceil((deadline - now) / 1000));
  return (
    <Text
      className="text-wolf-accent text-6xl font-extrabold"
      style={{ fontVariant: ['tabular-nums'] }}
    >
      {remaining}
    </Text>
  );
}

function HunterModal({
  gameId,
  deviceClientId,
  deadline,
  targetables,
  totalSeats,
  myId,
  mySeatPosition,
}: {
  gameId: Id<'games'>;
  deviceClientId: string;
  deadline: number | null;
  targetables: Array<{
    _id: Id<'players'>;
    name: string;
    seatPosition?: number;
  }>;
  totalSeats: number;
  myId: Id<'players'>;
  mySeatPosition?: number;
}) {
  const submitShot = useMutation(api.triggers.submitHunterShot);
  const submitSkip = useMutation(api.triggers.submitHunterSkip);
  const [submitting, setSubmitting] = useState(false);

  async function shoot(targetId: Id<'players'>) {
    setSubmitting(true);
    try {
      await submitShot({
        gameId,
        callerDeviceClientId: deviceClientId,
        targetPlayerId: targetId,
      });
    } catch (e) {
      showAlert('Could not shoot', e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }
  async function pass() {
    setSubmitting(true);
    try {
      await submitSkip({ gameId, callerDeviceClientId: deviceClientId });
    } catch (e) {
      showAlert('Could not pass', e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal visible transparent animationType="fade">
      <View
        style={{
          flex: 1,
          backgroundColor: 'rgba(0,0,0,0.95)',
          alignItems: 'center',
          paddingTop: 64,
          paddingHorizontal: 16,
        }}
      >
        <Text className="text-wolf-muted text-xs tracking-widest">
          YOU HAVE BEEN ELIMINATED
        </Text>
        <Text className="text-wolf-accent text-2xl font-extrabold tracking-widest mt-1 mb-3">
          TAKE A SHOT
        </Text>
        <CountdownText deadline={deadline} />
        <Text className="text-wolf-muted text-xs tracking-widest mt-1 mb-3">
          SECONDS
        </Text>
        <SeatingCircle
          totalSeats={totalSeats}
          players={targetables}
          meId={myId}
          viewerSeatIndex={mySeatPosition}
          onPress={p => !submitting && shoot(p._id)}
        />
        <Text className="text-wolf-muted text-xs text-center mt-4 max-w-xs">
          Tap a player to shoot them, or pass below.
        </Text>
        <View style={{ marginTop: 24, width: '100%' }}>
          <TouchableOpacity
            onPress={pass}
            disabled={submitting}
            style={{ opacity: submitting ? 0.4 : 1 }}
            className="bg-wolf-card rounded-xl py-4 items-center"
          >
            <Text className="text-wolf-text text-base font-extrabold tracking-widest">
              HOLD FIRE
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

