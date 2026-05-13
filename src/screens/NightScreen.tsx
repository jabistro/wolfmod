import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  SafeAreaView,
  ScrollView,
  Animated,
  Easing,
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
} from 'react-native';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { StackNavigationProp } from '@react-navigation/stack';
import { useMutation, useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import type { RootStackParamList } from '../navigation/types';
import { useDeviceId } from '../hooks/useDeviceId';
import { SeatingCircle, type SeatingPlayer } from '../components/SeatingCircle';

type Nav = StackNavigationProp<RootStackParamList, 'Night'>;
type Route = RouteProp<RootStackParamList, 'Night'>;

type Targetable = {
  _id: Id<'players'>;
  name: string;
  seatPosition?: number;
};

export default function NightScreen() {
  const navigation = useNavigation<Nav>();
  const { params } = useRoute<Route>();
  const deviceClientId = useDeviceId();

  const view = useQuery(
    api.night.nightView,
    deviceClientId
      ? { gameId: params.gameId as Id<'games'>, deviceClientId }
      : 'skip',
  );

  const forceAdvance = useMutation(api.night.forceAdvanceStep);
  const refreshStep = useMutation(api.night.refreshStep);

  // Local clock used to surface the host's "skip ahead" override without
  // needing a server roundtrip — the server returns `skipEligibleAt` and the
  // client checks it against wall-clock time on a 1s tick.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  // Phase-driven nav: when night ends → morning, route everyone forward.
  useEffect(() => {
    if (!view) return;
    const phase = view.game.phase;
    if (phase === 'morning') {
      navigation.replace('Morning', { gameId: params.gameId });
    } else if (phase === 'day') {
      navigation.replace('Day', { gameId: params.gameId });
    } else if (phase === 'ended') {
      navigation.replace('EndGame', { gameId: params.gameId });
    }
  }, [view?.game.phase, navigation, params.gameId]);

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

  const {
    game,
    me,
    isMyStep,
    stepLabel,
    wolfState,
    seerHistory,
    piState,
    mentalistState,
    witchState,
    bgState,
    huntressState,
    revealerState,
    revilerState,
    targetables,
  } = view;

  // Defensive: if phase has already moved on, the effect above will navigate.
  if (game.phase !== 'night') {
    return (
      <SafeAreaView className="flex-1 bg-wolf-bg items-center justify-center">
        <ActivityIndicator color="#D4A017" />
      </SafeAreaView>
    );
  }

  if (!me.alive) {
    // Dead-player spectator placeholder; richer view comes when nights have
    // more roles acting.
    return (
      <SafeAreaView className="flex-1 bg-wolf-bg">
        <NightHeader nightNumber={game.nightNumber} stepLabel={stepLabel} dead />
        <View className="flex-1 items-center justify-center px-8">
          <Text className="text-wolf-muted text-sm text-center">
            You are out of the game. The night unfolds without you.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-wolf-bg">
      <NightHeader nightNumber={game.nightNumber} stepLabel={stepLabel} />

      {isMyStep && game.nightStep === 'wolves' && wolfState && (
        wolfState.blocked ? (
          <WolvesBlockedView wolves={wolfState.wolves} />
        ) : (
          <WolvesPicker
            gameId={game._id}
            deviceClientId={deviceClientId}
            alivePlayers={view.alivePlayers}
            targetables={targetables}
            totalSeats={game.playerCount}
            meId={me._id}
            wolves={wolfState.wolves}
          />
        )
      )}

      {isMyStep && game.nightStep === 'seer' && (
        <SeerPicker
          gameId={game._id}
          deviceClientId={deviceClientId}
          alivePlayers={view.alivePlayers}
          targetables={targetables}
          totalSeats={game.playerCount}
          meId={me._id}
          history={seerHistory ?? []}
          nightNumber={game.nightNumber}
        />
      )}

      {isMyStep && game.nightStep === 'pi' && piState && (
        <PIPicker
          gameId={game._id}
          deviceClientId={deviceClientId}
          alivePlayers={view.alivePlayers}
          targetables={targetables}
          totalSeats={game.playerCount}
          meId={me._id}
          piState={piState}
        />
      )}

      {isMyStep && game.nightStep === 'mentalist' && mentalistState && (
        <MentalistPicker
          gameId={game._id}
          deviceClientId={deviceClientId}
          alivePlayers={view.alivePlayers}
          targetables={targetables}
          totalSeats={game.playerCount}
          meId={me._id}
          mentalistState={mentalistState}
          nightNumber={game.nightNumber}
        />
      )}

      {isMyStep && game.nightStep === 'witch' && witchState && (
        <WitchPicker
          gameId={game._id}
          deviceClientId={deviceClientId}
          alivePlayers={view.alivePlayers}
          targetables={targetables}
          totalSeats={game.playerCount}
          meId={me._id}
          witchState={witchState}
        />
      )}

      {isMyStep && game.nightStep === 'bodyguard' && bgState && (
        <BodyguardPicker
          gameId={game._id}
          deviceClientId={deviceClientId}
          alivePlayers={view.alivePlayers}
          targetables={targetables}
          totalSeats={game.playerCount}
          bgState={bgState}
          meId={me._id}
        />
      )}

      {isMyStep && game.nightStep === 'huntress' && huntressState && (
        <HuntressPicker
          gameId={game._id}
          deviceClientId={deviceClientId}
          alivePlayers={view.alivePlayers}
          targetables={targetables}
          totalSeats={game.playerCount}
          huntressState={huntressState}
          meId={me._id}
        />
      )}

      {isMyStep && game.nightStep === 'revealer' && revealerState && (
        <RevealerPicker
          gameId={game._id}
          deviceClientId={deviceClientId}
          alivePlayers={view.alivePlayers}
          targetables={targetables}
          totalSeats={game.playerCount}
          revealerState={revealerState}
          meId={me._id}
        />
      )}

      {isMyStep && game.nightStep === 'reviler' && revilerState && (
        <RevilerPicker
          gameId={game._id}
          deviceClientId={deviceClientId}
          alivePlayers={view.alivePlayers}
          targetables={targetables}
          totalSeats={game.playerCount}
          revilerState={revilerState}
          meId={me._id}
        />
      )}

      {!isMyStep && (
        <WaitingView role={me.role} stepLabel={stepLabel} history={seerHistory} />
      )}

      {me.isHost &&
        game.nightStep != null &&
        view.game.skipEligibleAt != null &&
        now > view.game.skipEligibleAt && (
          <HostStallOverride
            onRefresh={async () => {
              try {
                await refreshStep({
                  gameId: game._id,
                  callerDeviceClientId: deviceClientId,
                  expectedStep: game.nightStep!,
                });
              } catch (e) {
                Alert.alert(
                  'Could not refresh',
                  e instanceof Error ? e.message : String(e),
                );
              }
            }}
            onSkip={async () => {
              try {
                await forceAdvance({
                  gameId: game._id,
                  callerDeviceClientId: deviceClientId,
                  expectedStep: game.nightStep!,
                });
              } catch (e) {
                Alert.alert(
                  'Could not skip',
                  e instanceof Error ? e.message : String(e),
                );
              }
            }}
          />
        )}
    </SafeAreaView>
  );
}

// ───── Host stall override ─────────────────────────────────────────────────
//
// Surfaces only to the host, only after the current step has stalled past
// `skipEligibleAt`. Two paths: REFRESH wipes the step's recorded actions and
// resets the dwell so the stuck actor gets a clean second chance; SKIP just
// advances without taking any action on anyone's behalf. Intentionally
// generic — never mentions the role or player holding things up, so a host
// who is also a player can't infer who has which role.

function HostStallOverride({
  onRefresh,
  onSkip,
}: {
  onRefresh: () => void;
  onSkip: () => void;
}) {
  return (
    <View
      style={{
        position: 'absolute',
        left: 16,
        right: 16,
        bottom: 24,
      }}
    >
      <View className="bg-wolf-card rounded-xl px-4 py-3 mb-2">
        <Text className="text-wolf-muted text-xs text-center">
          This step is taking longer than usual.
        </Text>
      </View>
      <View className="flex-row" style={{ gap: 10 }}>
        <TouchableOpacity
          onPress={onRefresh}
          activeOpacity={0.75}
          className="bg-wolf-card rounded-xl py-4 items-center flex-1"
          style={{ borderWidth: 1, borderColor: '#D4A017' }}
        >
          <Text className="text-wolf-accent text-base font-extrabold tracking-widest">
            REFRESH
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={onSkip}
          activeOpacity={0.75}
          className="bg-wolf-accent rounded-xl py-4 items-center flex-1"
        >
          <Text className="text-wolf-bg text-base font-extrabold tracking-widest">
            SKIP AHEAD
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ───── Header ───────────────────────────────────────────────────────────────

function NightHeader({
  nightNumber,
  stepLabel,
  dead,
}: {
  nightNumber: number;
  stepLabel: string | null;
  dead?: boolean;
}) {
  return (
    <View className="px-4 pt-10 pb-3 items-center">
      <Text className="text-wolf-muted text-xs tracking-widest">
        NIGHT {nightNumber}
      </Text>
      {dead ? (
        <Text className="text-wolf-red text-base font-bold tracking-widest mt-1">
          SPECTATING
        </Text>
      ) : stepLabel ? (
        <Text className="text-wolf-text text-base font-bold tracking-widest mt-1 text-center">
          {stepLabel.toUpperCase()}
        </Text>
      ) : null}
    </View>
  );
}

// ───── Wolves blocked view ─────────────────────────────────────────────────
//
// Shown ONLY to wolves on the night following a Diseased kill. Wolves need
// to know they can't act (so they don't sit confused waiting for a picker);
// the rest of the table hears nothing about it and has to figure out at
// morning why no one died. Step still dwells normally for cloaking.

function WolvesBlockedView({
  wolves,
}: {
  wolves: Array<{
    _id: Id<'players'>;
    name: string;
    role: string;
    isMe: boolean;
  }>;
}) {
  return (
    <View className="flex-1 px-6 pt-2 pb-8">
      <View className="bg-wolf-card rounded-xl px-5 py-5 mb-5">
        <Text className="text-wolf-red text-base font-extrabold tracking-widest text-center mb-2">
          THE BLOOD WAS DISEASED
        </Text>
        <Text className="text-wolf-text text-sm text-center">
          The pack is sickened. There is no kill tonight.
        </Text>
      </View>

      <View className="bg-wolf-card rounded-xl px-4 py-3">
        <Text className="text-wolf-muted text-xs font-bold tracking-widest mb-2">
          YOUR PACK
        </Text>
        {wolves.map(w => (
          <View
            key={w._id}
            className="flex-row items-center justify-between py-1"
          >
            <Text className="text-wolf-text text-sm">
              {w.isMe ? 'You' : w.name}{' '}
              <Text className="text-wolf-muted text-xs">({w.role})</Text>
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

// ───── Wolves picker ────────────────────────────────────────────────────────

function WolvesPicker({
  gameId,
  deviceClientId,
  alivePlayers,
  targetables,
  totalSeats,
  meId,
  wolves,
}: {
  gameId: Id<'games'>;
  deviceClientId: string;
  alivePlayers: SeatingPlayer[];
  targetables: Targetable[];
  totalSeats: number;
  meId: Id<'players'>;
  wolves: Array<{
    _id: Id<'players'>;
    name: string;
    role: string;
    isMe: boolean;
    currentVote?: Id<'players'>;
  }>;
}) {
  const submitVote = useMutation(api.night.submitWolfVote);
  const [submitting, setSubmitting] = useState(false);

  const myVote = wolves.find(w => w.isMe)?.currentVote;
  const consensus =
    wolves.length > 0 &&
    wolves.every(w => w.currentVote && w.currentVote === wolves[0].currentVote);

  async function handleVote(targetId: Id<'players'>) {
    if (submitting) return;
    setSubmitting(true);
    try {
      await submitVote({
        gameId,
        callerDeviceClientId: deviceClientId,
        targetPlayerId: targetId,
      });
    } catch (e) {
      Alert.alert('Could not vote', e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <View className="flex-1">
      <ScrollView contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: 24 }}>
        <Text className="text-wolf-text text-base text-center mt-2 mb-4">
          {consensus
            ? 'Consensus reached. Sealing the kill…'
            : 'Tap a player to vote. All wolves must agree.'}
        </Text>

        {/* Wolf-pack awareness panel */}
        <View className="bg-wolf-card rounded-xl px-4 py-3 mb-5">
          <Text className="text-wolf-muted text-xs font-bold tracking-widest mb-2">
            YOUR PACK
          </Text>
          {wolves.map(w => {
            const targetName = w.currentVote
              ? targetables.find(t => t._id === w.currentVote)?.name ?? '—'
              : null;
            return (
              <View
                key={w._id}
                className="flex-row items-center justify-between py-1"
              >
                <Text className="text-wolf-text text-sm">
                  {w.isMe ? 'You' : w.name}{' '}
                  <Text className="text-wolf-muted text-xs">({w.role})</Text>
                </Text>
                <Text
                  className={
                    targetName ? 'text-wolf-accent text-sm' : 'text-wolf-muted text-sm'
                  }
                >
                  {targetName ?? 'no vote'}
                </Text>
              </View>
            );
          })}
        </View>

        {/* Seating circle — selectable seats are non-wolf alive players. */}
        <View style={{ alignItems: 'center' }}>
          <SeatingCircle
            totalSeats={totalSeats}
            players={alivePlayers}
            meId={meId}
            selectedId={myVote}
            selectableIds={new Set(targetables.map(t => t._id as unknown as string))}
            onPress={
              !submitting && !consensus ? p => handleVote(p._id) : undefined
            }
          />
        </View>
      </ScrollView>
    </View>
  );
}

// ───── Seer picker ──────────────────────────────────────────────────────────

function SeerPicker({
  gameId,
  deviceClientId,
  alivePlayers,
  targetables,
  totalSeats,
  meId,
  history,
  nightNumber,
}: {
  gameId: Id<'games'>;
  deviceClientId: string;
  alivePlayers: SeatingPlayer[];
  targetables: Targetable[];
  totalSeats: number;
  meId: Id<'players'>;
  history: Array<{
    nightNumber: number;
    targetName: string;
    team: 'wolf' | 'villager';
  }>;
  nightNumber: number;
}) {
  const alreadyChecked = history.some(h => h.nightNumber === nightNumber);
  const submitCheck = useMutation(api.night.submitSeerCheck);
  const tickNight = useMutation(api.night.tickNight);
  const [submitting, setSubmitting] = useState(false);
  const [pendingTarget, setPendingTarget] = useState<{
    id: Id<'players'>;
    name: string;
  } | null>(null);
  const [pendingResult, setPendingResult] = useState<{
    name: string;
    team: 'wolf' | 'villager';
  } | null>(null);
  const fadeAnim = useState(new Animated.Value(0))[0];

  useEffect(() => {
    if (pendingResult) {
      fadeAnim.setValue(0);
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 280,
        easing: Easing.out(Easing.ease),
        useNativeDriver: true,
      }).start();
    }
  }, [pendingResult, fadeAnim]);

  function handlePickTarget(targetId: Id<'players'>, name: string) {
    if (submitting || pendingTarget || pendingResult) return;
    setPendingTarget({ id: targetId, name });
  }

  async function handleConfirm() {
    if (!pendingTarget || submitting) return;
    setSubmitting(true);
    try {
      const result = await submitCheck({
        gameId,
        callerDeviceClientId: deviceClientId,
        targetPlayerId: pendingTarget.id,
      });
      setPendingResult({ name: pendingTarget.name, team: result.team });
      setPendingTarget(null);
    } catch (e) {
      Alert.alert('Could not check', e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  function handleCancel() {
    if (submitting) return;
    setPendingTarget(null);
  }

  async function handleAck() {
    if (!pendingResult) return;
    try {
      // Asks the engine to advance — but the dwell may not be over yet, in
      // which case this is a no-op and the scheduled tick will advance later.
      await tickNight({ gameId, callerDeviceClientId: deviceClientId });
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : String(e));
    } finally {
      setPendingResult(null);
    }
  }

  // Once the player has checked, hide the picker — we hold here until the
  // step's dwell ends, which keeps the on-screen "the seer is awake" timing
  // uniform whether the seer is alive or dead.
  if (alreadyChecked && !pendingResult) {
    return (
      <View className="flex-1 px-6 pt-2 pb-8">
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color="#D4A017" />
          <Text className="text-wolf-muted text-sm text-center mt-6 px-4">
            Your check is in. Waiting for the night to settle…
          </Text>
        </View>
        {history.length > 0 && (
          <View className="bg-wolf-card rounded-xl px-4 py-3">
            <Text className="text-wolf-muted text-xs font-bold tracking-widest mb-2">
              YOUR CHECKS
            </Text>
            {history.map((h, i) => (
              <View key={i} className="flex-row justify-between py-1">
                <Text className="text-wolf-text text-sm">
                  Night {h.nightNumber} — {h.targetName}
                </Text>
                <Text
                  className="text-sm font-bold"
                  style={{ color: h.team === 'wolf' ? '#B03A2E' : '#5BA0E5' }}
                >
                  {h.team === 'wolf' ? 'WOLF' : 'VILLAGER'}
                </Text>
              </View>
            ))}
          </View>
        )}
      </View>
    );
  }

  return (
    <View className="flex-1">
      <ScrollView contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: 24 }}>
        <Text className="text-wolf-text text-base text-center mt-2 mb-4">
          Choose a player to investigate.
        </Text>

        {history.length > 0 && (
          <View className="bg-wolf-card rounded-xl px-4 py-3 mb-5">
            <Text className="text-wolf-muted text-xs font-bold tracking-widest mb-2">
              YOUR CHECKS
            </Text>
            {history.map((h, i) => (
              <View key={i} className="flex-row justify-between py-1">
                <Text className="text-wolf-text text-sm">
                  Night {h.nightNumber} — {h.targetName}
                </Text>
                <Text
                  className="text-sm font-bold"
                  style={{ color: h.team === 'wolf' ? '#B03A2E' : '#5BA0E5' }}
                >
                  {h.team === 'wolf' ? 'WOLF' : 'VILLAGER'}
                </Text>
              </View>
            ))}
          </View>
        )}

        <View style={{ alignItems: 'center' }}>
          <SeatingCircle
            totalSeats={totalSeats}
            players={alivePlayers}
            meId={meId}
            selectableIds={
              new Set(targetables.map(t => t._id as unknown as string))
            }
            onPress={
              submitting || pendingTarget || pendingResult
                ? undefined
                : p => handlePickTarget(p._id, p.name)
            }
          />
        </View>
      </ScrollView>

      {/* Confirmation overlay — guards against misclicks before the role
          information is given. Uses the same dark backdrop as the result
          overlay for visual consistency. */}
      {pendingTarget && !pendingResult && (
        <View
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 0,
            bottom: 0,
            backgroundColor: 'rgba(0,0,0,0.92)',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 32,
          }}
        >
          <Text className="text-wolf-muted text-xs font-bold tracking-widest mb-3">
            INVESTIGATE
          </Text>
          <Text className="text-wolf-text text-3xl font-extrabold text-center mb-2">
            {pendingTarget.name.toUpperCase()}
          </Text>
          <Text className="text-wolf-muted text-sm text-center mb-10">
            Are you sure?
          </Text>
          <View className="flex-row" style={{ gap: 14 }}>
            <TouchableOpacity
              onPress={handleCancel}
              disabled={submitting}
              className="bg-wolf-card rounded-xl py-4 px-10"
              style={{ borderWidth: 1, borderColor: '#3A3A48' }}
            >
              <Text className="text-wolf-text text-base font-extrabold tracking-widest">
                NO
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleConfirm}
              disabled={submitting}
              style={{ opacity: submitting ? 0.4 : 1 }}
              className="bg-wolf-accent rounded-xl py-4 px-10"
            >
              {submitting ? (
                <ActivityIndicator color="#0F0F14" />
              ) : (
                <Text className="text-wolf-bg text-base font-extrabold tracking-widest">
                  YES
                </Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Result overlay — blocks until the player taps OK, so they have time
          to read the team before the night advances to morning. */}
      {pendingResult && (
        <Animated.View
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 0,
            bottom: 0,
            backgroundColor: 'rgba(0,0,0,0.92)',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 32,
            opacity: fadeAnim,
          }}
        >
          <View
            className="rounded-2xl px-10 py-10 items-center"
            style={{
              backgroundColor:
                pendingResult.team === 'wolf' ? '#8B1818' : '#1F4E80',
              minWidth: 240,
            }}
          >
            <Text className="text-wolf-text text-xs font-bold tracking-widest mb-3">
              {pendingResult.name.toUpperCase()} IS A
            </Text>
            <Text className="text-wolf-text text-5xl font-extrabold tracking-widest">
              {pendingResult.team === 'wolf' ? 'WOLF' : 'VILLAGER'}
            </Text>
          </View>
          <TouchableOpacity
            onPress={handleAck}
            className="bg-wolf-accent rounded-xl py-4 px-10 mt-10"
          >
            <Text className="text-wolf-bg text-base font-extrabold tracking-widest">
              OK
            </Text>
          </TouchableOpacity>
        </Animated.View>
      )}
    </View>
  );
}

// ───── Waiting view ─────────────────────────────────────────────────────────

// ───── PI picker ───────────────────────────────────────────────────────────

function PIPicker({
  gameId,
  deviceClientId,
  alivePlayers,
  targetables,
  totalSeats,
  meId,
  piState,
}: {
  gameId: Id<'games'>;
  deviceClientId: string;
  alivePlayers: SeatingPlayer[];
  targetables: Targetable[];
  totalSeats: number;
  meId: Id<'players'>;
  piState: {
    piUsed: boolean;
    hasActedThisNight: boolean;
    history: Array<{
      nightNumber: number;
      targetName: string;
      team: 'wolf' | 'village';
    }>;
  };
}) {
  const submitCheck = useMutation(api.night.submitPICheck);
  const submitSkip = useMutation(api.night.submitPISkip);
  const tickNight = useMutation(api.night.tickNight);

  const [submitting, setSubmitting] = useState(false);
  const [pendingTarget, setPendingTarget] = useState<{
    id: Id<'players'>;
    name: string;
  } | null>(null);
  const [pendingResult, setPendingResult] = useState<{
    name: string;
    team: 'wolf' | 'village';
  } | null>(null);
  const fadeAnim = useState(new Animated.Value(0))[0];

  useEffect(() => {
    if (pendingResult) {
      fadeAnim.setValue(0);
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 280,
        easing: Easing.out(Easing.ease),
        useNativeDriver: true,
      }).start();
    }
  }, [pendingResult, fadeAnim]);

  function handlePickTarget(targetId: Id<'players'>, name: string) {
    if (submitting || pendingTarget || pendingResult) return;
    setPendingTarget({ id: targetId, name });
  }

  async function handleConfirm() {
    if (!pendingTarget || submitting) return;
    setSubmitting(true);
    try {
      const result = await submitCheck({
        gameId,
        callerDeviceClientId: deviceClientId,
        targetPlayerId: pendingTarget.id,
      });
      setPendingResult({ name: pendingTarget.name, team: result.team });
      setPendingTarget(null);
    } catch (e) {
      Alert.alert('Could not investigate', e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  function handleCancel() {
    if (submitting) return;
    setPendingTarget(null);
  }

  async function handleAck() {
    if (!pendingResult) return;
    try {
      await tickNight({ gameId, callerDeviceClientId: deviceClientId });
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : String(e));
    } finally {
      setPendingResult(null);
    }
  }

  async function handleSkip() {
    if (submitting) return;
    setSubmitting(true);
    try {
      await submitSkip({ gameId, callerDeviceClientId: deviceClientId });
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  if (piState.hasActedThisNight && !pendingResult) {
    return (
      <View className="flex-1 px-6 pt-2 pb-8">
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color="#D4A017" />
          <Text className="text-wolf-muted text-sm text-center mt-6 px-4">
            {piState.history.length > 0 &&
            piState.history[piState.history.length - 1]?.nightNumber !==
              undefined
              ? 'Your check is in. Waiting for the night to settle…'
              : 'Saved for later. Waiting for the night to settle…'}
          </Text>
        </View>
        {piState.history.length > 0 && (
          <View className="bg-wolf-card rounded-xl px-4 py-3">
            <Text className="text-wolf-muted text-xs font-bold tracking-widest mb-2">
              YOUR CHECK
            </Text>
            {piState.history.map((h, i) => (
              <View key={i} className="flex-row justify-between py-1">
                <Text className="text-wolf-text text-sm">
                  Night {h.nightNumber} — {h.targetName} (+ neighbors)
                </Text>
                <Text
                  className="text-sm font-bold"
                  style={{ color: h.team === 'wolf' ? '#B03A2E' : '#5BA0E5' }}
                >
                  {h.team === 'wolf' ? 'WOLF' : 'VILLAGE'}
                </Text>
              </View>
            ))}
          </View>
        )}
      </View>
    );
  }

  return (
    <View className="flex-1">
      <ScrollView contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: 16 }}>
        <Text className="text-wolf-text text-base text-center mt-2 mb-2">
          One-time investigation. Pick a target to read them and their two
          neighbors as a group.
        </Text>

        <View style={{ alignItems: 'center' }}>
          <SeatingCircle
            totalSeats={totalSeats}
            players={alivePlayers}
            meId={meId}
            selectableIds={
              new Set(targetables.map(t => t._id as unknown as string))
            }
            onPress={
              submitting || pendingTarget || pendingResult
                ? undefined
                : p => handlePickTarget(p._id, p.name)
            }
          />
        </View>
      </ScrollView>

      <View className="px-6 pb-3">
        <TouchableOpacity
          onPress={handleSkip}
          disabled={submitting || !!pendingTarget || !!pendingResult}
          style={{
            opacity: submitting || pendingTarget || pendingResult ? 0.4 : 1,
          }}
          className="bg-wolf-card rounded-xl py-4 items-center"
        >
          <Text className="text-wolf-muted text-base font-bold tracking-widest">
            SAVE FOR LATER
          </Text>
        </TouchableOpacity>
      </View>

      {/* Confirmation overlay */}
      {pendingTarget && !pendingResult && (
        <View
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 0,
            bottom: 0,
            backgroundColor: 'rgba(0,0,0,0.92)',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 32,
          }}
        >
          <Text className="text-wolf-muted text-xs font-bold tracking-widest mb-3">
            INVESTIGATE
          </Text>
          <Text className="text-wolf-text text-3xl font-extrabold text-center mb-2">
            {pendingTarget.name.toUpperCase()}
          </Text>
          <Text className="text-wolf-muted text-sm text-center mb-10">
            Your only investigation. Are you sure?
          </Text>
          <View className="flex-row" style={{ gap: 14 }}>
            <TouchableOpacity
              onPress={handleCancel}
              disabled={submitting}
              className="bg-wolf-card rounded-xl py-4 px-10"
              style={{ borderWidth: 1, borderColor: '#3A3A48' }}
            >
              <Text className="text-wolf-text text-base font-extrabold tracking-widest">
                NO
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleConfirm}
              disabled={submitting}
              style={{ opacity: submitting ? 0.4 : 1 }}
              className="bg-wolf-accent rounded-xl py-4 px-10"
            >
              {submitting ? (
                <ActivityIndicator color="#0F0F14" />
              ) : (
                <Text className="text-wolf-bg text-base font-extrabold tracking-widest">
                  YES
                </Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Result overlay */}
      {pendingResult && (
        <Animated.View
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 0,
            bottom: 0,
            backgroundColor: 'rgba(0,0,0,0.92)',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 32,
            opacity: fadeAnim,
          }}
        >
          <View
            className="rounded-2xl px-10 py-10 items-center"
            style={{
              backgroundColor:
                pendingResult.team === 'wolf' ? '#8B1818' : '#1F4E80',
              minWidth: 240,
            }}
          >
            <Text className="text-wolf-text text-xs font-bold tracking-widest mb-3">
              {pendingResult.name.toUpperCase()} + NEIGHBORS
            </Text>
            <Text className="text-wolf-text text-5xl font-extrabold tracking-widest">
              {pendingResult.team === 'wolf' ? 'WOLF' : 'VILLAGE'}
            </Text>
          </View>
          <TouchableOpacity
            onPress={handleAck}
            className="bg-wolf-accent rounded-xl py-4 px-10 mt-10"
          >
            <Text className="text-wolf-bg text-base font-extrabold tracking-widest">
              OK
            </Text>
          </TouchableOpacity>
        </Animated.View>
      )}
    </View>
  );
}

// ───── Mentalist picker ───────────────────────────────────────────────────

function MentalistPicker({
  gameId,
  deviceClientId,
  alivePlayers,
  targetables,
  totalSeats,
  meId,
  mentalistState,
  nightNumber,
}: {
  gameId: Id<'games'>;
  deviceClientId: string;
  alivePlayers: SeatingPlayer[];
  targetables: Targetable[];
  totalSeats: number;
  meId: Id<'players'>;
  mentalistState: {
    hasActedThisNight: boolean;
    noValidTargets: boolean;
    lockedTargets: Array<{ _id: Id<'players'>; name: string }>;
    history: Array<{
      nightNumber: number;
      firstName: string;
      secondName: string;
      sameTeam: 'same' | 'different';
    }>;
  };
  nightNumber: number;
}) {
  const submitCheck = useMutation(api.night.submitMentalistCheck);
  const tickNight = useMutation(api.night.tickNight);

  const [submitting, setSubmitting] = useState(false);
  const [picks, setPicks] = useState<Array<{ id: Id<'players'>; name: string }>>(
    [],
  );
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingResult, setPendingResult] = useState<{
    firstName: string;
    secondName: string;
    sameTeam: 'same' | 'different';
  } | null>(null);
  const fadeAnim = useState(new Animated.Value(0))[0];

  useEffect(() => {
    if (pendingResult) {
      fadeAnim.setValue(0);
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 280,
        easing: Easing.out(Easing.ease),
        useNativeDriver: true,
      }).start();
    }
  }, [pendingResult, fadeAnim]);

  const selectableSet = new Set(
    targetables.map(t => t._id as unknown as string),
  );
  const selectedSet = new Set(picks.map(p => p.id as unknown as string));

  function handleTap(player: SeatingPlayer) {
    if (submitting || confirmOpen || pendingResult) return;
    if (picks.find(p => p.id === player._id)) {
      // deselect
      setPicks(picks.filter(p => p.id !== player._id));
      return;
    }
    if (picks.length >= 2) return; // already two selected
    setPicks([...picks, { id: player._id, name: player.name }]);
  }

  async function handleConfirm() {
    if (picks.length !== 2 || submitting) return;
    setSubmitting(true);
    try {
      const result = await submitCheck({
        gameId,
        callerDeviceClientId: deviceClientId,
        firstPlayerId: picks[0].id,
        secondPlayerId: picks[1].id,
      });
      setPendingResult({
        firstName: picks[0].name,
        secondName: picks[1].name,
        sameTeam: result.sameTeam,
      });
      setConfirmOpen(false);
      setPicks([]);
    } catch (e) {
      Alert.alert('Could not compare', e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleAck() {
    try {
      await tickNight({ gameId, callerDeviceClientId: deviceClientId });
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : String(e));
    } finally {
      setPendingResult(null);
    }
  }

  // Shorthanded — last night's two targets plus the alive pool leave fewer
  // than two legal picks. The engine auto-passes the step; we just explain
  // what's happening while the dwell runs.
  if (mentalistState.noValidTargets) {
    const lockedNames = mentalistState.lockedTargets.map(t => t.name);
    return (
      <View className="flex-1 px-6 pt-2 pb-8">
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color="#D4A017" />
          <Text className="text-wolf-text text-base text-center mt-6 px-4">
            Not enough new options tonight.
          </Text>
          <Text className="text-wolf-muted text-sm text-center mt-3 px-6">
            {lockedNames.length > 0
              ? `Last night you read ${lockedNames.join(' & ')}, and they can't be picked back-to-back.`
              : 'You need at least two valid targets to read.'}
          </Text>
          <Text className="text-wolf-muted text-xs text-center mt-4 px-6">
            Passing for the night…
          </Text>
        </View>
      </View>
    );
  }

  if (mentalistState.hasActedThisNight && !pendingResult) {
    const last = mentalistState.history[mentalistState.history.length - 1];
    return (
      <View className="flex-1 px-6 pt-2 pb-8">
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color="#D4A017" />
          <Text className="text-wolf-muted text-sm text-center mt-6 px-4">
            Your comparison is in. Waiting for the night to settle…
          </Text>
        </View>
        {last && (
          <View className="bg-wolf-card rounded-xl px-4 py-3">
            <Text className="text-wolf-muted text-xs font-bold tracking-widest mb-2">
              TONIGHT'S READING
            </Text>
            <Text className="text-wolf-text text-sm">
              {last.firstName} & {last.secondName}
            </Text>
            <Text
              className="text-sm font-bold mt-1"
              style={{
                color: last.sameTeam === 'same' ? '#5BA0E5' : '#E07070',
              }}
            >
              {last.sameTeam === 'same' ? 'SAME TEAM' : 'DIFFERENT TEAMS'}
            </Text>
          </View>
        )}
      </View>
    );
  }

  return (
    <View className="flex-1">
      <ScrollView contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: 16 }}>
        <Text className="text-wolf-text text-base text-center mt-2 mb-2">
          Pick two players. You'll be told whether they share a team.
        </Text>

        {mentalistState.lockedTargets.length > 0 && (
          <View className="bg-wolf-card rounded-xl px-4 py-3 mb-3">
            <Text className="text-wolf-muted text-xs leading-5">
              Off-limits tonight (read them last night):{' '}
              <Text className="text-wolf-text">
                {mentalistState.lockedTargets.map(t => t.name).join(' & ')}
              </Text>
            </Text>
          </View>
        )}

        {mentalistState.history.length > 0 && (
          <View className="bg-wolf-card rounded-xl px-4 py-3 mb-4">
            <Text className="text-wolf-muted text-xs font-bold tracking-widest mb-2">
              YOUR READINGS
            </Text>
            {mentalistState.history.map((h, i) => (
              <View key={i} className="py-1">
                <View className="flex-row justify-between">
                  <Text className="text-wolf-text text-sm">
                    Night {h.nightNumber} — {h.firstName} & {h.secondName}
                  </Text>
                  <Text
                    className="text-sm font-bold"
                    style={{
                      color: h.sameTeam === 'same' ? '#5BA0E5' : '#E07070',
                    }}
                  >
                    {h.sameTeam === 'same' ? 'SAME' : 'DIFFERENT'}
                  </Text>
                </View>
              </View>
            ))}
          </View>
        )}

        <View style={{ alignItems: 'center' }}>
          <SeatingCircle
            totalSeats={totalSeats}
            players={alivePlayers}
            meId={meId}
            selectedIds={selectedSet}
            selectableIds={selectableSet}
            onPress={
              submitting || confirmOpen || pendingResult ? undefined : handleTap
            }
          />
        </View>

        <View className="bg-wolf-card rounded-xl px-4 py-3 mt-4">
          <Text className="text-wolf-muted text-xs font-bold tracking-widest mb-2">
            YOUR PICKS ({picks.length} / 2)
          </Text>
          <Text className="text-wolf-text text-sm">
            {picks.length === 0
              ? 'Tap a player to select them.'
              : picks.map(p => p.name).join(' & ')}
          </Text>
        </View>
      </ScrollView>

      <View className="px-6 pb-3">
        <TouchableOpacity
          onPress={() => setConfirmOpen(true)}
          disabled={picks.length !== 2 || submitting}
          style={{ opacity: picks.length === 2 ? 1 : 0.4 }}
          className="bg-wolf-accent rounded-xl py-5 items-center"
        >
          <Text className="text-wolf-bg text-lg font-extrabold tracking-widest">
            CONFIRM
          </Text>
        </TouchableOpacity>
      </View>

      {/* Confirmation overlay */}
      {confirmOpen && (
        <View
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 0,
            bottom: 0,
            backgroundColor: 'rgba(0,0,0,0.92)',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 32,
          }}
        >
          <Text className="text-wolf-muted text-xs font-bold tracking-widest mb-3">
            COMPARE
          </Text>
          <Text className="text-wolf-text text-2xl font-extrabold text-center">
            {picks[0]?.name.toUpperCase()}
          </Text>
          <Text className="text-wolf-muted text-base text-center my-2">vs</Text>
          <Text className="text-wolf-text text-2xl font-extrabold text-center mb-10">
            {picks[1]?.name.toUpperCase()}
          </Text>
          <View className="flex-row" style={{ gap: 14 }}>
            <TouchableOpacity
              onPress={() => setConfirmOpen(false)}
              disabled={submitting}
              className="bg-wolf-card rounded-xl py-4 px-10"
              style={{ borderWidth: 1, borderColor: '#3A3A48' }}
            >
              <Text className="text-wolf-text text-base font-extrabold tracking-widest">
                NO
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleConfirm}
              disabled={submitting}
              style={{ opacity: submitting ? 0.4 : 1 }}
              className="bg-wolf-accent rounded-xl py-4 px-10"
            >
              {submitting ? (
                <ActivityIndicator color="#0F0F14" />
              ) : (
                <Text className="text-wolf-bg text-base font-extrabold tracking-widest">
                  YES
                </Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Result overlay */}
      {pendingResult && (
        <Animated.View
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 0,
            bottom: 0,
            backgroundColor: 'rgba(0,0,0,0.92)',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 32,
            opacity: fadeAnim,
          }}
        >
          <View
            className="rounded-2xl px-10 py-10 items-center"
            style={{
              backgroundColor:
                pendingResult.sameTeam === 'same' ? '#1F4E80' : '#5A2F80',
              minWidth: 260,
            }}
          >
            <Text className="text-wolf-text text-xs font-bold tracking-widest mb-3 text-center">
              {pendingResult.firstName.toUpperCase()} &{' '}
              {pendingResult.secondName.toUpperCase()}
            </Text>
            <Text className="text-wolf-text text-3xl font-extrabold tracking-widest text-center">
              {pendingResult.sameTeam === 'same'
                ? 'SAME TEAM'
                : 'DIFFERENT TEAMS'}
            </Text>
          </View>
          <TouchableOpacity
            onPress={handleAck}
            className="bg-wolf-accent rounded-xl py-4 px-10 mt-10"
          >
            <Text className="text-wolf-bg text-base font-extrabold tracking-widest">
              OK
            </Text>
          </TouchableOpacity>
        </Animated.View>
      )}
    </View>
  );
}

