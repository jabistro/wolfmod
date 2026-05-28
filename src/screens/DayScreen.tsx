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
  };
};

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

  const { game, me, alive, players, currentNomination } = view;
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
            players={players}
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
      alive={alive}
      players={players}
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
          DAY (PAUSED)
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
  showCog,
  onCogPress,
  onBuildPress,
  onLeavePress,
}: {
  dayNumber: number;
  mode: string;
  showCog?: boolean;
  onCogPress?: () => void;
  onBuildPress?: () => void;
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
          right: 16,
          top: 40,
          flexDirection: 'row',
          alignItems: 'center',
        }}
      >
        {showCog && (
          <TouchableOpacity onPress={onCogPress} style={{ padding: 8 }}>
            <Text style={{ color: '#8A8590', fontSize: 22 }}>⚙</Text>
          </TouchableOpacity>
        )}
        {onBuildPress && (
          <TouchableOpacity onPress={onBuildPress} style={{ padding: 8 }}>
            <Text
              style={{
                color: '#8A8590',
                fontSize: 12,
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

  return (
    <View
      className="mx-4 mb-3 bg-wolf-card rounded-xl flex-row items-center"
      style={{ paddingVertical: 10, paddingHorizontal: 16 }}
    >
      <View className="flex-1">
        <Text className="text-wolf-muted text-xs tracking-widest">
          {dayOver ? 'DAY OVER' : paused ? 'DAY (PAUSED)' : 'DAY'}
        </Text>
        <Text
          className="font-extrabold"
          style={{ color, fontSize: 28, fontVariant: ['tabular-nums'] }}
        >
          {formatTime(remaining)}
        </Text>
      </View>
      {isHost && !dayOver && (
        <View className="flex-row" style={{ gap: 8 }}>
          <TouchableOpacity
            onPress={toggle}
            disabled={busy !== null}
            className="bg-wolf-surface rounded-full items-center justify-center"
            style={{ width: 40, height: 40, opacity: busy === 'toggle' ? 0.4 : 1 }}
          >
            {paused ? (
              <Text className="text-wolf-text text-base">▶</Text>
            ) : (
              <View className="flex-row" style={{ gap: 3 }}>
                <View style={{ width: 4, height: 14, backgroundColor: '#F0EDE8', borderRadius: 1 }} />
                <View style={{ width: 4, height: 14, backgroundColor: '#F0EDE8', borderRadius: 1 }} />
              </View>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            onPress={reset}
            disabled={busy !== null}
            className="bg-wolf-surface rounded-full items-center justify-center"
            style={{ width: 40, height: 40, opacity: busy === 'reset' ? 0.4 : 1 }}
          >
            <Text
              className="text-wolf-text text-base"
              style={{ lineHeight: 16, marginTop: -2, includeFontPadding: false }}
            >
              ↺
            </Text>
          </TouchableOpacity>
        </View>
      )}
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
  alive,
  players,
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
  alive: Array<{ _id: Id<'players'>; name: string; seatPosition?: number }>;
  players: Array<{
    _id: Id<'players'>;
    name: string;
    seatPosition?: number;
    alive: boolean;
  }>;
  onBeginNight: () => Promise<void>;
  onLeavePress: () => void;
  hostMissing: boolean;
  passHostCandidates?: Array<{ _id: Id<'players'>; name: string }>;
}) {
  const insets = useSafeAreaInsets();
  const now = useNow();
  const nominate = useMutation(api.day.nominate);
  const [confirmTarget, setConfirmTarget] = useState<{
    id: Id<'players'>;
    name: string;
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [cogOpen, setCogOpen] = useState(false);
  const [buildOpen, setBuildOpen] = useState(false);

  const dayRemMs = dayRemainingMs(game, now);
  const dayExpired = dayRemMs <= 0;
  const noNomsLeft = game.nominationsRemaining <= 0;
  const dayOver = dayExpired || noNomsLeft;

  async function handleBeginVote() {
    if (!confirmTarget) return;
    setSubmitting(true);
    try {
      await nominate({
        gameId: game._id,
        callerDeviceClientId: deviceClientId,
        targetPlayerId: confirmTarget.id,
      });
      setConfirmTarget(null);
    } catch (e) {
      showAlert('Could not put on trial', e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <SafeAreaView className="flex-1 bg-wolf-bg">
      <DayHeader
        dayNumber={game.dayNumber}
        mode="DISCUSSION"
        showCog={isHost}
        onCogPress={() => setCogOpen(true)}
        onBuildPress={() => setBuildOpen(true)}
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

      <View className="flex-row justify-center" style={{ gap: 18, marginBottom: 4 }}>
        <Text className="text-wolf-muted text-xs font-bold tracking-widest">
          {alive.length} ALIVE
        </Text>
        <Text className="text-wolf-muted text-xs font-bold tracking-widest">
          NOMS LEFT: {game.nominationsRemaining}/{game.maxNominationsPerDay}
        </Text>
      </View>

      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24, alignItems: 'center' }}>
        <SeatingCircle
          totalSeats={game.playerCount}
          players={players}
          meId={meId}
          onPress={
            isHost && !dayOver
              ? p => setConfirmTarget({ id: p._id, name: p.name })
              : undefined
          }
        />
        {dayOver ? (
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
        ) : isHost ? (
          <Text className="text-wolf-muted text-xs text-center mt-4">
            Tap a player to put them on trial.
          </Text>
        ) : null}
        {!meAlive && (
          <Text className="text-wolf-muted text-xs text-center mt-4 italic">
            You are out of the game — spectating.
          </Text>
        )}
      </ScrollView>

      {isHost && (
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

      {!isHost && (
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

      {/* Confirm / put-on-trial modal */}
      <Modal
        visible={!!confirmTarget}
        transparent
        animationType="fade"
        onRequestClose={() => setConfirmTarget(null)}
      >
        <View
          style={{
            flex: 1,
            backgroundColor: 'rgba(0,0,0,0.92)',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 32,
          }}
        >
          <Text className="text-wolf-muted text-xs font-bold tracking-widest mb-3">
            PUT ON TRIAL
          </Text>
          <Text className="text-wolf-text text-3xl font-extrabold text-center mb-2">
            {confirmTarget?.name.toUpperCase()}
          </Text>
          <Text className="text-wolf-muted text-sm text-center mb-10">
            Announce to the table that this player is on trial, then start
            the accusation timer when the accuser is ready.
          </Text>
          <View className="flex-row" style={{ gap: 14 }}>
            <TouchableOpacity
              onPress={() => setConfirmTarget(null)}
              disabled={submitting}
              className="bg-wolf-card rounded-xl py-4 px-8"
              style={{ borderWidth: 1, borderColor: '#3A3A48' }}
            >
              <Text className="text-wolf-text text-base font-extrabold tracking-widest">
                CANCEL
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleBeginVote}
              disabled={submitting}
              style={{ opacity: submitting ? 0.4 : 1 }}
              className="bg-wolf-accent rounded-xl py-4 px-8"
            >
              {submitting ? (
                <ActivityIndicator color="#0F0F14" />
              ) : (
                <Text className="text-wolf-bg text-base font-extrabold tracking-widest">
                  ON TRIAL
                </Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
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

// ───── Trial view (accusation / defense) ───────────────────────────────────

function TrialView({
  game,
  deviceClientId,
  isHost,
  nomination,
  onLeavePress,
  hostMissing,
  meAlive,
  passHostCandidates,
}: {
  game: DayGame;
  deviceClientId: string;
  isHost: boolean;
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
        showCog={isHost}
        onCogPress={() => setCogOpen(true)}
        onBuildPress={() => setBuildOpen(true)}
        onLeavePress={onLeavePress}
      />

      {hostMissing && (
        <HostMissingBanner
          gameId={game._id}
          deviceClientId={deviceClientId}
        />
      )}

      <View className="items-center mb-2">
        <Text className="text-wolf-text text-2xl font-extrabold tracking-widest">
          {nomination.nominee?.name.toUpperCase() ?? '—'}
        </Text>
      </View>

      <TrialStatusBar
        dayRemMs={dayRemMs}
        nominationsRemaining={game.nominationsRemaining}
        maxNominationsPerDay={game.maxNominationsPerDay}
      />

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
      showAlert('Could not vote', e instanceof Error ? e.message : String(e));
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
        showCog={isHost}
        onCogPress={() => setCogOpen(true)}
        onBuildPress={() => setBuildOpen(true)}
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

      <View className="flex-1 px-6 items-center justify-center">
        <Text className="text-wolf-muted text-xs font-bold tracking-widest mb-2">
          VOTE ON
        </Text>
        <Text className="text-wolf-text text-4xl font-extrabold tracking-widest mb-8 text-center">
          {nomination.nominee?.name.toUpperCase() ?? '—'}
        </Text>

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
          <View className="flex-row mt-6" style={{ gap: 14 }}>
            <TouchableOpacity
              onPress={() => handleVote('lives')}
              disabled={!!submitting || paused}
              className="rounded-2xl px-12 py-8 items-center"
              style={{
                backgroundColor:
                  nomination.myVote === 'lives' ? '#1F4E80' : '#22222F',
                borderWidth: 2,
                borderColor:
                  nomination.myVote === 'lives' ? '#5BA0E5' : '#2A2A38',
                opacity: paused ? 0.4 : submitting === 'dies' ? 0.4 : 1,
              }}
            >
              <Text className="text-wolf-text text-2xl font-extrabold tracking-widest">
                LIVES
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => handleVote('dies')}
              disabled={!!submitting || paused}
              className="rounded-2xl px-12 py-8 items-center"
              style={{
                backgroundColor:
                  nomination.myVote === 'dies' ? '#8B1818' : '#22222F',
                borderWidth: 2,
                borderColor:
                  nomination.myVote === 'dies' ? '#B03A2E' : '#2A2A38',
                opacity: paused ? 0.4 : submitting === 'lives' ? 0.4 : 1,
              }}
            >
              <Text className="text-wolf-text text-2xl font-extrabold tracking-widest">
                DIES
              </Text>
            </TouchableOpacity>
          </View>
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
  players,
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
  players: Array<{
    _id: Id<'players'>;
    name: string;
    seatPosition?: number;
    alive: boolean;
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
        onBuildPress={() => setBuildOpen(true)}
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

      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: 24,
          paddingBottom: 24,
          alignItems: 'center',
        }}
      >
        <View className="mt-2 mb-6">
          <SeatingCircle
            totalSeats={game.playerCount}
            players={players}
            centerOverlay={
              <View style={{ alignItems: 'center', paddingHorizontal: 8 }}>
                <Text className="text-wolf-muted text-xs font-bold tracking-widest mb-1">
                  VOTED ON
                </Text>
                <Text
                  className="text-wolf-text text-xl font-extrabold tracking-widest text-center"
                  numberOfLines={2}
                >
                  {nomination.nominee?.name.toUpperCase() ?? '—'}
                </Text>
              </View>
            }
          />
        </View>

        <View className="flex-row self-stretch" style={{ gap: 12 }}>
          <View
            className="flex-1 bg-wolf-card rounded-xl px-4 py-3"
            style={{ borderWidth: 1, borderColor: '#1F4E80' }}
          >
            <Text className="text-xs font-bold tracking-widest mb-2" style={{ color: '#5BA0E5' }}>
              LIVES ({livesCount})
            </Text>
            {nomination.livesVoters.length === 0 ? (
              <Text className="text-wolf-muted text-xs italic">none</Text>
            ) : (
              nomination.livesVoters.map((n: string, i: number) => (
                <Text key={i} className="text-wolf-text text-sm py-0.5">
                  {n}
                </Text>
              ))
            )}
          </View>
          <View
            className="flex-1 bg-wolf-card rounded-xl px-4 py-3"
            style={{ borderWidth: 1, borderColor: '#8B1818' }}
          >
            <Text className="text-xs font-bold tracking-widest mb-2" style={{ color: '#E07070' }}>
              DIES ({diesCount})
            </Text>
            {nomination.diesVoters.length === 0 ? (
              <Text className="text-wolf-muted text-xs italic">none</Text>
            ) : (
              nomination.diesVoters.map((n: string, i: number) => (
                <Text key={i} className="text-wolf-text text-sm py-0.5">
                  {n}
                </Text>
              ))
            )}
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

