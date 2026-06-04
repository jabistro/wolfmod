import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  SafeAreaView,
  ActivityIndicator,
  Animated,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { StackNavigationProp } from '@react-navigation/stack';
import { useMutation, useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import type { RootStackParamList } from '../navigation/types';
import { useDeviceId } from '../hooks/useDeviceId';
import { showAlert } from '../components/ThemedAlert';
import { InGameLeaveButton } from '../components/InGameLeaveButton';
import { useGameLeaveHandler } from '../hooks/useGameLeaveHandler';
import { HostMissingBanner } from '../components/HostMissingBanner';
import { MasonRevealModal } from '../components/MasonRevealModal';

type Nav = StackNavigationProp<RootStackParamList, 'Morning'>;
type Route = RouteProp<RootStackParamList, 'Morning'>;

export default function MorningScreen() {
  const navigation = useNavigation<Nav>();
  const { params } = useRoute<Route>();
  const deviceClientId = useDeviceId();
  const insets = useSafeAreaInsets();

  const view = useQuery(
    api.night.morningView,
    deviceClientId
      ? { gameId: params.gameId as Id<'games'>, deviceClientId }
      : 'skip',
  );

  const beginDay = useMutation(api.night.beginDay);
  const submitMasonAck = useMutation(api.night.submitMasonAck);
  const [submitting, setSubmitting] = useState(false);
  const [ackingMason, setAckingMason] = useState(false);

  // Fade-in for the announcement so it doesn't snap into view.
  const fade = useState(new Animated.Value(0))[0];
  useEffect(() => {
    if (view) {
      Animated.timing(fade, {
        toValue: 1,
        duration: 600,
        useNativeDriver: true,
      }).start();
    }
  }, [view !== undefined, fade]);

  // Phase-driven nav.
  useEffect(() => {
    if (!view) return;
    const phase = view.game.phase;
    if (phase === 'day') {
      navigation.replace('Day', { gameId: params.gameId });
    } else if (phase === 'night') {
      navigation.replace('Night', { gameId: params.gameId });
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

  const { game, me, deaths, masonRevealState } = view;
  const gameOver = !!game.winner;

  async function handleMasonAck() {
    if (!deviceClientId) return;
    setAckingMason(true);
    try {
      await submitMasonAck({ gameId: game._id, callerDeviceClientId: deviceClientId });
    } catch (e) {
      showAlert('Error', e instanceof Error ? e.message : String(e));
    } finally {
      setAckingMason(false);
    }
  }

  async function handleBeginDay() {
    if (!deviceClientId) return;
    setSubmitting(true);
    try {
      await beginDay({ gameId: game._id, callerDeviceClientId: deviceClientId });
    } catch (e) {
      showAlert(
        'Could not begin day',
        e instanceof Error ? e.message : String(e),
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <SafeAreaView className="flex-1 bg-wolf-bg">
      <MasonRevealModal
        state={masonRevealState ?? null}
        onAck={handleMasonAck}
        submitting={ackingMason}
      />
      <InGameLeaveButton onPress={confirmLeave} />
      <View className="px-4 pt-10 pb-3 items-center">
        <Text className="text-wolf-muted text-xs tracking-widest">
          DAWN OF DAY {game.dayNumber + 1}
        </Text>
        <Text className="text-wolf-accent text-3xl font-extrabold tracking-widest mt-1">
          MORNING
        </Text>
      </View>

      {view.hostMissing && (
        <HostMissingBanner
          gameId={game._id}
          deviceClientId={deviceClientId}
        />
      )}

      <Animated.View
        style={{ flex: 1, opacity: fade }}
        className="px-6 items-center justify-center"
      >
        {deaths.length === 0 ? (
          <View className="items-center">
            <Text className="text-wolf-text text-2xl font-bold tracking-widest text-center">
              NO ONE HAS DIED
            </Text>
            <Text className="text-wolf-muted text-sm text-center mt-3">
              The village wakes safe — for now.
            </Text>
          </View>
        ) : (
          <View className="items-center" style={{ gap: 18 }}>
            {deaths.map(d => (
              <Text
                key={d._id}
                className="text-wolf-text text-2xl font-bold tracking-widest text-center"
              >
                {d.name.toUpperCase()} HAS BEEN ELIMINATED
              </Text>
            ))}
          </View>
        )}

        {gameOver && (
          <View
            className="rounded-2xl px-6 py-3 mt-12"
            style={{
              backgroundColor:
                game.winner === 'wolf' ? '#8B1818' : '#1F4E80',
            }}
          >
            <Text className="text-wolf-text text-base font-extrabold tracking-widest text-center">
              {game.winner === 'wolf' ? 'WOLVES WIN' : 'VILLAGE WINS'}
            </Text>
          </View>
        )}
      </Animated.View>

      <View
        style={{
          paddingHorizontal: 24,
          paddingBottom: Math.max(insets.bottom, 16) + 16,
        }}
      >
        {me.isHost ? (
          <TouchableOpacity
            onPress={handleBeginDay}
            disabled={submitting}
            style={{ opacity: submitting ? 0.4 : 1 }}
            className="bg-wolf-accent rounded-xl py-5 items-center"
          >
            {submitting ? (
              <ActivityIndicator color="#0F0F14" />
            ) : (
              <Text className="text-wolf-bg text-lg font-extrabold tracking-widest">
                {gameOver ? 'VIEW RESULTS' : 'BEGIN DAY'}
              </Text>
            )}
          </TouchableOpacity>
        ) : (
          <Text className="text-wolf-muted text-xs tracking-widest text-center">
            {gameOver
              ? 'WAITING FOR HOST TO REVEAL'
              : 'WAITING FOR HOST TO BEGIN DAY'}
          </Text>
        )}
      </View>
    </SafeAreaView>
  );
}
