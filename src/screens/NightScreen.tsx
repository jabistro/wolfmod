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
} from 'react-native';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { StackNavigationProp } from '@react-navigation/stack';
import { useMutation, useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import type { RootStackParamList } from '../navigation/types';
import { useDeviceId } from '../hooks/useDeviceId';

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

  const { game, me, isMyStep, stepLabel, wolfState, seerHistory, targetables } =
    view;

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
        <WolvesPicker
          gameId={game._id}
          deviceClientId={deviceClientId}
          targetables={targetables}
          wolves={wolfState.wolves}
        />
      )}

      {isMyStep && game.nightStep === 'seer' && (
        <SeerPicker
          gameId={game._id}
          deviceClientId={deviceClientId}
          targetables={targetables}
          history={seerHistory ?? []}
          nightNumber={game.nightNumber}
        />
      )}

      {!isMyStep && (
        <WaitingView role={me.role} stepLabel={stepLabel} history={seerHistory} />
      )}
    </SafeAreaView>
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

// ───── Wolves picker ────────────────────────────────────────────────────────

function WolvesPicker({
  gameId,
  deviceClientId,
  targetables,
  wolves,
}: {
  gameId: Id<'games'>;
  deviceClientId: string;
  targetables: Targetable[];
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

  // Build a tally for the wolves' awareness panel.
  const voteTally = new Map<Id<'players'>, number>();
  for (const w of wolves) {
    if (w.currentVote) {
      voteTally.set(w.currentVote, (voteTally.get(w.currentVote) ?? 0) + 1);
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

        {/* Targets */}
        <Text className="text-wolf-muted text-xs font-bold tracking-widest mb-2">
          ALIVE PLAYERS
        </Text>
        <View className="gap-y-2">
          {targetables.map(t => {
            const tally = voteTally.get(t._id) ?? 0;
            const isMyPick = myVote === t._id;
            return (
              <TouchableOpacity
                key={t._id}
                onPress={() => handleVote(t._id)}
                disabled={submitting || consensus}
                activeOpacity={0.75}
                className="rounded-xl px-4 py-3 flex-row items-center justify-between"
                style={{
                  backgroundColor: isMyPick ? '#3A2A14' : '#22222F',
                  borderWidth: 1,
                  borderColor: isMyPick ? '#D4A017' : '#2A2A38',
                  opacity: consensus ? 0.6 : 1,
                }}
              >
                <Text
                  className="text-wolf-text text-base"
                  style={{ fontWeight: isMyPick ? '700' : '500' }}
                >
                  {typeof t.seatPosition === 'number'
                    ? `${t.seatPosition + 1}. ${t.name}`
                    : t.name}
                </Text>
                {tally > 0 && (
                  <View
                    className="rounded-full px-2 py-0.5"
                    style={{ backgroundColor: '#8B1818' }}
                  >
                    <Text className="text-wolf-text text-xs font-bold">
                      {tally}
                    </Text>
                  </View>
                )}
              </TouchableOpacity>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}

// ───── Seer picker ──────────────────────────────────────────────────────────

function SeerPicker({
  gameId,
  deviceClientId,
  targetables,
  history,
  nightNumber,
}: {
  gameId: Id<'games'>;
  deviceClientId: string;
  targetables: Targetable[];
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

        <Text className="text-wolf-muted text-xs font-bold tracking-widest mb-2">
          ALIVE PLAYERS
        </Text>
        <View className="gap-y-2">
          {targetables.map(t => (
            <TouchableOpacity
              key={t._id}
              onPress={() => handlePickTarget(t._id, t.name)}
              disabled={submitting || !!pendingTarget || !!pendingResult}
              activeOpacity={0.75}
              className="bg-wolf-card rounded-xl px-4 py-3"
              style={{
                borderWidth: 1,
                borderColor: '#2A2A38',
                opacity: submitting || pendingTarget || pendingResult ? 0.6 : 1,
              }}
            >
              <Text className="text-wolf-text text-base">
                {typeof t.seatPosition === 'number'
                  ? `${t.seatPosition + 1}. ${t.name}`
                  : t.name}
              </Text>
            </TouchableOpacity>
          ))}
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
