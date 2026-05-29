import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  SafeAreaView,
  Pressable,
  TouchableOpacity,
  ActivityIndicator,
  Animated,
  ScrollView,
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
import RoleCard from '../components/RoleCard';
import { InGameLeaveButton } from '../components/InGameLeaveButton';
import { useGameLeaveHandler } from '../hooks/useGameLeaveHandler';
import { HostMissingBanner } from '../components/HostMissingBanner';

type Nav = StackNavigationProp<RootStackParamList, 'RoleReveal'>;
type Route = RouteProp<RootStackParamList, 'RoleReveal'>;

const HOLD_DELAY_MS = 1000;

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
  const confirmDoppelganger = useMutation(api.games.confirmDoppelgangerTarget);
  const beginDayFromReveal = useMutation(api.games.beginDayFromReveal);
  const [beginningDay, setBeginningDay] = useState(false);

  const [isPressed, setIsPressed] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [hasSeenRole, setHasSeenRole] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [pickingDoppelganger, setPickingDoppelganger] = useState(false);
  const [doppelgangerPick, setDoppelgangerPick] = useState<Id<'players'> | null>(null);
  const [submittingPick, setSubmittingPick] = useState(false);
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

  const { confirmLeave } = useGameLeaveHandler({
    gameId: params.gameId as Id<'games'>,
    deviceClientId,
    isHost: reveal?.me.isHost,
  });

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

  const { game, me, visibleTeammates, confirmedCount, totalPlayers, allConfirmed, doppelgangerCandidates } = reveal;
  const isDoppelganger = me.role === 'Doppelganger';

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

  const isConfirmed = me.revealedAt !== undefined;

  // Tiered shrink so the card + pack list always fit between the headers and
  // the HOLD button without scrolling. Widest case in Ultimate Werewolf is
  // ~6 wolves + a Minion = 6 visible teammates.
  const packCount = visibleTeammates.length;
  const cardWidth = packCount >= 4 ? 200 : 240;
  const packTextStyle =
    packCount >= 4
      ? { fontSize: 12, lineHeight: 16 }
      : { fontSize: 14, lineHeight: 20 };
  const packTopMargin = packCount >= 4 ? 12 : 16;

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
    // Doppelganger routes through the seat picker before being counted
    // ready — the picker's submit handler is what calls the server.
    if (isDoppelganger) {
      setPickingDoppelganger(true);
      return;
    }
    setConfirming(true);
    try {
      await confirmReveal({
        gameId: game._id,
        callerDeviceClientId: deviceClientId,
      });
    } catch (e) {
      showAlert('Error', e instanceof Error ? e.message : String(e));
    } finally {
      setConfirming(false);
    }
  }

  async function submitDoppelgangerPick() {
    if (!deviceClientId || doppelgangerPick === null) return;
    setSubmittingPick(true);
    try {
      await confirmDoppelganger({
        gameId: game._id,
        targetPlayerId: doppelgangerPick,
        callerDeviceClientId: deviceClientId,
      });
    } catch (e) {
      showAlert('Error', e instanceof Error ? e.message : String(e));
    } finally {
      setSubmittingPick(false);
    }
  }

  // After this player has confirmed: waiting screen until everyone else
  // confirms. Once everyone has confirmed, the host gets a BEGIN DAY 1
  // button; non-hosts wait for the host to tap it.
  async function handleBeginDay() {
    if (!deviceClientId) return;
    setBeginningDay(true);
    try {
      await beginDayFromReveal({
        gameId: game._id,
        callerDeviceClientId: deviceClientId,
      });
    } catch (e) {
      showAlert('Error', e instanceof Error ? e.message : String(e));
    } finally {
      setBeginningDay(false);
    }
  }

  // Doppelganger seat-picker: shown after the role reveal is acked but
  // before `confirmDoppelgangerTarget` lands. Until they pick, they aren't
  // counted ready and the host can't start the game.
  if (pickingDoppelganger && !isConfirmed) {
    return (
      <SafeAreaView className="flex-1 bg-wolf-bg">
        <InGameLeaveButton onPress={confirmLeave} />
        <View className="flex-row items-center px-4 pt-10 pb-3">
          <View className="w-16" />
          <Text className="flex-1 text-wolf-text text-xl font-bold text-center">
            Pick Your Target
          </Text>
          <View className="w-16" />
        </View>
        <Text className="text-wolf-muted text-sm text-center px-8 mb-4">
          When this player is eliminated, you become their role.
        </Text>
        <ScrollView
          contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: 24 }}
          style={{ flex: 1 }}
        >
          {doppelgangerCandidates.map(c => {
            const selected = doppelgangerPick === c._id;
            return (
              <TouchableOpacity
                key={c._id}
                onPress={() => setDoppelgangerPick(c._id)}
                style={{
                  backgroundColor: selected ? '#D4A017' : '#22222F',
                  borderRadius: 12,
                  paddingVertical: 16,
                  paddingHorizontal: 16,
                  marginBottom: 8,
                  borderWidth: 1,
                  borderColor: selected ? '#D4A017' : '#2A2A38',
                  flexDirection: 'row',
                  alignItems: 'center',
                }}
              >
                <Text
                  style={{
                    color: selected ? '#0F0F14' : '#8A8590',
                    fontSize: 12,
                    fontWeight: '700',
                    width: 56,
                  }}
                >
                  {typeof c.seatPosition === 'number'
                    ? `SEAT ${c.seatPosition + 1}`
                    : ''}
                </Text>
                <Text
                  style={{
                    color: selected ? '#0F0F14' : '#F0EDE8',
                    fontSize: 16,
                    fontWeight: selected ? '700' : '500',
                    flex: 1,
                  }}
                >
                  {c.name}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
        <View
          style={{
            paddingHorizontal: 24,
            paddingBottom: Math.max(insets.bottom, 16) + 16,
          }}
        >
          <TouchableOpacity
            onPress={submitDoppelgangerPick}
            disabled={doppelgangerPick === null || submittingPick}
            style={{
              opacity: doppelgangerPick !== null && !submittingPick ? 1 : 0.4,
            }}
            className="bg-wolf-accent rounded-xl py-5 items-center"
          >
            {submittingPick ? (
              <ActivityIndicator color="#0F0F14" />
            ) : (
              <Text className="text-wolf-bg text-lg font-extrabold tracking-widest">
                LOCK IN
              </Text>
            )}
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  if (isConfirmed) {
    return (
      <SafeAreaView className="flex-1 bg-wolf-bg">
        <InGameLeaveButton onPress={confirmLeave} />
        {reveal.hostMissing && (
          <View style={{ marginTop: 70 }}>
            <HostMissingBanner
              gameId={game._id}
              deviceClientId={deviceClientId}
            />
          </View>
        )}
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
          {allConfirmed ? (
            me.isHost ? (
              <View className="items-center mt-12 w-full" style={{ paddingHorizontal: 24 }}>
                <Text className="text-wolf-muted text-sm text-center mb-4">
                  Everyone has their role. Start the game when the table is ready.
                </Text>
                <TouchableOpacity
                  onPress={handleBeginDay}
                  disabled={beginningDay}
                  style={{ opacity: beginningDay ? 0.4 : 1, width: '100%' }}
                  className="bg-wolf-accent rounded-xl py-5 items-center"
                >
                  {beginningDay ? (
                    <ActivityIndicator color="#0F0F14" />
                  ) : (
                    <Text className="text-wolf-bg text-lg font-extrabold tracking-widest">
                      BEGIN DAY 1
                    </Text>
                  )}
                </TouchableOpacity>
              </View>
            ) : (
              <>
                <Text className="text-wolf-muted text-sm text-center mt-12">
                  Waiting for the host to begin Day 1…
                </Text>
                <ActivityIndicator color="#D4A017" style={{ marginTop: 24 }} />
              </>
            )
          ) : (
            <>
              <Text className="text-wolf-muted text-sm text-center mt-12">
                Waiting for the others to confirm their roles…
              </Text>
              <ActivityIndicator color="#D4A017" style={{ marginTop: 24 }} />
            </>
          )}
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-wolf-bg">
      <InGameLeaveButton onPress={confirmLeave} />
      <View className="flex-row items-center px-4 pt-10 pb-3">
        <View className="w-16" />
        <Text className="flex-1 text-wolf-text text-xl font-bold text-center">
          Your Role
        </Text>
        <View className="w-16" />
      </View>

      {reveal.hostMissing && (
        <HostMissingBanner
          gameId={game._id}
          deviceClientId={deviceClientId}
        />
      )}

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
            <RoleCard role={me.role} width={cardWidth} />
            {visibleTeammates.length > 0 && (
              <View style={{ marginTop: packTopMargin, alignItems: 'center' }}>
                <Text
                  className="text-wolf-muted text-xs font-bold tracking-widest mb-1"
                  numberOfLines={1}
                >
                  {me.role === 'Minion' ? 'THE WOLVES' : 'YOUR PACK'}
                </Text>
                {visibleTeammates.map(t => (
                  <Text
                    key={t.name}
                    className="text-wolf-text"
                    style={packTextStyle}
                  >
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
