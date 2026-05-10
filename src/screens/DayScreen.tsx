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
  Alert,
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

type Nav = StackNavigationProp<RootStackParamList, 'Day'>;
type Route = RouteProp<RootStackParamList, 'Day'>;

type Nomination = {
  nominee: { _id: Id<'players'>; name: string } | null;
  voteEndsAt: number;
  resultsRevealed: boolean;
  votedCount: number;
  eligibleCount: number;
  livesVoters: string[];
  diesVoters: string[];
  myVote: 'lives' | 'dies' | null;
  iAmNominee: boolean;
};

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

  // Phase-driven nav.
  const phase = view?.game.phase;
  useEffect(() => {
    if (phase === 'night') {
      navigation.replace('Night', { gameId: params.gameId });
    } else if (phase === 'morning') {
      navigation.replace('Morning', { gameId: params.gameId });
    } else if (phase === 'ended') {
      navigation.replace('EndGame', { gameId: params.gameId });
    }
  }, [phase, navigation, params.gameId]);

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

  const { game, me, alive, currentNomination } = view;
  const isHost = me.isHost;

  if (currentNomination) {
    if (currentNomination.resultsRevealed) {
      return (
        <ResultsView
          gameId={game._id}
          deviceClientId={deviceClientId}
          dayNumber={game.dayNumber}
          isHost={isHost}
          nomination={currentNomination}
        />
      );
    }
    return (
      <VoteView
        gameId={game._id}
        deviceClientId={deviceClientId}
        dayNumber={game.dayNumber}
        meAlive={me.alive}
        isHost={isHost}
        nomination={currentNomination}
      />
    );
  }

  return (
    <DiscussionView
      gameId={game._id}
      deviceClientId={deviceClientId}
      dayNumber={game.dayNumber}
      isHost={isHost}
      meAlive={me.alive}
      meId={me._id}
      alive={alive}
      totalSeats={game.playerCount}
      onBeginNight={async () => {
        try {
          await beginNight({
            gameId: game._id,
            callerDeviceClientId: deviceClientId,
          });
        } catch (e) {
          Alert.alert(
            'Could not begin night',
            e instanceof Error ? e.message : String(e),
          );
        }
      }}
    />
  );
}

// ───── Discussion view ─────────────────────────────────────────────────────