// ───── Witch picker ────────────────────────────────────────────────────────

function WitchPicker({
  gameId,
  deviceClientId,
  alivePlayers,
  targetables,
  totalSeats,
  meId,
  witchState,
}: {
  gameId: Id<'games'>;
  deviceClientId: string;
  alivePlayers: SeatingPlayer[];
  targetables: Targetable[];
  totalSeats: number;
  meId: Id<'players'>;
  witchState: {
    saveUsed: boolean;
    poisonUsed: boolean;
    savedTonight: boolean;
    poisonedTonight: boolean;
    hasActedThisNight: boolean;
    tonightVictim: { _id: Id<'players'>; name: string } | null;
  };
}) {
  const submitSave = useMutation(api.night.submitWitchSave);
  const submitPoison = useMutation(api.night.submitWitchPoison);
  const submitDone = useMutation(api.night.submitWitchDone);

  const [submitting, setSubmitting] = useState(false);
  const [confirmSave, setConfirmSave] = useState(false);
  const [poisonPickerOpen, setPoisonPickerOpen] = useState(false);
  const [confirmPoison, setConfirmPoison] = useState<{
    id: Id<'players'>;
    name: string;
  } | null>(null);

  async function handleSave() {
    setSubmitting(true);
    try {
      await submitSave({ gameId, callerDeviceClientId: deviceClientId });
      setConfirmSave(false);
    } catch (e) {
      Alert.alert('Could not save', e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  async function handlePoison() {
    if (!confirmPoison) return;
    setSubmitting(true);
    try {
      await submitPoison({
        gameId,
        callerDeviceClientId: deviceClientId,
        targetPlayerId: confirmPoison.id,
      });
      setConfirmPoison(null);
      setPoisonPickerOpen(false);
    } catch (e) {
      Alert.alert('Could not poison', e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDone() {
    setSubmitting(true);
    try {
      await submitDone({ gameId, callerDeviceClientId: deviceClientId });
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  if (witchState.hasActedThisNight) {
    return (
      <View className="flex-1 px-6 pt-2 pb-8">
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color="#D4A017" />
          <Text className="text-wolf-muted text-sm text-center mt-6 px-4">
            Your turn is over. Waiting for the night to settle…
          </Text>
        </View>
      </View>
    );
  }

  const canSave =
    !witchState.saveUsed &&
    !witchState.savedTonight &&
    witchState.tonightVictim !== null;
  const canPoison = !witchState.poisonUsed && !witchState.poisonedTonight;

  return (
    <View className="flex-1">
      <ScrollView contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: 16 }}>
        <View className="bg-wolf-card rounded-xl px-4 py-3 mt-2 mb-4">
          <Text className="text-wolf-muted text-xs font-bold tracking-widest mb-1">
            TONIGHT'S VICTIM
          </Text>
          {witchState.saveUsed ? (
            <Text className="text-wolf-muted text-sm italic">
              You can no longer see the wolves' victim — your save potion is
              spent.
            </Text>
          ) : witchState.tonightVictim ? (
            <Text className="text-wolf-text text-2xl font-bold tracking-widest">
              {witchState.tonightVictim.name.toUpperCase()}
            </Text>
          ) : (
            <Text className="text-wolf-muted text-sm italic">
              No victim tonight.
            </Text>
          )}
        </View>

        <Text className="text-wolf-muted text-xs font-bold tracking-widest mb-2">
          POTIONS
        </Text>
        <View style={{ gap: 10 }}>
          <TouchableOpacity
            onPress={() => setConfirmSave(true)}
            disabled={!canSave || submitting}
            activeOpacity={0.75}
            className="bg-wolf-card rounded-xl px-4 py-4"
            style={{
              borderWidth: 1,
              borderColor: canSave ? '#5BA0E5' : '#2A2A38',
              opacity: canSave ? 1 : 0.4,
            }}
          >
            <Text
              className="text-base font-bold tracking-widest"
              style={{ color: canSave ? '#5BA0E5' : '#5A5560' }}
            >
              {witchState.savedTonight
                ? 'SAVE CAST'
                : witchState.saveUsed
                  ? 'SAVE POTION USED'
                  : 'USE SAVE POTION'}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={() => setPoisonPickerOpen(true)}
            disabled={!canPoison || submitting}
            activeOpacity={0.75}
            className="bg-wolf-card rounded-xl px-4 py-4"
            style={{
              borderWidth: 1,
              borderColor: canPoison ? '#B03A2E' : '#2A2A38',
              opacity: canPoison ? 1 : 0.4,
            }}
          >
            <Text
              className="text-base font-bold tracking-widest"
              style={{ color: canPoison ? '#E07070' : '#5A5560' }}
            >
              {witchState.poisonedTonight
                ? 'POISON CAST'
                : witchState.poisonUsed
                  ? 'POISON POTION USED'
                  : 'USE POISON'}
            </Text>
          </TouchableOpacity>
        </View>
      </ScrollView>

      <View className="px-6 pb-3">
        <TouchableOpacity
          onPress={handleDone}
          disabled={submitting}
          style={{ opacity: submitting ? 0.4 : 1 }}
          className="bg-wolf-accent rounded-xl py-5 items-center"
        >
          {submitting ? (
            <ActivityIndicator color="#0F0F14" />
          ) : (
            <Text className="text-wolf-bg text-lg font-extrabold tracking-widest">
              I'M DONE
            </Text>
          )}
        </TouchableOpacity>
      </View>

      {/* Save confirmation */}
      {confirmSave && (
        <View
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 0,
            bottom: 0,
            backgroundColor: 'rgba(0,0,0,0.92)',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 32,
          }}
        >
          <Text className="text-wolf-muted text-xs font-bold tracking-widest mb-3">
            SAVE
          </Text>
          <Text className="text-wolf-text text-3xl font-extrabold text-center mb-2">
            {witchState.tonightVictim?.name.toUpperCase()}
          </Text>
          <Text className="text-wolf-muted text-sm text-center mb-10">
            This is your only save potion.
          </Text>
          <View className="flex-row" style={{ gap: 14 }}>
            <TouchableOpacity
              onPress={() => setConfirmSave(false)}
              disabled={submitting}
              className="bg-wolf-card rounded-xl py-4 px-10"
              style={{ borderWidth: 1, borderColor: '#3A3A48' }}
            >
              <Text className="text-wolf-text text-base font-extrabold tracking-widest">
                NO
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleSave}
              disabled={submitting}
              style={{ opacity: submitting ? 0.4 : 1 }}
              className="bg-wolf-accent rounded-xl py-4 px-10"
            >
              {submitting ? (
                <ActivityIndicator color="#0F0F14" />
              ) : (
                <Text className="text-wolf-bg text-base font-extrabold tracking-widest">
                  YES
                </Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Poison picker */}
      <Modal
        visible={poisonPickerOpen && !confirmPoison}
        transparent
        animationType="fade"
        onRequestClose={() => setPoisonPickerOpen(false)}
      >
        <Pressable
          onPress={() => setPoisonPickerOpen(false)}
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
            style={{ maxHeight: '80%' }}
          >
            <Text className="text-wolf-text text-lg font-bold mb-3 text-center">
              Poison
            </Text>
            <View style={{ alignItems: 'center', paddingVertical: 8 }}>
              <SeatingCircle
                totalSeats={totalSeats}
                players={alivePlayers}
                meId={meId}
                selectableIds={
                  new Set(targetables.map(t => t._id as unknown as string))
                }
                onPress={p => setConfirmPoison({ id: p._id, name: p.name })}
                size={280}
              />
            </View>
            <TouchableOpacity onPress={() => setPoisonPickerOpen(false)} className="mt-3 py-2">
              <Text className="text-wolf-muted text-center">Cancel</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Poison confirmation */}
      {confirmPoison && (
        <View
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 0,
            bottom: 0,
            backgroundColor: 'rgba(0,0,0,0.92)',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 32,
          }}
        >
          <Text className="text-wolf-muted text-xs font-bold tracking-widest mb-3">
            POISON
          </Text>
          <Text className="text-wolf-text text-3xl font-extrabold text-center mb-2">
            {confirmPoison.name.toUpperCase()}
          </Text>
          <Text className="text-wolf-muted text-sm text-center mb-10">
            This is your only poison potion.
          </Text>
          <View className="flex-row" style={{ gap: 14 }}>
            <TouchableOpacity
              onPress={() => setConfirmPoison(null)}
              disabled={submitting}
              className="bg-wolf-card rounded-xl py-4 px-10"
              style={{ borderWidth: 1, borderColor: '#3A3A48' }}
            >
              <Text className="text-wolf-text text-base font-extrabold tracking-widest">
                NO
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handlePoison}
              disabled={submitting}
              style={{ opacity: submitting ? 0.4 : 1 }}
              className="bg-wolf-red rounded-xl py-4 px-10"
            >
              {submitting ? (
                <ActivityIndicator color="#F0EDE8" />
              ) : (
                <Text className="text-wolf-text text-base font-extrabold tracking-widest">
                  YES
                </Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      )}
    </View>
  );
}

// ───── Bodyguard picker ────────────────────────────────────────────────────

function BodyguardPicker({
  gameId,
  deviceClientId,
  alivePlayers,
  targetables,
  totalSeats,
  bgState,
  meId,
}: {
  gameId: Id<'games'>;
  deviceClientId: string;
  alivePlayers: SeatingPlayer[];
  targetables: Targetable[];
  totalSeats: number;
  bgState: {
    selfProtectUsed: boolean;
    lastProtectedPlayerId: Id<'players'> | null;
    lastProtectedName: string | null;
    hasActedThisNight: boolean;
  };
  meId: Id<'players'>;
}) {
  const submitProtect = useMutation(api.night.submitBGProtect);
  const [submitting, setSubmitting] = useState(false);

  async function handleProtect(targetId: Id<'players'>) {
    if (submitting || bgState.hasActedThisNight) return;
    setSubmitting(true);
    try {
      await submitProtect({
        gameId,
        callerDeviceClientId: deviceClientId,
        targetPlayerId: targetId,
      });
    } catch (e) {
      Alert.alert(
        'Could not protect',
        e instanceof Error ? e.message : String(e),
      );
    } finally {
      setSubmitting(false);
    }
  }

  // After acting, hold the screen until the dwell ends — same cloaking
  // pattern as SeerPicker.
  if (bgState.hasActedThisNight) {
    return (
      <View className="flex-1 px-6 pt-2 pb-8">
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color="#D4A017" />
          <Text className="text-wolf-muted text-sm text-center mt-6 px-4">
            Your protection is in. Waiting for the night to settle…
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View className="flex-1">
      <ScrollView contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: 24 }}>
        <Text className="text-wolf-text text-base text-center mt-2 mb-2">
          Choose a player to protect tonight.
        </Text>
        <View className="bg-wolf-card rounded-xl px-4 py-3 mb-4">
          <Text className="text-wolf-muted text-xs leading-5">
            {bgState.lastProtectedName
              ? `Last night: ${bgState.lastProtectedName}. You cannot pick the same player two nights in a row.\n`
              : ''}
            {bgState.selfProtectUsed
              ? 'Your one self-protect has already been used.'
              : 'You may protect yourself once per game.'}
          </Text>
        </View>

        <View style={{ alignItems: 'center' }}>
          <SeatingCircle
            totalSeats={totalSeats}
            players={alivePlayers}
            meId={meId}
            selectableIds={
              new Set(targetables.map(t => t._id as unknown as string))
            }
            onPress={submitting ? undefined : p => handleProtect(p._id)}
          />
        </View>
      </ScrollView>
    </View>
  );
}

// ───── Huntress picker ─────────────────────────────────────────────────────
//
// One-time night shot. Pick a target and confirm, or pass to save the shot.
// No instant result modal — hits and misses surface together at morning per
// the no-night-announcements house rule.

function HuntressPicker({
  gameId,
  deviceClientId,
  alivePlayers,
  targetables,
  totalSeats,
  huntressState,
  meId,
}: {
  gameId: Id<'games'>;
  deviceClientId: string;
  alivePlayers: SeatingPlayer[];
  targetables: Targetable[];
  totalSeats: number;
  huntressState: {
    huntressUsed: boolean;
    hasActedThisNight: boolean;
  };
  meId: Id<'players'>;
}) {
  const submitShot = useMutation(api.night.submitHuntressShot);
  const submitSkip = useMutation(api.night.submitHuntressSkip);
  const [submitting, setSubmitting] = useState(false);
  const [pendingTarget, setPendingTarget] = useState<{
    id: Id<'players'>;
    name: string;
  } | null>(null);

  function handlePickTarget(targetId: Id<'players'>, name: string) {
    if (submitting || pendingTarget) return;
    setPendingTarget({ id: targetId, name });
  }

  async function handleConfirm() {
    if (!pendingTarget || submitting) return;
    setSubmitting(true);
    try {
      await submitShot({
        gameId,
        callerDeviceClientId: deviceClientId,
        targetPlayerId: pendingTarget.id,
      });
      setPendingTarget(null);
    } catch (e) {
      Alert.alert('Could not shoot', e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  function handleCancel() {
    if (submitting) return;
    setPendingTarget(null);
  }

  async function handleSkip() {
    if (submitting) return;
    setSubmitting(true);
    try {
      await submitSkip({ gameId, callerDeviceClientId: deviceClientId });
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  if (huntressState.hasActedThisNight) {
    return (
      <View className="flex-1 px-6 pt-2 pb-8">
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color="#D4A017" />
          <Text className="text-wolf-muted text-sm text-center mt-6 px-4">
            Waiting for the night to settle…
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View className="flex-1">
      <ScrollView contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: 16 }}>
        <Text className="text-wolf-text text-base text-center mt-2 mb-2">
          One-time shot. Pick a target to shoot, or save it for later.
        </Text>
        <View style={{ alignItems: 'center' }}>
          <SeatingCircle
            totalSeats={totalSeats}
            players={alivePlayers}
            meId={meId}
            selectableIds={
              new Set(targetables.map(t => t._id as unknown as string))
            }
            onPress={
              submitting || pendingTarget
                ? undefined
                : p => handlePickTarget(p._id, p.name)
            }
          />
        </View>
      </ScrollView>

      <View className="px-6 pb-3">
        <TouchableOpacity
          onPress={handleSkip}
          disabled={submitting || !!pendingTarget}
          style={{ opacity: submitting || pendingTarget ? 0.4 : 1 }}
          className="bg-wolf-card rounded-xl py-4 items-center"
        >
          <Text className="text-wolf-muted text-base font-bold tracking-widest">
            SAVE FOR LATER
          </Text>
        </TouchableOpacity>
      </View>

      {pendingTarget && (
        <View
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 0,
            bottom: 0,
            backgroundColor: 'rgba(0,0,0,0.92)',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 32,
          }}
        >
          <Text className="text-wolf-muted text-xs font-bold tracking-widest mb-3">
            SHOOT
          </Text>
          <Text className="text-wolf-text text-3xl font-extrabold text-center mb-2">
            {pendingTarget.name.toUpperCase()}
          </Text>
          <Text className="text-wolf-muted text-sm text-center mb-10">
            Your only shot. Are you sure?
          </Text>
          <View className="flex-row" style={{ gap: 14 }}>
            <TouchableOpacity
              onPress={handleCancel}
              disabled={submitting}
              className="bg-wolf-card rounded-xl py-4 px-10"
              style={{ borderWidth: 1, borderColor: '#3A3A48' }}
            >
              <Text className="text-wolf-text text-base font-extrabold tracking-widest">
                NO
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleConfirm}
              disabled={submitting}
              style={{ opacity: submitting ? 0.4 : 1 }}
              className="bg-wolf-accent rounded-xl py-4 px-10"
            >
              {submitting ? (
                <ActivityIndicator color="#0F0F14" />
              ) : (
                <Text className="text-wolf-bg text-base font-extrabold tracking-widest">
                  YES
                </Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      )}
    </View>
  );
}

// ───── Revealer picker ─────────────────────────────────────────────────────
//
// Optional every night. Die-on-miss: if the target isn't a wolf, the
// Revealer dies and the target lives. UI emphasises this risk in the
// confirm copy so the player can back out before locking in.

function RevealerPicker({
  gameId,
  deviceClientId,
  alivePlayers,
  targetables,
  totalSeats,
  revealerState,
  meId,
}: {
  gameId: Id<'games'>;
  deviceClientId: string;
  alivePlayers: SeatingPlayer[];
  targetables: Targetable[];
  totalSeats: number;
  revealerState: {
    hasActedThisNight: boolean;
  };
  meId: Id<'players'>;
}) {
  const submitShot = useMutation(api.night.submitRevealerShot);
  const submitSkip = useMutation(api.night.submitRevealerSkip);
  const [submitting, setSubmitting] = useState(false);
  const [pendingTarget, setPendingTarget] = useState<{
    id: Id<'players'>;
    name: string;
  } | null>(null);

  function handlePickTarget(targetId: Id<'players'>, name: string) {
    if (submitting || pendingTarget) return;
    setPendingTarget({ id: targetId, name });
  }

  async function handleConfirm() {
    if (!pendingTarget || submitting) return;
    setSubmitting(true);
    try {
      await submitShot({
        gameId,
        callerDeviceClientId: deviceClientId,
        targetPlayerId: pendingTarget.id,
      });
      setPendingTarget(null);
    } catch (e) {
      Alert.alert('Could not shoot', e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  function handleCancel() {
    if (submitting) return;
    setPendingTarget(null);
  }

  async function handleSkip() {
    if (submitting) return;
    setSubmitting(true);
    try {
      await submitSkip({ gameId, callerDeviceClientId: deviceClientId });
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  if (revealerState.hasActedThisNight) {
    return (
      <View className="flex-1 px-6 pt-2 pb-8">
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color="#D4A017" />
          <Text className="text-wolf-muted text-sm text-center mt-6 px-4">
            Waiting for the night to settle…
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View className="flex-1">
      <ScrollView contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: 16 }}>
        <Text className="text-wolf-text text-base text-center mt-2 mb-2">
          Pick a wolf to reveal them. If they aren't a wolf, you die instead.
        </Text>
        <View style={{ alignItems: 'center' }}>
          <SeatingCircle
            totalSeats={totalSeats}
            players={alivePlayers}
            meId={meId}
            selectableIds={
              new Set(targetables.map(t => t._id as unknown as string))
            }
            onPress={
              submitting || pendingTarget
                ? undefined
                : p => handlePickTarget(p._id, p.name)
            }
          />
        </View>
      </ScrollView>

      <View className="px-6 pb-3">
        <TouchableOpacity
          onPress={handleSkip}
          disabled={submitting || !!pendingTarget}
          style={{ opacity: submitting || pendingTarget ? 0.4 : 1 }}
          className="bg-wolf-card rounded-xl py-4 items-center"
        >
          <Text className="text-wolf-muted text-base font-bold tracking-widest">
            PASS TONIGHT
          </Text>
        </TouchableOpacity>
      </View>

      {pendingTarget && (
        <View
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 0,
            bottom: 0,
            backgroundColor: 'rgba(0,0,0,0.92)',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 32,
          }}
        >
          <Text className="text-wolf-muted text-xs font-bold tracking-widest mb-3">
            REVEAL
          </Text>
          <Text className="text-wolf-text text-3xl font-extrabold text-center mb-2">
            {pendingTarget.name.toUpperCase()}
          </Text>
          <Text className="text-wolf-muted text-sm text-center mb-10 px-4">
            If they aren't a wolf, you die. Are you sure?
          </Text>
          <View className="flex-row" style={{ gap: 14 }}>
            <TouchableOpacity
              onPress={handleCancel}
              disabled={submitting}
              className="bg-wolf-card rounded-xl py-4 px-10"
              style={{ borderWidth: 1, borderColor: '#3A3A48' }}
            >
              <Text className="text-wolf-text text-base font-extrabold tracking-widest">
                NO
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleConfirm}
              disabled={submitting}
              style={{ opacity: submitting ? 0.4 : 1 }}
              className="bg-wolf-accent rounded-xl py-4 px-10"
            >
              {submitting ? (
                <ActivityIndicator color="#0F0F14" />
              ) : (
                <Text className="text-wolf-bg text-base font-extrabold tracking-widest">
                  YES
                </Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      )}
    </View>
  );
}

// ───── Reviler picker ──────────────────────────────────────────────────────
//
// Solo antagonist. Optional every night. Die-on-miss when target isn't a
// "special villager" (any village-team role besides plain Villager). UI
// copy stays narrative — server enforces the actual hit rule.

function RevilerPicker({
  gameId,
  deviceClientId,
  alivePlayers,
  targetables,
  totalSeats,
  revilerState,
  meId,
}: {
  gameId: Id<'games'>;
  deviceClientId: string;
  alivePlayers: SeatingPlayer[];
  targetables: Targetable[];
  totalSeats: number;
  revilerState: {
    hasActedThisNight: boolean;
  };
  meId: Id<'players'>;
}) {
  const submitShot = useMutation(api.night.submitRevilerShot);
  const submitSkip = useMutation(api.night.submitRevilerSkip);
  const [submitting, setSubmitting] = useState(false);
  const [pendingTarget, setPendingTarget] = useState<{
    id: Id<'players'>;
    name: string;
  } | null>(null);

  function handlePickTarget(targetId: Id<'players'>, name: string) {
    if (submitting || pendingTarget) return;
    setPendingTarget({ id: targetId, name });
  }

  async function handleConfirm() {
    if (!pendingTarget || submitting) return;
    setSubmitting(true);
    try {
      await submitShot({
        gameId,
        callerDeviceClientId: deviceClientId,
        targetPlayerId: pendingTarget.id,
      });
      setPendingTarget(null);
    } catch (e) {
      Alert.alert('Could not shoot', e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  function handleCancel() {
    if (submitting) return;
    setPendingTarget(null);
  }

  async function handleSkip() {
    if (submitting) return;
    setSubmitting(true);
    try {
      await submitSkip({ gameId, callerDeviceClientId: deviceClientId });
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  if (revilerState.hasActedThisNight) {
    return (
      <View className="flex-1 px-6 pt-2 pb-8">
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color="#D4A017" />
          <Text className="text-wolf-muted text-sm text-center mt-6 px-4">
            Waiting for the night to settle…
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View className="flex-1">
      <ScrollView contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: 16 }}>
        <Text className="text-wolf-text text-base text-center mt-2 mb-2">
          Pick a special villager to revile them. If they aren't one, you die instead.
        </Text>
        <View style={{ alignItems: 'center' }}>
          <SeatingCircle
            totalSeats={totalSeats}
            players={alivePlayers}
            meId={meId}
            selectableIds={
              new Set(targetables.map(t => t._id as unknown as string))
            }
            onPress={
              submitting || pendingTarget
                ? undefined
                : p => handlePickTarget(p._id, p.name)
            }
          />
        </View>
      </ScrollView>

      <View className="px-6 pb-3">
        <TouchableOpacity
          onPress={handleSkip}
          disabled={submitting || !!pendingTarget}
          style={{ opacity: submitting || pendingTarget ? 0.4 : 1 }}
          className="bg-wolf-card rounded-xl py-4 items-center"
        >
          <Text className="text-wolf-muted text-base font-bold tracking-widest">
            PASS TONIGHT
          </Text>
        </TouchableOpacity>
      </View>

      {pendingTarget && (
        <View
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 0,
            bottom: 0,
            backgroundColor: 'rgba(0,0,0,0.92)',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 32,
          }}
        >
          <Text className="text-wolf-muted text-xs font-bold tracking-widest mb-3">
            REVILE
          </Text>
          <Text className="text-wolf-text text-3xl font-extrabold text-center mb-2">
            {pendingTarget.name.toUpperCase()}
          </Text>
          <Text className="text-wolf-muted text-sm text-center mb-10 px-4">
            If they aren't a special villager, you die. Are you sure?
          </Text>
          <View className="flex-row" style={{ gap: 14 }}>
            <TouchableOpacity
              onPress={handleCancel}
              disabled={submitting}
              className="bg-wolf-card rounded-xl py-4 px-10"
              style={{ borderWidth: 1, borderColor: '#3A3A48' }}
            >
              <Text className="text-wolf-text text-base font-extrabold tracking-widest">
                NO
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleConfirm}
              disabled={submitting}
              style={{ opacity: submitting ? 0.4 : 1 }}
              className="bg-wolf-accent rounded-xl py-4 px-10"
            >
              {submitting ? (
                <ActivityIndicator color="#0F0F14" />
              ) : (
                <Text className="text-wolf-bg text-base font-extrabold tracking-widest">
                  YES
                </Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      )}
    </View>
  );
}

function WaitingView({
  role,
  stepLabel,
  history,
}: {
  role?: string;
  stepLabel: string | null;
  history?: Array<{
    nightNumber: number;
    targetName: string;
    team: 'wolf' | 'villager';
  }> | null;
}) {
  return (
    <View className="flex-1 px-6 pt-2 pb-8">
      <View className="flex-1 items-center justify-center">
        <ActivityIndicator color="#D4A017" />
        <Text className="text-wolf-muted text-sm text-center mt-6 px-4">
          {stepLabel ?? 'The night is settling…'}
        </Text>
        {role && (
          <Text className="text-wolf-muted text-xs tracking-widest mt-2">
            YOU ARE THE {role.toUpperCase()}
          </Text>
        )}
      </View>

      {history && history.length > 0 && (
        <View className="bg-wolf-card rounded-xl px-4 py-3">
          <Text className="text-wolf-muted text-xs font-bold tracking-widest mb-2">
            YOUR CHECKS
          </Text>
          {history.map((h, i) => (
            <View key={i} className="flex-row justify-between py-1">
              <Text className="text-wolf-text text-sm">
                Night {h.nightNumber} — {h.targetName}
              </Text>
              <Text
                className="text-sm font-bold"
                style={{ color: h.team === 'wolf' ? '#B03A2E' : '#5BA0E5' }}
              >
                {h.team === 'wolf' ? 'WOLF' : 'VILLAGER'}
              </Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}
