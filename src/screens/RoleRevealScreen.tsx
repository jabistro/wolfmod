import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  Image,
  SafeAreaView,
  Pressable,
  TouchableOpacity,
  Alert,
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
import { ROLES } from '../data/roles';
import { teamForRole, type Team } from '../data/v1Roles';

type Nav = StackNavigationProp<RootStackParamList, 'RoleReveal'>;
type Route = RouteProp<RootStackParamList, 'RoleReveal'>;

const HOLD_DELAY_MS = 1000;

const TEAM_COLORS: Record<Team, { bg: string; label: string }> = {
  village: { bg: '#4A90D9', label: 'VILLAGE' },
  wolf: { bg: '#8B1818', label: 'WOLF TEAM' },
  solo: { bg: '#8B6436', label: 'SOLO' },
};

export default function RoleRevealScreen() {
  const navigation = useNavigation<Nav>();
  const { params } = useRoute<Route>();
  const deviceClientId = useDeviceId();
  const insets = useSafeAreaInsets();

  const reveal = useQuery(
    api.games.revealView,
    deviceClientId
      ? { gameId: params.gameId as Id<'games'>, deviceClientId }
      : 'skip',
  );
  const confirmReveal = useMutation(api.games.confirmRoleReveal);

  const [isPressed, setIsPressed] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [hasSeenRole, setHasSeenRole] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fadeAnim = useRef(new Animated.Value(0)).current;

  // Fade the role card in every time `revealed` flips true (not just the first
  // mount). Resetting to 0 first guarantees the fade actually plays on repeat
  // reveals — without the explicit setValue, the Animated.Value would already
  // be at 1 from the previous reveal and the second reveal would pop in.
  useEffect(() => {
    if (revealed) {
      fadeAnim.setValue(0);
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 320,
        useNativeDriver: true,
      }).start();
    }
  }, [revealed, fadeAnim]);

  useEffect(() => {
    return () => {
      if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    };
  }, []);

  // When the phase advances past reveal, route every player forward. Hook
  // must be declared before any conditional returns so the hook order stays
  // stable across renders (loading → loaded transitions otherwise change the
  // hook count and React throws).
  const phase = reveal?.game.phase;
  useEffect(() => {
    if (phase === 'night') {
      navigation.replace('Night', { gameId: params.gameId });
    } else if (phase === 'morning') {
      navigation.replace('Morning', { gameId: params.gameId });
    } else if (phase === 'day') {
      navigation.replace('Day', { gameId: params.gameId });
    } else if (phase === 'ended') {
      navigation.replace('EndGame', { gameId: params.gameId });
    }
  }, [phase, navigation, params.gameId]);

  if (!deviceClientId || reveal === undefined) {
    return (
      <SafeAreaView className="flex-1 bg-wolf-bg items-center justify-center">
        <ActivityIndicator color="#D4A017" />
      </SafeAreaView>
    );
  }
  if (reveal === null) {
    return (
      <SafeAreaView className="flex-1 bg-wolf-bg items-center justify-center px-8">
        <Text className="text-wolf-text text-lg text-center mb-6">
          This game no longer exists.
        </Text>
        <TouchableOpacity
          onPress={() => navigation.popToTop()}
          className="bg-wolf-accent rounded-xl px-6 py-3"
        >
          <Text className="text-wolf-bg font-bold tracking-widest">HOME</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  const { game, me, visibleTeammates, confirmedCount, totalPlayers } = reveal;

  if (game.phase !== 'reveal' && game.phase !== 'lobby') {
    return (
      <SafeAreaView className="flex-1 bg-wolf-bg items-center justify-center">
        <ActivityIndicator color="#D4A017" />
      </SafeAreaView>
    );
  }

  if (!me.role) {
    return (
      <SafeAreaView className="flex-1 bg-wolf-bg items-center justify-center">
        <Text className="text-wolf-muted">Waiting for roles to be dealt…</Text>
      </SafeAreaView>
    );
  }

  const roleData = ROLES.find(r => r.name === me.role);
  const team = teamForRole(me.role);
  const teamColor = TEAM_COLORS[team];
  const isConfirmed = me.revealedAt !== undefined;

  function onPressIn() {
    setIsPressed(true);
    holdTimerRef.current = setTimeout(() => {
      setRevealed(true);
      setHasSeenRole(true);
    }, HOLD_DELAY_MS);
  }

  function onPressOut() {
    setIsPressed(false);
    setRevealed(false);
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  }

  async function handleConfirm() {
    if (!deviceClientId) return;
    setConfirming(true);
    try {
      await confirmReveal({
        gameId: game._id,
        callerDeviceClientId: deviceClientId,
      });
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : String(e));
    } finally {
      setConfirming(false);
    }
  }

  // After this player has confirmed: waiting screen until everyone else confirms.
  if (isConfirmed) {
    return (
      <SafeAreaView className="flex-1 bg-wolf-bg">
        <View className="flex-1 items-center justify-center px-8">
          <Text className="text-wolf-muted text-xs font-bold tracking-widest mb-3">
            PLAYERS READY
          </Text>
          <Text
            className="text-wolf-accent text-7xl font-extrabold"
            style={{ fontVariant: ['tabular-nums'] }}
          >
            {confirmedCount} / {totalPlayers}
          </Text>
          <Text className="text-wolf-muted text-sm text-center mt-12">
            Waiting for the others to confirm their roles…
          </Text>
          <ActivityIndicator color="#D4A017" style={{ marginTop: 24 }} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-wolf-bg">
      <View className="flex-row items-center px-4 pt-10 pb-3">
        <View className="w-16" />
        <Text className="flex-1 text-wolf-text text-xl font-bold text-center">
          Your Role
        </Text>
        <View className="w-16" />
      </View>

      <View className="px-6 items-center mb-3">
        <Text className="text-wolf-muted text-xs font-bold tracking-widest">
          {typeof me.seatPosition === 'number'
            ? `SEAT ${me.seatPosition + 1} • ${me.name.toUpperCase()}`
            : me.name.toUpperCase()}
        </Text>
      </View>

      <View className="flex-1 items-center justify-center px-6">
        {revealed ? (
          <Animated.View style={{ alignItems: 'center', opacity: fadeAnim }}>
            {roleData?.image && (
              <Image
                source={roleData.image}
                style={{ width: 200, height: 280, borderRadius: 12 }}
                resizeMode="cover"
              />
            )}
            <Text className="text-wolf-text text-3xl font-bold mt-4 text-center">
              {me.role}
            </Text>
            <View
              className="mt-3 rounded-full px-4 py-1"
              style={{ backgroundColor: teamColor.bg }}
            >
              <Text className="text-wolf-bg text-xs font-extrabold tracking-widest">
                {teamColor.label}
              </Text>
            </View>
            {visibleTeammates.length > 0 && (
              <View className="mt-6 items-center">
                <Text className="text-wolf-muted text-xs font-bold tracking-widest mb-2">
                  {me.role === 'Minion' ? 'THE WOLVES' : 'YOUR PACK'}
                </Text>
                {visibleTeammates.map(t => (
                  <Text key={t.name} className="text-wolf-text text-sm">
                    {t.name} <Text className="text-wolf-muted">({t.role})</Text>
                  </Text>
                ))}
              </View>
            )}
          </Animated.View>
        ) : (
          <View className="items-center">
            <View
              className="w-44 h-60 bg-wolf-card rounded-xl items-center justify-center"
              style={{ borderWidth: 1, borderColor: '#2A2A38' }}
            >
              <Text className="text-wolf-muted text-5xl">?</Text>
            </View>
            <Text className="text-wolf-muted text-sm text-center mt-6">
              {hasSeenRole
                ? 'Press and hold again to view.\nTap OK below when ready.'
                : 'Press and hold the button below\nto reveal your role.'}
            </Text>
          </View>
        )}
      </View>

      <View style={{ paddingHorizontal: 24, marginBottom: 16 }}>
        <Pressable
          onPressIn={onPressIn}
          onPressOut={onPressOut}
          style={{
            backgroundColor: isPressed ? '#2A2A38' : '#22222F',
            borderRadius: 16,
            paddingVertical: 22,
            alignItems: 'center',
            borderWidth: 2,
            borderColor: isPressed ? '#D4A017' : '#5A5560',
          }}
        >
          <Text className="text-wolf-text text-base font-bold tracking-widest">
            {revealed
              ? 'HOLDING…'
              : isPressed
                ? 'KEEP HOLDING…'
                : 'HOLD TO REVEAL'}
          </Text>
        </Pressable>
      </View>

      <View
        style={{
          paddingHorizontal: 24,
          paddingBottom: Math.max(insets.bottom, 16) + 16,
        }}
      >
        <TouchableOpacity
          onPress={handleConfirm}
          disabled={!hasSeenRole || confirming}
          style={{ opacity: hasSeenRole && !confirming ? 1 : 0.4 }}
          className="bg-wolf-accent rounded-xl py-5 items-center"
        >
          {confirming ? (
            <ActivityIndicator color="#0F0F14" />
          ) : (
            <Text className="text-wolf-bg text-lg font-extrabold tracking-widest">
              OK, I'M READY
            </Text>
          )}
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}
