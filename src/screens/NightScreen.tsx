import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  SafeAreaView,
  ScrollView,
  Animated,
  Easing,
  ActivityIndicator,
  Modal,
  Pressable,
  Image,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { StackNavigationProp } from '@react-navigation/stack';
import { useMutation, useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import type { RootStackParamList } from '../navigation/types';
import { useDeviceId } from '../hooks/useDeviceId';
import { SeatingCircle, type SeatingPlayer } from '../components/SeatingCircle';
import { showAlert } from '../components/ThemedAlert';
import { InGameLeaveButton } from '../components/InGameLeaveButton';
import { useGameLeaveHandler } from '../hooks/useGameLeaveHandler';
import { HostMissingBanner } from '../components/HostMissingBanner';

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
    } else if (phase === 'triggers') {
      navigation.replace('Triggers', { gameId: params.gameId });
    } else if (phase === 'ended') {
      navigation.replace('EndGame', { gameId: params.gameId });
    }
  }, [view?.game.phase, navigation, params.gameId]);

  const { confirmLeave } = useGameLeaveHandler({
    gameId: params.gameId as Id<'games'>,
    deviceClientId,
    isHost: view?.me.isHost,
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
    leprechaunState,
    bgState,
    huntressState,
    revealerState,
    revilerState,
    cursedConversionState,
    targetables,
    stepActorStatus,
  } = view;

  // Defensive: if phase has already moved on, the effect above will navigate.
  if (game.phase !== 'night') {
    return (
      <SafeAreaView className="flex-1 bg-wolf-bg items-center justify-center">
        <ActivityIndicator color="#D4A017" />
      </SafeAreaView>
    );
  }

  const isGhost = !me.alive;

  // The picker tree gates on `nightStep === 'X' && XState` rather than
  // `isMyStep`, because XState is server-populated only for the role's actor
  // (alive) or for dead spectators viewing that step. This lets ghosts mirror
  // exactly what the alive actor sees, with the wrapper below disabling taps.
  const pickerTree = (
    <>
      {game.nightStep === 'wolves' && wolfState && (
        wolfState.blocked ? (
          <WolvesBlockedView wolves={wolfState.wolves} isGhost={isGhost} />
        ) : (
          <WolvesPicker
            gameId={game._id}
            deviceClientId={deviceClientId}
            alivePlayers={view.alivePlayers}
            targetables={targetables}
            totalSeats={game.playerCount}
            meId={me._id}
            wolves={wolfState.wolves}
            requiredKills={wolfState.requiredKills}
            killsSoFar={wolfState.killsSoFar}
            isGhost={isGhost}
          />
        )
      )}

      {game.nightStep === 'seer' && seerHistory != null && (
        <SeerPicker
          gameId={game._id}
          deviceClientId={deviceClientId}
          alivePlayers={view.alivePlayers}
          targetables={targetables}
          totalSeats={game.playerCount}
          meId={me._id}
          history={seerHistory}
          nightNumber={game.nightNumber}
          isGhost={isGhost}
        />
      )}

      {game.nightStep === 'pi' && piState && (
        <PIPicker
          gameId={game._id}
          deviceClientId={deviceClientId}
          alivePlayers={view.alivePlayers}
          targetables={targetables}
          totalSeats={game.playerCount}
          meId={me._id}
          piState={piState}
          isGhost={isGhost}
        />
      )}

      {game.nightStep === 'mentalist' && mentalistState && (
        <MentalistPicker
          gameId={game._id}
          deviceClientId={deviceClientId}
          alivePlayers={view.alivePlayers}
          targetables={targetables}
          totalSeats={game.playerCount}
          meId={me._id}
          mentalistState={mentalistState}
          nightNumber={game.nightNumber}
          isGhost={isGhost}
        />
      )}

      {game.nightStep === 'witch' && witchState && (
        <WitchPicker
          gameId={game._id}
          deviceClientId={deviceClientId}
          alivePlayers={view.alivePlayers}
          targetables={targetables}
          totalSeats={game.playerCount}
          meId={me._id}
          witchState={witchState}
          isGhost={isGhost}
        />
      )}

      {game.nightStep === 'leprechaun' && leprechaunState && (
        <LeprechaunPicker
          gameId={game._id}
          deviceClientId={deviceClientId}
          leprechaunState={leprechaunState}
          isGhost={isGhost}
        />
      )}

      {game.nightStep === 'bodyguard' && bgState && (
        <BodyguardPicker
          gameId={game._id}
          deviceClientId={deviceClientId}
          alivePlayers={view.alivePlayers}
          targetables={targetables}
          totalSeats={game.playerCount}
          bgState={bgState}
          meId={me._id}
          isGhost={isGhost}
        />
      )}

      {game.nightStep === 'huntress' && huntressState && (
        <HuntressPicker
          gameId={game._id}
          deviceClientId={deviceClientId}
          alivePlayers={view.alivePlayers}
          targetables={targetables}
          totalSeats={game.playerCount}
          huntressState={huntressState}
          meId={me._id}
          isGhost={isGhost}
        />
      )}

      {game.nightStep === 'revealer' && revealerState && (
        <RevealerPicker
          gameId={game._id}
          deviceClientId={deviceClientId}
          alivePlayers={view.alivePlayers}
          targetables={targetables}
          totalSeats={game.playerCount}
          revealerState={revealerState}
          meId={me._id}
          isGhost={isGhost}
        />
      )}

      {game.nightStep === 'reviler' && revilerState && (
        <RevilerPicker
          gameId={game._id}
          deviceClientId={deviceClientId}
          alivePlayers={view.alivePlayers}
          targetables={targetables}
          totalSeats={game.playerCount}
          revilerState={revilerState}
          meId={me._id}
          isGhost={isGhost}
        />
      )}

      {game.nightStep === 'cursed_conversion' && cursedConversionState && (
        <CursedRevealView
          gameId={game._id}
          deviceClientId={deviceClientId}
          isMine={cursedConversionState.isMine}
          acknowledged={cursedConversionState.acknowledged}
          convertedNames={cursedConversionState.convertedNames}
        />
      )}
    </>
  );

  // True when one of the picker conditionals will actually render something
  // for a ghost spectator. Used to fall back to a "waiting on X" view during
  // brief windows when a step is active but no actor state is populated
  // (e.g. role's actor is dead and the engine is dwelling for cloak).
  const hasPickerForGhost = !!(
    (game.nightStep === 'wolves' && wolfState) ||
    (game.nightStep === 'seer' && seerHistory != null) ||
    (game.nightStep === 'pi' && piState) ||
    (game.nightStep === 'mentalist' && mentalistState) ||
    (game.nightStep === 'witch' && witchState) ||
    (game.nightStep === 'leprechaun' && leprechaunState) ||
    (game.nightStep === 'bodyguard' && bgState) ||
    (game.nightStep === 'huntress' && huntressState) ||
    (game.nightStep === 'revealer' && revealerState) ||
    (game.nightStep === 'reviler' && revilerState) ||
    (game.nightStep === 'cursed_conversion' && cursedConversionState)
  );

  return (
    <SafeAreaView className="flex-1 bg-wolf-bg">
      <InGameLeaveButton onPress={confirmLeave} />
      <NightHeader
        nightNumber={game.nightNumber}
        stepLabel={me.alive ? null : stepLabel}
        dead={!me.alive}
      />

      {view.hostMissing && (
        <HostMissingBanner
          gameId={game._id}
          deviceClientId={deviceClientId}
          alive={me.alive}
        />
      )}

      {me.alive ? (
        <>
          {pickerTree}
          {!isMyStep && !cursedConversionState && (
            <WaitingView role={me.role} />
          )}
        </>
      ) : (
        <View
          className="flex-1"
          pointerEvents="none"
          style={{ opacity: 0.85 }}
        >
          {!game.nightStep ? (
            <View className="flex-1 items-center justify-center px-8">
              <Text className="text-wolf-muted text-sm text-center">
                You are out of the game. The night unfolds without you.
              </Text>
            </View>
          ) : hasPickerForGhost ? (
            pickerTree
          ) : (
            <GhostStepFallback
              stepActorStatus={stepActorStatus}
              stepLabel={stepLabel}
            />
          )}
        </View>
      )}

      {me.alive &&
        me.isHost &&
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
                showAlert(
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
                showAlert(
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
  const insets = useSafeAreaInsets();
  return (
    <View
      style={{
        position: 'absolute',
        left: 16,
        right: 16,
        bottom: Math.max(insets.bottom, 12) + 12,
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

// ───── Ghost fallback view ─────────────────────────────────────────────────
//
// Shown to a dead spectator when the current step has no picker to render for
// them — either because the role's actor is dead (no XState populated for any
// alive actor on this step) or because the actor is alive but used their
// one-time power (PI / Huntress get filtered out of activePlayersForStep
// once their used-flag flips). Replaces the misleading "X IS AWAKE" spinner
// with the actual reason the step is quiet.

function GhostStepFallback({
  stepActorStatus,
  stepLabel,
}: {
  stepActorStatus:
    | {
        roleName: string;
        status: 'present' | 'eliminated' | 'powerUsed';
        actorName: string | null;
      }
    | null;
  stepLabel: string | null;
}) {
  if (stepActorStatus?.status === 'eliminated') {
    return (
      <View className="flex-1 items-center justify-center px-8">
        {stepActorStatus.actorName ? (
          <Text className="text-wolf-text text-xl font-extrabold tracking-wide text-center">
            {stepActorStatus.actorName.toUpperCase()}
          </Text>
        ) : null}
        <Text className="text-wolf-muted text-sm text-center mt-2">
          The {stepActorStatus.roleName} has been eliminated.
        </Text>
      </View>
    );
  }
  if (stepActorStatus?.status === 'powerUsed') {
    return (
      <View className="flex-1 items-center justify-center px-8">
        {stepActorStatus.actorName ? (
          <Text className="text-wolf-text text-xl font-extrabold tracking-wide text-center">
            {stepActorStatus.actorName.toUpperCase()}
          </Text>
        ) : null}
        <Text className="text-wolf-muted text-sm text-center mt-2">
          The {stepActorStatus.roleName}'s power has already been used.
        </Text>
      </View>
    );
  }
  return (
    <View className="flex-1 items-center justify-center px-8">
      <ActivityIndicator color="#D4A017" />
      <Text className="text-wolf-muted text-sm text-center mt-6">
        {stepLabel ? `${stepLabel}…` : 'The night unfolds…'}
      </Text>
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
      <Text className="text-wolf-muted text-lg font-bold tracking-widest">
        NIGHT {nightNumber}
      </Text>
      {dead && (
        <Text className="text-wolf-red text-xs font-bold tracking-widest mt-0.5">
          SPECTATING
        </Text>
      )}
      {stepLabel ? (
        <Text className="text-wolf-text text-base font-bold tracking-widest mt-1 text-center">
          {stepLabel.toUpperCase()}
        </Text>
      ) : null}
    </View>
  );
}

// ───── Cursed conversion reveal ────────────────────────────────────────────
//
// Shown to the converted Cursed (and dead spectators) during the
// cursed_conversion night step. The body sentence has YOU / ARE / A / WOLF
// rendered in red so the four red words read top-to-bottom as the subliminal
// "you are a wolf". The OK button is required for the alive converted
// Cursed — the step holds until they tap it (alongside the dwell) so they
// can't miss the reveal by looking away. Dead spectators see the reveal
// passively, no button.

function CursedRevealView({
  gameId,
  deviceClientId,
  isMine,
  acknowledged,
  convertedNames,
}: {
  gameId: Id<'games'>;
  deviceClientId: string;
  isMine: boolean;
  acknowledged: boolean;
  convertedNames: string[];
}) {
  const submitAck = useMutation(api.night.submitCursedAck);
  const [submitting, setSubmitting] = useState(false);

  async function handleAck() {
    if (submitting) return;
    setSubmitting(true);
    try {
      await submitAck({ gameId, callerDeviceClientId: deviceClientId });
    } catch (e) {
      showAlert('Error', e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  if (isMine && acknowledged) {
    return (
      <View className="flex-1 px-6 pt-2 pb-8">
        <View className="flex-1 items-center justify-center">
          <Text className="text-wolf-muted text-xs font-bold tracking-widest text-center mb-6">
            A CURSE TAKES HOLD
          </Text>
          <ActivityIndicator color="#D4A017" />
          <Text className="text-wolf-muted text-sm text-center mt-6 px-4">
            Your fate is sealed. Waiting for morning…
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View className="flex-1 px-6 pt-2 pb-8">
      <View className="flex-1 items-center justify-center">
        <Text className="text-wolf-muted text-xs font-bold tracking-widest text-center mb-6">
          A CURSE TAKES HOLD
        </Text>
        <View
          className="bg-wolf-card rounded-2xl px-6 py-6"
          style={{ maxWidth: 360 }}
        >
          <Text className="text-wolf-text text-base leading-6 text-center">
            <Text className="text-wolf-red font-extrabold">YOU</Text>
            {' were targeted tonight, but '}
            <Text className="text-wolf-red font-extrabold">ARE</Text>
            {' still alive. '}
            <Text className="text-wolf-red font-extrabold">A</Text>
            {' curse converts you into a '}
            <Text className="text-wolf-red font-extrabold">WOLF</Text>
            {' now.'}
          </Text>
        </View>
        {!isMine && convertedNames.length > 0 && (
          <Text className="text-wolf-muted text-xs tracking-widest mt-6 text-center px-4">
            {convertedNames.join(', ').toUpperCase()} HAS BEEN CURSED
          </Text>
        )}
      </View>

      {isMine && (
        <TouchableOpacity
          onPress={handleAck}
          disabled={submitting}
          activeOpacity={0.75}
          className="bg-wolf-accent rounded-xl py-4 items-center"
          style={{ opacity: submitting ? 0.4 : 1 }}
        >
          {submitting ? (
            <ActivityIndicator color="#0F0F14" />
          ) : (
            <Text className="text-wolf-bg text-base font-extrabold tracking-widest">
              OK
            </Text>
          )}
        </TouchableOpacity>
      )}
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
  isGhost,
}: {
  wolves: Array<{
    _id: Id<'players'>;
    name: string;
    role: string;
    isMe: boolean;
  }>;
  isGhost?: boolean;
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
          {isGhost ? 'THE PACK' : 'YOUR PACK'}
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
  requiredKills,
  killsSoFar,
  isGhost,
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
  requiredKills: number;
  killsSoFar: Array<{ targetId: Id<'players'>; targetName: string }>;
  isGhost?: boolean;
}) {
  const submitVote = useMutation(api.night.submitWolfVote);
  const [submitting, setSubmitting] = useState(false);

  const myVote = wolves.find(w => w.isMe)?.currentVote;
  const consensus =
    wolves.length > 0 &&
    wolves.every(w => w.currentVote && w.currentVote === wolves[0].currentVote);
  const vengeance = requiredKills > 1;
  const allKillsLocked = killsSoFar.length >= requiredKills;
  const killNumber = killsSoFar.length + 1;
  // Hide already-locked-in victims from the picker for kill #2.
  const lockedIds = new Set<string>(
    killsSoFar.map(k => k.targetId as unknown as string),
  );
  const selectableForThisKill = new Set(
    targetables
      .map(t => t._id as unknown as string)
      .filter(id => !lockedIds.has(id)),
  );

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
      showAlert('Could not vote', e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <View className="flex-1">
      <ScrollView contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: 24 }}>
        {vengeance && (
          <View className="bg-wolf-card rounded-xl px-4 py-3 mb-3 border border-wolf-red">
            <Text className="text-wolf-red text-xs font-bold tracking-widest text-center">
              WOLF CUB VENGEANCE
            </Text>
            <Text className="text-wolf-text text-sm text-center mt-1">
              {allKillsLocked
                ? `${requiredKills} KILLS LOCKED`
                : `KILL ${killNumber} OF ${requiredKills}`}
            </Text>
            {killsSoFar.length > 0 && (
              <Text className="text-wolf-muted text-xs text-center mt-2">
                {allKillsLocked ? 'Victims: ' : 'Already taken: '}
                <Text className="text-wolf-accent">
                  {killsSoFar.map(k => k.targetName).join(', ')}
                </Text>
              </Text>
            )}
          </View>
        )}

        <Text className="text-wolf-text text-base text-center mt-2 mb-4">
          {allKillsLocked
            ? 'Sealing the night…'
            : consensus
              ? 'Consensus reached. Sealing the kill…'
              : isGhost
                ? 'The wolves are voting. They must agree.'
                : 'Tap a player to vote. All wolves must agree.'}
        </Text>

        {/* Wolf-pack awareness panel */}
        <View className="bg-wolf-card rounded-xl px-4 py-3 mb-5">
          <Text className="text-wolf-muted text-xs font-bold tracking-widest mb-2">
            {isGhost ? 'THE PACK' : 'YOUR PACK'}
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

        {/* Seating circle — selectable seats are any alive players (wolves
            may target each other, including themselves; this keeps the
            Leprechaun from confirming every kill target as a villager). */}
        <View style={{ alignItems: 'center' }}>
          <SeatingCircle
            totalSeats={totalSeats}
            players={alivePlayers}
            meId={meId}
            selectedId={myVote}
            selectableIds={selectableForThisKill}
            onPress={
              !submitting && !consensus && !allKillsLocked
                ? p => handleVote(p._id)
                : undefined
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
  isGhost,
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
  isGhost?: boolean;
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
      showAlert('Could not check', e instanceof Error ? e.message : String(e));
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
      showAlert('Error', e instanceof Error ? e.message : String(e));
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
            {isGhost ? "The Seer's check is in. Waiting for the night to settle…" : 'Your check is in. Waiting for the night to settle…'}
          </Text>
        </View>
        {history.length > 0 && (
          <View className="bg-wolf-card rounded-xl px-4 py-3">
            <Text className="text-wolf-muted text-xs font-bold tracking-widest mb-2">
              {isGhost ? "THE SEER'S CHECKS" : 'YOUR CHECKS'}
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
          {isGhost
            ? 'The Seer is investigating…'
            : 'Choose a player to investigate.'}
        </Text>

        {history.length > 0 && (
          <View className="bg-wolf-card rounded-xl px-4 py-3 mb-5">
            <Text className="text-wolf-muted text-xs font-bold tracking-widest mb-2">
              {isGhost ? "THE SEER'S CHECKS" : 'YOUR CHECKS'}
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
  isGhost,
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
  isGhost?: boolean;
}) {
  const insets = useSafeAreaInsets();
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
      showAlert('Could not investigate', e instanceof Error ? e.message : String(e));
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
      showAlert('Error', e instanceof Error ? e.message : String(e));
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
      showAlert('Error', e instanceof Error ? e.message : String(e));
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
              ? isGhost
                ? "The PI's check is in. Waiting for the night to settle…"
                : 'Your check is in. Waiting for the night to settle…'
              : 'Saved for later. Waiting for the night to settle…'}
          </Text>
        </View>
        {piState.history.length > 0 && (
          <View className="bg-wolf-card rounded-xl px-4 py-3">
            <Text className="text-wolf-muted text-xs font-bold tracking-widest mb-2">
              {isGhost ? "THE PI'S CHECK" : 'YOUR CHECK'}
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
          {isGhost
            ? 'The PI is reading a player + their two neighbors as a group.'
            : 'One-time investigation. Pick a target to read them and their two neighbors as a group.'}
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

      {!isGhost && (
        <View
          className="px-6"
          style={{ paddingBottom: Math.max(insets.bottom, 12) + 12 }}
        >
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
      )}

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
  isGhost,
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
  isGhost?: boolean;
}) {
  const insets = useSafeAreaInsets();
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
      showAlert('Could not compare', e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleAck() {
    try {
      await tickNight({ gameId, callerDeviceClientId: deviceClientId });
    } catch (e) {
      showAlert('Error', e instanceof Error ? e.message : String(e));
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
              ? isGhost
                ? `Last night the Mentalist read ${lockedNames.join(' & ')}, and they can't be picked back-to-back.`
                : `Last night you read ${lockedNames.join(' & ')}, and they can't be picked back-to-back.`
              : isGhost
                ? 'The Mentalist needs at least two valid targets to read.'
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
            {isGhost
              ? "The Mentalist's comparison is in. Waiting for the night to settle…"
              : 'Your comparison is in. Waiting for the night to settle…'}
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
          {isGhost
            ? 'The Mentalist is comparing two players to see if they share a team.'
            : "Pick two players. You'll be told whether they share a team."}
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
              {isGhost ? "THE MENTALIST'S READINGS" : 'YOUR READINGS'}
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

        {!isGhost && (
          <View className="bg-wolf-card rounded-xl px-4 py-3 mt-4">
            <Text className="text-wolf-muted text-xs font-bold tracking-widest mb-2">
              {`YOUR PICKS (${picks.length} / 2)`}
            </Text>
            <Text className="text-wolf-text text-sm">
              {picks.length === 0
                ? 'Tap a player to select them.'
                : picks.map(p => p.name).join(' & ')}
            </Text>
          </View>
        )}
      </ScrollView>

      {!isGhost && (
        <View
          className="px-6"
          style={{ paddingBottom: Math.max(insets.bottom, 12) + 12 }}
        >
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
      )}

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
  isGhost,
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
    tonightVictims: Array<{ _id: Id<'players'>; name: string }>;
    tonightSaveTarget: { _id: Id<'players'>; name: string } | null;
    tonightPoisonTarget: { _id: Id<'players'>; name: string } | null;
  };
  isGhost?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const submitSave = useMutation(api.night.submitWitchSave);
  const submitPoison = useMutation(api.night.submitWitchPoison);
  const submitDone = useMutation(api.night.submitWitchDone);

  const [submitting, setSubmitting] = useState(false);
  // When there are 2 victims, confirmSave holds the chosen one (witch must
  // pick which to save — no two-for-one). Null = closed; object = open with
  // that victim queued.
  const [confirmSave, setConfirmSave] = useState<{
    id: Id<'players'>;
    name: string;
  } | null>(null);
  const [savePickerOpen, setSavePickerOpen] = useState(false);
  const [poisonPickerOpen, setPoisonPickerOpen] = useState(false);
  const [confirmPoison, setConfirmPoison] = useState<{
    id: Id<'players'>;
    name: string;
  } | null>(null);

  async function handleSave() {
    if (!confirmSave) return;
    setSubmitting(true);
    try {
      await submitSave({
        gameId,
        callerDeviceClientId: deviceClientId,
        targetPlayerId: confirmSave.id,
      });
      setConfirmSave(null);
    } catch (e) {
      showAlert('Could not save', e instanceof Error ? e.message : String(e));
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
      showAlert('Could not poison', e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDone() {
    setSubmitting(true);
    try {
      await submitDone({ gameId, callerDeviceClientId: deviceClientId });
    } catch (e) {
      showAlert('Error', e instanceof Error ? e.message : String(e));
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
            {isGhost
              ? "The Witch's turn is over. Waiting for the night to settle…"
              : 'Your turn is over. Waiting for the night to settle…'}
          </Text>
          {witchState.tonightSaveTarget && (
            <Text className="text-wolf-text text-sm text-center mt-4 px-4">
              <Text className="font-bold" style={{ color: '#5BA0E5' }}>
                SAVED:
              </Text>{' '}
              {witchState.tonightSaveTarget.name}
            </Text>
          )}
          {witchState.tonightPoisonTarget && (
            <Text className="text-wolf-text text-sm text-center mt-4 px-4">
              <Text className="text-wolf-red font-bold">POISONED:</Text>{' '}
              {witchState.tonightPoisonTarget.name}
            </Text>
          )}
        </View>
      </View>
    );
  }

  const victims = witchState.tonightVictims;
  const canSave =
    !witchState.saveUsed && !witchState.savedTonight && victims.length > 0;
  const canPoison = !witchState.poisonUsed && !witchState.poisonedTonight;
  // Single-victim path: tap "USE SAVE POTION" goes straight to the
  // confirmation modal with that victim queued. Multi-victim (vengeance):
  // tap opens a picker so the witch chooses one (no two-for-one).
  function openSaveFlow() {
    if (victims.length === 1) {
      setConfirmSave({ id: victims[0]._id, name: victims[0].name });
    } else if (victims.length > 1) {
      setSavePickerOpen(true);
    }
  }

  return (
    <View className="flex-1">
      <ScrollView contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: 16 }}>
        <View className="bg-wolf-card rounded-xl px-4 py-3 mt-2 mb-4">
          <Text className="text-wolf-muted text-xs font-bold tracking-widest mb-1">
            {victims.length > 1 ? "TONIGHT'S VICTIMS" : "TONIGHT'S VICTIM"}
          </Text>
          {witchState.saveUsed ? (
            <Text className="text-wolf-muted text-sm italic">
              {isGhost
                ? "The wolves' victim is hidden — the Witch's save potion is spent."
                : "You can no longer see the wolves' victim — your save potion is spent."}
            </Text>
          ) : victims.length > 0 ? (
            <View style={{ gap: 4 }}>
              {victims.map(v => (
                <Text
                  key={v._id}
                  className="text-wolf-text text-2xl font-bold tracking-widest"
                >
                  {v.name.toUpperCase()}
                </Text>
              ))}
              {victims.length > 1 && (
                <Text className="text-wolf-muted text-xs mt-1">
                  Your save potion can only spare one.
                </Text>
              )}
            </View>
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
            onPress={openSaveFlow}
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
            {witchState.tonightPoisonTarget && (
              <Text className="text-wolf-text text-sm mt-1">
                → {witchState.tonightPoisonTarget.name}
              </Text>
            )}
          </TouchableOpacity>
        </View>
      </ScrollView>

      {!isGhost && (
        <View
          className="px-6"
          style={{ paddingBottom: Math.max(insets.bottom, 12) + 12 }}
        >
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
      )}

      {/* Save victim picker (vengeance night — choose which to save) */}
      <Modal
        visible={savePickerOpen && !confirmSave}
        transparent
        animationType="fade"
        onRequestClose={() => setSavePickerOpen(false)}
      >
        <Pressable
          onPress={() => setSavePickerOpen(false)}
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
            <Text className="text-wolf-text text-lg font-bold mb-1 text-center">
              Save which victim?
            </Text>
            <Text className="text-wolf-muted text-xs text-center mb-4">
              Your potion can only spare one.
            </Text>
            <View style={{ gap: 10 }}>
              {victims.map(v => (
                <TouchableOpacity
                  key={v._id}
                  onPress={() => {
                    setConfirmSave({ id: v._id, name: v.name });
                    setSavePickerOpen(false);
                  }}
                  className="bg-wolf-card rounded-xl py-4 items-center"
                  style={{ borderWidth: 1, borderColor: '#5BA0E5' }}
                >
                  <Text className="text-wolf-text text-lg font-bold tracking-widest">
                    {v.name.toUpperCase()}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
            <TouchableOpacity onPress={() => setSavePickerOpen(false)} className="mt-3 py-2">
              <Text className="text-wolf-muted text-center">Cancel</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

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
            {confirmSave.name.toUpperCase()}
          </Text>
          <Text className="text-wolf-muted text-sm text-center mb-10">
            This is your only save potion.
          </Text>
          <View className="flex-row" style={{ gap: 14 }}>
            <TouchableOpacity
              onPress={() => setConfirmSave(null)}
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

// ───── Leprechaun picker ───────────────────────────────────────────────────

function LeprechaunPicker({
  gameId,
  deviceClientId,
  leprechaunState,
  isGhost,
}: {
  gameId: Id<'games'>;
  deviceClientId: string;
  leprechaunState: {
    blocked: boolean;
    hasActedThisNight: boolean;
    wolfTarget: { _id: Id<'players'>; name: string } | null;
    leftNeighbor: { _id: Id<'players'>; name: string } | null;
    rightNeighbor: { _id: Id<'players'>; name: string } | null;
    canMoveOff: boolean;
    tonightRedirect: {
      direction: 'L' | 'R' | 'leave';
      originalTargetName: string | null;
      newTargetName: string | null;
      blocked: boolean;
    } | null;
  };
  isGhost?: boolean;
}) {
  const submitMove = useMutation(api.night.submitLeprechaunMove);
  const [submitting, setSubmitting] = useState(false);
  const [confirmDir, setConfirmDir] = useState<'L' | 'R' | null>(null);

  async function submit(direction: 'L' | 'R' | 'leave') {
    setSubmitting(true);
    try {
      await submitMove({
        gameId,
        callerDeviceClientId: deviceClientId,
        direction,
      });
      setConfirmDir(null);
    } catch (e) {
      showAlert('Could not move', e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  // Post-action: locked waiting view.
  if (leprechaunState.hasActedThisNight) {
    const r = leprechaunState.tonightRedirect;
    return (
      <View className="flex-1 px-6 pt-2 pb-8">
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color="#D4A017" />
          {r?.blocked ? (
            <Text className="text-wolf-muted text-sm text-center mt-6 px-4">
              {isGhost
                ? 'The Leprechaun has acknowledged the silent night. Waiting…'
                : 'Acknowledged. Waiting for the night to settle…'}
            </Text>
          ) : r?.direction === 'leave' ? (
            <Text className="text-wolf-muted text-sm text-center mt-6 px-4">
              {isGhost
                ? `The Leprechaun left the kill on ${r?.originalTargetName ?? '—'}. Waiting…`
                : `Left the kill on ${r?.originalTargetName ?? '—'}. Waiting…`}
            </Text>
          ) : (
            <View className="mt-6 items-center px-4">
              <Text className="text-wolf-muted text-xs tracking-widest font-bold mb-2">
                KILL MOVED
              </Text>
              <Text className="text-wolf-text text-base text-center">
                <Text className="font-bold">
                  {r?.originalTargetName ?? '—'}
                </Text>
                {' → '}
                <Text className="font-bold">
                  {r?.newTargetName ?? '—'}
                </Text>
              </Text>
              <Text className="text-wolf-muted text-xs text-center mt-3 italic">
                {isGhost
                  ? 'Waiting for the night to settle…'
                  : 'Your move has been made. Waiting for the night to settle…'}
              </Text>
            </View>
          )}
        </View>
      </View>
    );
  }

  // Diseased-blocked night: ACKNOWLEDGE only.
  if (leprechaunState.blocked) {
    return (
      <View className="flex-1 px-6 pt-2 pb-8">
        <View className="flex-1 items-center justify-center">
          <View className="bg-wolf-card rounded-xl px-6 py-6 mb-8 w-full">
            <Text className="text-wolf-muted text-xs font-bold tracking-widest mb-3 text-center">
              TONIGHT'S VICTIM
            </Text>
            <Text className="text-wolf-text text-2xl font-bold tracking-widest text-center">
              NO KILL
            </Text>
            <Text className="text-wolf-muted text-sm text-center mt-3 italic">
              The wolves had no kill tonight.
            </Text>
          </View>
          {!isGhost && (
            <TouchableOpacity
              onPress={() => submit('leave')}
              disabled={submitting}
              activeOpacity={0.8}
              className="bg-wolf-accent rounded-xl px-8 py-4"
              style={{ opacity: submitting ? 0.5 : 1 }}
            >
              {submitting ? (
                <ActivityIndicator color="#0F0F14" />
              ) : (
                <Text className="text-wolf-bg text-base font-extrabold tracking-widest">
                  ACKNOWLEDGE
                </Text>
              )}
            </TouchableOpacity>
          )}
        </View>
      </View>
    );
  }

  // Normal pre-action picker.
  const target = leprechaunState.wolfTarget;
  const left = leprechaunState.leftNeighbor;
  const right = leprechaunState.rightNeighbor;
  const canMove = leprechaunState.canMoveOff;

  return (
    <View className="flex-1">
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: 16 }}
      >
        <View className="bg-wolf-card rounded-xl px-4 py-3 mt-2 mb-4">
          <Text className="text-wolf-muted text-xs font-bold tracking-widest mb-1">
            TONIGHT'S VICTIM
          </Text>
          {target ? (
            <Text className="text-wolf-text text-2xl font-bold tracking-widest">
              {target.name.toUpperCase()}
            </Text>
          ) : (
            <Text className="text-wolf-muted text-sm italic">
              No victim tonight.
            </Text>
          )}
          {!canMove && (
            <Text className="text-wolf-muted text-xs mt-2 italic">
              You've already moved a kill off this player. Only LEAVE is
              available.
            </Text>
          )}
        </View>

        <Text className="text-wolf-muted text-xs font-bold tracking-widest mb-2">
          MOVE THE KILL
        </Text>
        <View style={{ gap: 10 }}>
          <TouchableOpacity
            onPress={() => left && canMove && setConfirmDir('L')}
            disabled={!left || !canMove || submitting}
            activeOpacity={0.75}
            className="bg-wolf-card rounded-xl px-4 py-4"
            style={{
              borderWidth: 1,
              borderColor: left && canMove ? '#5BA0E5' : '#2A2A38',
              opacity: left && canMove ? 1 : 0.4,
            }}
          >
            <Text className="text-wolf-muted text-xs font-bold tracking-widest">
              MOVE LEFT
            </Text>
            <Text
              className="text-base font-bold tracking-widest mt-1"
              style={{ color: left && canMove ? '#5BA0E5' : '#5A5560' }}
            >
              → {left ? left.name.toUpperCase() : '—'}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={() => submit('leave')}
            disabled={submitting}
            activeOpacity={0.75}
            className="bg-wolf-card rounded-xl px-4 py-4"
            style={{
              borderWidth: 1,
              borderColor: '#D4A017',
              opacity: submitting ? 0.4 : 1,
            }}
          >
            <Text className="text-wolf-muted text-xs font-bold tracking-widest">
              LEAVE THE KILL
            </Text>
            <Text
              className="text-base font-bold tracking-widest mt-1"
              style={{ color: '#D4A017' }}
            >
              ON {target ? target.name.toUpperCase() : '—'}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={() => right && canMove && setConfirmDir('R')}
            disabled={!right || !canMove || submitting}
            activeOpacity={0.75}
            className="bg-wolf-card rounded-xl px-4 py-4"
            style={{
              borderWidth: 1,
              borderColor: right && canMove ? '#5BA0E5' : '#2A2A38',
              opacity: right && canMove ? 1 : 0.4,
            }}
          >
            <Text className="text-wolf-muted text-xs font-bold tracking-widest">
              MOVE RIGHT
            </Text>
            <Text
              className="text-base font-bold tracking-widest mt-1"
              style={{ color: right && canMove ? '#5BA0E5' : '#5A5560' }}
            >
              → {right ? right.name.toUpperCase() : '—'}
            </Text>
          </TouchableOpacity>
        </View>
      </ScrollView>

      {/* Move confirmation overlay — mirrors the other night-role confirms. */}
      {confirmDir && (
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
            MOVE KILL
          </Text>
          <Text className="text-wolf-text text-3xl font-extrabold text-center mb-2">
            {(confirmDir === 'L' ? left?.name : right?.name)?.toUpperCase() ?? '—'}
          </Text>
          <Text className="text-wolf-muted text-sm text-center mb-10">
            You won't be able to move a kill off {target?.name ?? '—'} again later.
          </Text>
          <View className="flex-row" style={{ gap: 14 }}>
            <TouchableOpacity
              onPress={() => setConfirmDir(null)}
              disabled={submitting}
              className="bg-wolf-card rounded-xl py-4 px-10"
              style={{ borderWidth: 1, borderColor: '#3A3A48' }}
            >
              <Text className="text-wolf-text text-base font-extrabold tracking-widest">
                NO
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => submit(confirmDir)}
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

// ───── Bodyguard picker ────────────────────────────────────────────────────

function BodyguardPicker({
  gameId,
  deviceClientId,
  alivePlayers,
  targetables,
  totalSeats,
  bgState,
  meId,
  isGhost,
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
    tonightProtected: { _id: Id<'players'>; name: string } | null;
  };
  meId: Id<'players'>;
  isGhost?: boolean;
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
      showAlert(
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
            {isGhost
              ? "The Bodyguard's protection is in. Waiting for the night to settle…"
              : 'Your protection is in. Waiting for the night to settle…'}
          </Text>
          {bgState.tonightProtected && (
            <Text className="text-wolf-text text-sm text-center mt-4 px-4">
              <Text style={{ color: '#5BA0E5' }} className="font-bold">
                PROTECTED:
              </Text>{' '}
              {bgState.tonightProtected.name}
            </Text>
          )}
        </View>
      </View>
    );
  }

  return (
    <View className="flex-1">
      <ScrollView contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: 24 }}>
        <Text className="text-wolf-text text-base text-center mt-2 mb-2">
          {isGhost
            ? 'The Bodyguard is choosing who to protect tonight.'
            : 'Choose a player to protect tonight.'}
        </Text>
        <View className="bg-wolf-card rounded-xl px-4 py-3 mb-4">
          <Text className="text-wolf-muted text-xs leading-5">
            {bgState.lastProtectedName
              ? isGhost
                ? `Last night: ${bgState.lastProtectedName}. Cannot pick the same player two nights in a row.\n`
                : `Last night: ${bgState.lastProtectedName}. You cannot pick the same player two nights in a row.\n`
              : ''}
            {bgState.selfProtectUsed
              ? isGhost
                ? "The Bodyguard's one self-protect has already been used."
                : 'Your one self-protect has already been used.'
              : isGhost
                ? 'The Bodyguard may protect themselves once per game.'
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
  isGhost,
}: {
  gameId: Id<'games'>;
  deviceClientId: string;
  alivePlayers: SeatingPlayer[];
  targetables: Targetable[];
  totalSeats: number;
  huntressState: {
    huntressUsed: boolean;
    hasActedThisNight: boolean;
    tonightShot: { _id: Id<'players'>; name: string } | null;
    tonightSkipped: boolean;
  };
  meId: Id<'players'>;
  isGhost?: boolean;
}) {
  const insets = useSafeAreaInsets();
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
      showAlert('Could not shoot', e instanceof Error ? e.message : String(e));
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
      showAlert('Error', e instanceof Error ? e.message : String(e));
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
          {huntressState.tonightShot ? (
            <Text className="text-wolf-text text-sm text-center mt-4 px-4">
              <Text style={{ color: '#E07070' }} className="font-bold">
                SHOT:
              </Text>{' '}
              {huntressState.tonightShot.name}
            </Text>
          ) : huntressState.tonightSkipped ? (
            <Text className="text-wolf-muted text-sm text-center mt-4 px-4 italic">
              Saved the shot for later.
            </Text>
          ) : null}
        </View>
      </View>
    );
  }

  return (
    <View className="flex-1">
      <ScrollView contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: 16 }}>
        <Text className="text-wolf-text text-base text-center mt-2 mb-2">
          {isGhost
            ? 'The Huntress is deciding whether to take her one shot.'
            : 'One-time shot. Pick a target to shoot, or save it for later.'}
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

      {!isGhost && (
        <View
          className="px-6"
          style={{ paddingBottom: Math.max(insets.bottom, 12) + 12 }}
        >
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
      )}

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
  isGhost,
}: {
  gameId: Id<'games'>;
  deviceClientId: string;
  alivePlayers: SeatingPlayer[];
  targetables: Targetable[];
  totalSeats: number;
  revealerState: {
    hasActedThisNight: boolean;
    tonightShot: { _id: Id<'players'>; name: string } | null;
    tonightSkipped: boolean;
  };
  meId: Id<'players'>;
  isGhost?: boolean;
}) {
  const insets = useSafeAreaInsets();
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
      showAlert('Could not shoot', e instanceof Error ? e.message : String(e));
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
      showAlert('Error', e instanceof Error ? e.message : String(e));
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
          {revealerState.tonightShot ? (
            <Text className="text-wolf-text text-sm text-center mt-4 px-4">
              <Text style={{ color: '#D4A017' }} className="font-bold">
                REVEALED:
              </Text>{' '}
              {revealerState.tonightShot.name}
            </Text>
          ) : revealerState.tonightSkipped ? (
            <Text className="text-wolf-muted text-sm text-center mt-4 px-4 italic">
              Passed tonight.
            </Text>
          ) : null}
        </View>
      </View>
    );
  }

  return (
    <View className="flex-1">
      <ScrollView contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: 16 }}>
        <Text className="text-wolf-text text-base text-center mt-2 mb-2">
          {isGhost
            ? "The Revealer is choosing whether to reveal a wolf. They die if they miss."
            : "Pick a wolf to reveal them. If they aren't a wolf, you die instead."}
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

      {!isGhost && (
        <View
          className="px-6"
          style={{ paddingBottom: Math.max(insets.bottom, 12) + 12 }}
        >
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
      )}

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
  isGhost,
}: {
  gameId: Id<'games'>;
  deviceClientId: string;
  alivePlayers: SeatingPlayer[];
  targetables: Targetable[];
  totalSeats: number;
  revilerState: {
    hasActedThisNight: boolean;
    tonightShot: { _id: Id<'players'>; name: string } | null;
    tonightSkipped: boolean;
  };
  meId: Id<'players'>;
  isGhost?: boolean;
}) {
  const insets = useSafeAreaInsets();
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
      showAlert('Could not shoot', e instanceof Error ? e.message : String(e));
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
      showAlert('Error', e instanceof Error ? e.message : String(e));
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
          {revilerState.tonightShot ? (
            <Text className="text-wolf-text text-sm text-center mt-4 px-4">
              <Text style={{ color: '#B03A2E' }} className="font-bold">
                REVILED:
              </Text>{' '}
              {revilerState.tonightShot.name}
            </Text>
          ) : revilerState.tonightSkipped ? (
            <Text className="text-wolf-muted text-sm text-center mt-4 px-4 italic">
              Passed tonight.
            </Text>
          ) : null}
        </View>
      </View>
    );
  }

  return (
    <View className="flex-1">
      <ScrollView contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: 16 }}>
        <Text className="text-wolf-text text-base text-center mt-2 mb-2">
          {isGhost
            ? "The Reviler is choosing whether to revile a special villager. They die if they miss."
            : "Pick a special villager to revile them. If they aren't one, you die instead."}
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

      {!isGhost && (
        <View
          className="px-6"
          style={{ paddingBottom: Math.max(insets.bottom, 12) + 12 }}
        >
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
      )}

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

const NIGHT_WHISPERS = [
  'WHO WILL COME FOR YOU IN THE NIGHT?',
  'THE VILLAGE SLEEPS. SOMETHING DOES NOT.',
  'TRUST NO ONE.',
  'LISTEN… CAN YOU HEAR THE FOOTSTEPS?',
  'BY MORNING, ONE LESS HEART WILL BEAT.',
  'THE MOON KEEPS ITS SECRETS.',
  'WHO WHISPERS YOUR NAME?',
  'NOT EVERY FRIEND IS A FRIEND.',
  'EYES CLOSED. EARS OPEN.',
  'YOUR FATE IS DECIDED IN THE DARK.',
  'SOMETHING HOWLS BEYOND THE TREELINE.',
  'THE WOLVES ARE DREAMING OF YOU.',
  "DON'T PEEK. IT WILL BE WORSE IF YOU DO.",
  'EVERY SHADOW HIDES A SECRET.',
];

function WaitingView({ role }: { role?: string }) {
  const [lineIndex, setLineIndex] = useState(() =>
    Math.floor(Math.random() * NIGHT_WHISPERS.length),
  );
  const fade = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const tick = () => {
      Animated.timing(fade, {
        toValue: 0,
        duration: 900,
        useNativeDriver: true,
      }).start(() => {
        setLineIndex((i) => (i + 1) % NIGHT_WHISPERS.length);
        Animated.timing(fade, {
          toValue: 1,
          duration: 900,
          useNativeDriver: true,
        }).start();
      });
    };
    const id = setInterval(tick, 6000);
    return () => clearInterval(id);
  }, [fade]);

  return (
    <View className="flex-1 pb-8">
      <View className="flex-1 items-center justify-center">
        <Animated.Text
          style={{ opacity: fade }}
          className="text-wolf-muted text-sm tracking-widest text-center mb-6 px-6"
        >
          {NIGHT_WHISPERS[lineIndex]}
        </Animated.Text>
        <View style={{ width: '100%', height: 200 }}>
          <Image
            source={require('../../assets/images/allan-de-paepe-ezgif-com-gif-maker-2.gif')}
            style={{ width: '100%', height: '100%' }}
            resizeMode="contain"
          />
        </View>
        {role && (
          <Text className="text-wolf-muted text-xs tracking-widest mt-6 px-6">
            YOU ARE THE {role.toUpperCase()}
          </Text>
        )}
      </View>

    </View>
  );
}
