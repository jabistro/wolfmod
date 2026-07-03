import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  SafeAreaView,
  ActivityIndicator,
  Animated,
  StyleSheet,
} from 'react-native';
import { Image } from 'expo-image';
import { SafeAreaView as SafeAreaViewCtx, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../contexts/ThemeContext';
import { getTableArt } from '../data/tableArt';
import { SCENE_TEXT_SHADOW, HUD_CHROME } from '../theme/hud';
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
  // Remote games surface the night report in the village chat (docked below),
  // so the dedicated reveal is replaced by a pointer to it. Local games keep
  // the big reveal for the host to read aloud.
  const isRemote = game.mode === 'remote';

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
    <MorningBackdrop>
      <MasonRevealModal
        state={masonRevealState ?? null}
        onAck={handleMasonAck}
        submitting={ackingMason}
      />
      <InGameLeaveButton onPress={confirmLeave} />
      <View className="px-4 pt-10 pb-3 items-center">
        <Text
          className="text-xs tracking-widest"
          style={{ color: HUD_CHROME, ...SCENE_TEXT_SHADOW }}
        >
          DAWN OF DAY {game.dayNumber + 1}
        </Text>
        <Text
          className="text-wolf-accent text-3xl font-extrabold tracking-widest mt-1"
          style={SCENE_TEXT_SHADOW}
        >
          MORNING
        </Text>
      </View>

      {view.hostMissing && (
        <HostMissingBanner
          gameId={game._id}
          deviceClientId={deviceClientId}
        />
      )}

      {isRemote ? (
        // Remote: the docked chat carries the night report, and its header bar
        // hosts the BEGIN DAY / waiting control — so nothing renders here but a
        // spacer that lets the chat (80% tall at morning) own the screen.
        <View style={{ flex: 1 }} />
      ) : (
        <>
          <Animated.View
            style={{ flex: 1, opacity: fade }}
            className="px-6 items-center justify-center"
          >
            {/* Dark "report" panel keeps the dawn announcement legible over the
                brightening day scene — mirrors the night-trigger panel. */}
            <View style={REPORT_PANEL}>
              {deaths.length === 0 ? (
                <View className="items-center">
                  <Text
                    className="text-wolf-text text-2xl font-bold tracking-widest text-center"
                    style={SCENE_TEXT_SHADOW}
                  >
                    NO ONE HAS DIED
                  </Text>
                  <Text className="text-wolf-text text-sm text-center mt-3">
                    The village wakes safe — for now.
                  </Text>
                </View>
              ) : (
                <View className="items-center" style={{ gap: 18 }}>
                  {deaths.map(d => (
                    <View key={d._id} className="items-center" style={{ gap: 8 }}>
                      <Text
                        className="text-wolf-text text-2xl font-bold tracking-widest text-center"
                        style={SCENE_TEXT_SHADOW}
                      >
                        {d.name.toUpperCase()} HAS BEEN ELIMINATED
                      </Text>
                      {d.role ? (
                        <Text
                          className="text-wolf-text text-base text-center"
                          style={SCENE_TEXT_SHADOW}
                        >
                          ({d.role})
                        </Text>
                      ) : null}
                    </View>
                  ))}
                </View>
              )}
            </View>

            {gameOver && (
              <View
                className="rounded-2xl px-6 py-3 mt-12"
                style={{
                  backgroundColor:
                    game.winner === 'wolf'
                      ? '#8B1818'
                      : game.winner === 'chupacabra'
                        ? '#6B4423'
                        : '#1F4E80',
                }}
              >
                <Text className="text-wolf-text text-base font-extrabold tracking-widest text-center">
                  {game.winner === 'wolf'
                    ? 'WOLVES WIN'
                    : game.winner === 'chupacabra'
                      ? 'CHUPACABRA WINS'
                      : 'VILLAGE WINS'}
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
              <Text
                className="text-xs tracking-widest text-center"
                style={{ color: HUD_CHROME, ...SCENE_TEXT_SHADOW }}
              >
                {gameOver
                  ? 'WAITING FOR HOST TO REVEAL'
                  : 'WAITING FOR HOST TO BEGIN DAY'}
              </Text>
            )}
          </View>
        </>
      )}
    </MorningBackdrop>
  );
}

// Night→morning backdrop: starts on the moonlit night scene, then crossfades
// to the daylight meadow ("dawn breaking") after a short beat. Settling on the
// day backdrop also makes the cut into the Day phase (same scene) seamless.
function MorningBackdrop({ children }: { children: React.ReactNode }) {
  const { theme } = useTheme();
  const art = getTableArt(theme);
  const dayIn = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(dayIn, {
      toValue: 1,
      duration: 1500,
      delay: 350,
      useNativeDriver: true,
    }).start();
  }, [dayIn]);
  return (
    <View style={{ flex: 1, backgroundColor: '#0F0F14' }}>
      <Image
        source={art.backdropNight}
        style={StyleSheet.absoluteFill}
        contentFit="cover"
        cachePolicy="memory-disk"
      />
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: dayIn }]}>
        <Image
          source={art.backdropDay}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          cachePolicy="memory-disk"
        />
      </Animated.View>
      {/* Light scrim, tuned to the day tone we settle on — keeps chrome legible
          without dulling the scene. */}
      <View
        style={{
          ...StyleSheet.absoluteFillObject,
          backgroundColor: 'rgba(15, 15, 20, 0.28)',
        }}
      />
      <SafeAreaViewCtx style={{ flex: 1 }}>{children}</SafeAreaViewCtx>
    </View>
  );
}

const REPORT_PANEL = {
  alignSelf: 'stretch' as const,
  maxWidth: 460,
  paddingVertical: 26,
  paddingHorizontal: 24,
  borderRadius: 22,
  backgroundColor: '#3A3A47',
  alignItems: 'center' as const,
};