function DiscussionView({
  gameId,
  deviceClientId,
  dayNumber,
  isHost,
  meAlive,
  meId,
  alive,
  totalSeats,
  onBeginNight,
}: {
  gameId: Id<'games'>;
  deviceClientId: string;
  dayNumber: number;
  isHost: boolean;
  meAlive: boolean;
  meId: Id<'players'>;
  alive: Array<{ _id: Id<'players'>; name: string; seatPosition?: number }>;
  totalSeats: number;
  onBeginNight: () => Promise<void>;
}) {
  const insets = useSafeAreaInsets();
  const nominate = useMutation(api.day.nominate);
  const [confirmTarget, setConfirmTarget] = useState<{
    id: Id<'players'>;
    name: string;
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleBeginVote() {
    if (!confirmTarget) return;
    setSubmitting(true);
    try {
      await nominate({
        gameId,
        callerDeviceClientId: deviceClientId,
        targetPlayerId: confirmTarget.id,
      });
      setConfirmTarget(null);
    } catch (e) {
      Alert.alert('Could not start vote', e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <SafeAreaView className="flex-1 bg-wolf-bg">
      <DayHeader dayNumber={dayNumber} mode="DISCUSSION" />

      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24, alignItems: 'center' }}>
        <Text className="text-wolf-muted text-xs font-bold tracking-widest my-3">
          {alive.length} ALIVE
        </Text>
        <SeatingCircle
          totalSeats={totalSeats}
          players={alive}
          meId={meId}
          onPress={
            isHost
              ? p => setConfirmTarget({ id: p._id, name: p.name })
              : undefined
          }
        />
        {isHost && (
          <Text className="text-wolf-muted text-xs text-center mt-4">
            Tap a player to nominate them.
          </Text>
        )}
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

      {/* Confirm/begin-vote modal — gap for the host to make the verbal call */}
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
            VOTE ON
          </Text>
          <Text className="text-wolf-text text-3xl font-extrabold text-center mb-2">
            {confirmTarget?.name.toUpperCase()}
          </Text>
          <Text className="text-wolf-muted text-sm text-center mb-10">
            Tell the table the rules ("you have a few seconds, vote LIVES or DIES"),
            then start the vote.
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
                  BEGIN VOTE
                </Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

// ───── Vote view (during the timer) ────────────────────────────────────────

function VoteView({
  gameId,
  deviceClientId,
  dayNumber,
  meAlive,
  isHost,
  nomination,
}: {
  gameId: Id<'games'>;
  deviceClientId: string;
  dayNumber: number;
  meAlive: boolean;
  isHost: boolean;
  nomination: Nomination;
}) {
  const insets = useSafeAreaInsets();
  const castVote = useMutation(api.day.castVote);
  const [submitting, setSubmitting] = useState<'lives' | 'dies' | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(t);
  }, []);

  const remainingMs = Math.max(0, nomination.voteEndsAt - now);
  const remainingSec = Math.ceil(remainingMs / 1000);

  async function handleVote(vote: 'lives' | 'dies') {
    if (!meAlive) return;
    setSubmitting(vote);
    try {
      await castVote({
        gameId,
        callerDeviceClientId: deviceClientId,
        vote,
      });
    } catch (e) {
      Alert.alert('Could not vote', e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <SafeAreaView className="flex-1 bg-wolf-bg">
      <DayHeader dayNumber={dayNumber} mode="VOTING" />

      <View className="flex-1 px-6 items-center justify-center">
        <Text className="text-wolf-muted text-xs font-bold tracking-widest mb-2">
          VOTE ON
        </Text>
        <Text className="text-wolf-text text-4xl font-extrabold tracking-widest mb-8 text-center">
          {nomination.nominee?.name.toUpperCase() ?? '—'}
        </Text>

        <View className="items-center mb-8">
          <Text
            className="text-wolf-accent text-7xl font-extrabold"
            style={{ fontVariant: ['tabular-nums'] }}
          >
            {remainingSec}
          </Text>
          <Text className="text-wolf-muted text-xs tracking-widest mt-1">
            SECONDS
          </Text>
        </View>

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
              disabled={!!submitting}
              className="rounded-2xl px-12 py-8 items-center"
              style={{
                backgroundColor:
                  nomination.myVote === 'lives' ? '#1F4E80' : '#22222F',
                borderWidth: 2,
                borderColor:
                  nomination.myVote === 'lives' ? '#5BA0E5' : '#2A2A38',
                opacity: submitting === 'dies' ? 0.4 : 1,
              }}
            >
              <Text className="text-wolf-text text-2xl font-extrabold tracking-widest">
                LIVES
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => handleVote('dies')}
              disabled={!!submitting}
              className="rounded-2xl px-12 py-8 items-center"
              style={{
                backgroundColor:
                  nomination.myVote === 'dies' ? '#8B1818' : '#22222F',
                borderWidth: 2,
                borderColor:
                  nomination.myVote === 'dies' ? '#B03A2E' : '#2A2A38',
                opacity: submitting === 'lives' ? 0.4 : 1,
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
          alignItems: 'center',
        }}
      >
        <Text className="text-wolf-muted text-xs tracking-widest">
          {isHost ? 'HOST — RESULTS POST WHEN TIMER ENDS' : 'WAITING FOR TIMER'}
        </Text>
      </View>
    </SafeAreaView>
  );
}

// ───── Results view (post-vote) ────────────────────────────────────────────

function ResultsView({
  gameId,
  deviceClientId,
  dayNumber,
  isHost,
  nomination,
}: {
  gameId: Id<'games'>;
  deviceClientId: string;
  dayNumber: number;
  isHost: boolean;
  nomination: Nomination;
}) {
  const insets = useSafeAreaInsets();
  const continueGame = useMutation(api.day.continueGameAfterVote);
  const [submitting, setSubmitting] = useState(false);

  const livesCount = nomination.livesVoters.length;
  const diesCount = nomination.diesVoters.length;
  const lynch = diesCount > livesCount;

  async function handleContinue() {
    setSubmitting(true);
    try {
      await continueGame({
        gameId,
        callerDeviceClientId: deviceClientId,
      });
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <SafeAreaView className="flex-1 bg-wolf-bg">
      <DayHeader dayNumber={dayNumber} mode="VOTE RESULT" />

      <ScrollView contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: 24 }}>
        <View className="items-center mt-2 mb-6">
          <Text className="text-wolf-muted text-xs font-bold tracking-widest mb-1">
            VOTED ON
          </Text>
          <Text className="text-wolf-text text-3xl font-extrabold tracking-widest text-center">
            {nomination.nominee?.name.toUpperCase() ?? '—'}
          </Text>
          <View
            className="mt-3 rounded-full px-5 py-1.5"
            style={{ backgroundColor: lynch ? '#8B1818' : '#1F4E80' }}
          >
            <Text className="text-wolf-text text-sm font-extrabold tracking-widest">
              {lynch ? 'ELIMINATED' : 'LIVES'}
            </Text>
          </View>
        </View>

        <View className="flex-row" style={{ gap: 12 }}>
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
            disabled={submitting}
            style={{ opacity: submitting ? 0.4 : 1 }}
            className="bg-wolf-accent rounded-xl py-5 items-center"
          >
            {submitting ? (
              <ActivityIndicator color="#0F0F14" />
            ) : (
              <Text className="text-wolf-bg text-lg font-extrabold tracking-widest">
                CONTINUE GAME
              </Text>
            )}
          </TouchableOpacity>
        ) : (
          <Text className="text-wolf-muted text-xs tracking-widest text-center">
            WAITING FOR HOST TO CONTINUE
          </Text>
        )}
      </View>
    </SafeAreaView>
  );
}

// ───── Header ──────────────────────────────────────────────────────────────

function DayHeader({ dayNumber, mode }: { dayNumber: number; mode: string }) {
  return (
    <View className="px-4 pt-10 pb-3 items-center">
      <Text className="text-wolf-muted text-xs tracking-widest">
        DAY {dayNumber}
      </Text>
      <Text className="text-wolf-accent text-3xl font-extrabold tracking-widest mt-1">
        {mode}
      </Text>
    </View>
  );
}
