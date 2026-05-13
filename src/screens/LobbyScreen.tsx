import React, { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  SafeAreaView,
  Modal,
  ScrollView,
  Pressable,
  Alert,
  Dimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { StackNavigationProp } from '@react-navigation/stack';
import { useMutation, useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import type { RootStackParamList } from '../navigation/types';
import { useDeviceId } from '../hooks/useDeviceId';
import { V1_ROLES } from '../data/v1Roles';
import { ROLES, CATEGORIES, type RoleCategory } from '../data/roles';

// Build the category map for v1 roles once. The role selection modal uses
// this to power its team tabs (Villagers / Wolves / Team Wolf / Solo) so
// the host can quickly filter to a specific team. Solo currently has no
// v1 roles; the tab is still rendered so the structure is in place when
// v2 solo roles land.
const V1_ROLE_CATEGORY_MAP: Map<string, RoleCategory> = (() => {
  const m = new Map<string, RoleCategory>();
  for (const r of ROLES) m.set(r.name, r.category);
  return m;
})();

type Nav = StackNavigationProp<RootStackParamList, 'Lobby'>;
type Route = RouteProp<RootStackParamList, 'Lobby'>;

const SCREEN_WIDTH = Dimensions.get('window').width;
const CIRCLE_SIZE = Math.min(360, SCREEN_WIDTH - 24);
const MIN_SEAT = 30;
const MAX_SEAT = 64;

/**
 * Largest seatSize that keeps adjacent seats from overlapping when N seats are
 * laid out around a circle of diameter `containerSize`. Derivation:
 *   chord = 2*R*sin(π/N), with R = (D - seatSize)/2; require chord >= seatSize.
 *   Solving: seatSize <= D * sin(π/N) / (1 + sin(π/N)).
 */
function computeSeatSize(playerCount: number, containerSize: number): number {
  const s = Math.sin(Math.PI / playerCount);
  const fitMax = (containerSize * s) / (1 + s);
  return Math.max(MIN_SEAT, Math.min(MAX_SEAT, fitMax * 0.85));
}

function seatPos(
  index: number,
  total: number,
  containerSize: number,
  seatSize: number,
) {
  const radius = (containerSize - seatSize) / 2;
  const angle = (2 * Math.PI * index) / total - Math.PI / 2;
  return {
    left: containerSize / 2 + radius * Math.cos(angle) - seatSize / 2,
    top: containerSize / 2 + radius * Math.sin(angle) - seatSize / 2,
  };
}

function seatFontSize(seatSize: number, longName: boolean): number {
  if (seatSize >= 56) return longName ? 9 : 11;
  if (seatSize >= 44) return longName ? 8 : 10;
  if (seatSize >= 36) return 8;
  return 7;
}

function formatRoleSummary(roles: string[]): string {
  const counts: Record<string, number> = {};
  for (const r of roles) counts[r] = (counts[r] ?? 0) + 1;
  return Object.entries(counts)
    .map(([role, count]) => (count > 1 ? `${role} ×${count}` : role))
    .join(', ');
}

export default function LobbyScreen() {
  const navigation = useNavigation<Nav>();
  const { params } = useRoute<Route>();
  const deviceClientId = useDeviceId();
  const insets = useSafeAreaInsets();

  const lobby = useQuery(
    api.games.lobbyView,
    deviceClientId
      ? { gameId: params.gameId as Id<'games'>, deviceClientId }
      : 'skip',
  );

  const assignSeat = useMutation(api.games.assignPlayerToSeat);
  const removeFromSeat = useMutation(api.games.removePlayerFromSeat);
  const setRoles = useMutation(api.games.setRoles);
  const startGame = useMutation(api.games.startGame);
  const leaveGame = useMutation(api.games.leaveGame);
  const seedTestPlayers = useMutation(api.games.seedTestPlayers);

  const [seatModalIndex, setSeatModalIndex] = useState<number | null>(null);
  const [rolesModalOpen, setRolesModalOpen] = useState(false);
  const [draftCounts, setDraftCounts] = useState<Record<string, number>>({});
  const [roleFilter, setRoleFilter] = useState<RoleCategory>('villagers');

  // When the host starts the game, every player's lobby query observes the phase
  // change and auto-navigates to the reveal screen.
  useEffect(() => {
    if (lobby?.game.phase === 'reveal') {
      navigation.replace('RoleReveal', { gameId: params.gameId });
    }
  }, [lobby?.game.phase, navigation, params.gameId]);

  const draftTotal = useMemo(
    () => Object.values(draftCounts).reduce((a, b) => a + b, 0),
    [draftCounts],
  );

  if (!deviceClientId || lobby === undefined) {
    return (
      <SafeAreaView className="flex-1 bg-wolf-bg items-center justify-center">
        <Text className="text-wolf-muted">Loading…</Text>
      </SafeAreaView>
    );
  }
  if (lobby === null) {
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

  const { game, players, me } = lobby;
  const isHost = me?.isHost ?? false;

  const seatedByPosition = new Map<number, (typeof players)[number]>();
  const unseatedPlayers: typeof players = [];
  for (const p of players) {
    if (typeof p.seatPosition === 'number') seatedByPosition.set(p.seatPosition, p);
    else unseatedPlayers.push(p);
  }

  const allSeated =
    seatedByPosition.size === game.playerCount &&
    players.length === game.playerCount;
  const rolesValid = game.selectedRoles.length === game.playerCount;
  const canStart = isHost && allSeated && rolesValid;

  function handleSeatTap(seatIndex: number) {
    if (!isHost) return;
    setSeatModalIndex(seatIndex);
  }

  async function handleAssign(playerId: Id<'players'>) {
    if (seatModalIndex === null || !deviceClientId) return;
    try {
      await assignSeat({
        gameId: game._id,
        playerId,
        seatPosition: seatModalIndex,
        callerDeviceClientId: deviceClientId,
      });
      setSeatModalIndex(null);
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : String(e));
    }
  }

  async function handleRemoveFromSeat(playerId: Id<'players'>) {
    if (!deviceClientId) return;
    try {
      await removeFromSeat({
        gameId: game._id,
        playerId,
        callerDeviceClientId: deviceClientId,
      });
      setSeatModalIndex(null);
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : String(e));
    }
  }

  function openRoleModal() {
    const counts: Record<string, number> = {};
    for (const r of game.selectedRoles) counts[r] = (counts[r] ?? 0) + 1;
    setDraftCounts(counts);
    setRoleFilter('villagers');
    setRolesModalOpen(true);
  }

  function increment(role: string) {
    if (draftTotal >= game.playerCount) return;
    setDraftCounts(c => ({ ...c, [role]: (c[role] ?? 0) + 1 }));
  }
  function decrement(role: string) {
    setDraftCounts(c => {
      const cur = c[role] ?? 0;
      if (cur <= 0) return c;
      const next = { ...c };
      if (cur === 1) delete next[role];
      else next[role] = cur - 1;
      return next;
    });
  }

  async function saveRoles() {
    if (!deviceClientId) return;
    const arr: string[] = [];
    for (const [role, count] of Object.entries(draftCounts)) {
      for (let i = 0; i < count; i++) arr.push(role);
    }
    try {
      await setRoles({
        gameId: game._id,
        roles: arr,
        callerDeviceClientId: deviceClientId,
      });
      setRolesModalOpen(false);
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : String(e));
    }
  }

  async function handleSeedBots() {
    if (!deviceClientId) return;
    try {
      await seedTestPlayers({
        gameId: game._id,
        callerDeviceClientId: deviceClientId,
      });
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : String(e));
    }
  }

  async function handleStart() {
    if (!deviceClientId) return;
    try {
      await startGame({
        gameId: game._id,
        callerDeviceClientId: deviceClientId,
      });
      // Navigation happens via the phase-change effect above for everyone.
    } catch (e) {
      Alert.alert('Cannot start game', e instanceof Error ? e.message : String(e));
    }
  }

  function handleLeave() {
    Alert.alert(
      'Leave game?',
      isHost
        ? "You're the host — leaving ends the game for everyone."
        : "You'll be removed from the lobby.",
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Leave',
          style: 'destructive',
          onPress: async () => {
            if (!deviceClientId) return;
            try {
              await leaveGame({
                gameId: game._id,
                callerDeviceClientId: deviceClientId,
              });
              navigation.popToTop();
            } catch (e) {
              Alert.alert('Error', e instanceof Error ? e.message : String(e));
            }
          },
        },
      ],
    );
  }

  const seatModalOccupant =
    seatModalIndex !== null ? seatedByPosition.get(seatModalIndex) ?? null : null;

  const seatSize = computeSeatSize(game.playerCount, CIRCLE_SIZE);

  return (
    <SafeAreaView className="flex-1 bg-wolf-bg">
      {/* Header */}
      <View className="flex-row items-center px-4 pt-10 pb-3">
        <TouchableOpacity onPress={handleLeave} className="w-16">
          <Text className="text-wolf-text text-base">Leave</Text>
        </TouchableOpacity>
        <Text className="flex-1 text-wolf-text text-xl font-bold text-center">Lobby</Text>
        <View className="w-16" />
      </View>

      <ScrollView
        contentContainerStyle={{
          paddingBottom: 24 + Math.max(insets.bottom, 16),
        }}
      >
        {/* Room code */}
        <View className="items-center pt-2 pb-6">
          <Text className="text-wolf-muted text-xs tracking-widest">ROOM CODE</Text>
          <Text
            className="text-wolf-accent text-5xl font-extrabold mt-1"
            style={{ letterSpacing: 8 }}
          >
            {game.roomCode}
          </Text>
          <Text className="text-wolf-muted text-xs tracking-widest mt-2">
            {players.length} / {game.playerCount} JOINED
          </Text>
        </View>

        {/* Seating circle */}
        <View className="items-center">
          <View
            style={{
              width: CIRCLE_SIZE,
              height: CIRCLE_SIZE,
              position: 'relative',
            }}
          >
            {Array.from({ length: game.playerCount }).map((_, i) => {
              const occupant = seatedByPosition.get(i);
              const pos = seatPos(i, game.playerCount, CIRCLE_SIZE, seatSize);
              const isMe = occupant?._id === me?._id;
              const fontSize = seatFontSize(
                seatSize,
                (occupant?.name.length ?? 0) > 6,
              );
              return (
                <TouchableOpacity
                  key={i}
                  onPress={() => handleSeatTap(i)}
                  disabled={!isHost}
                  activeOpacity={isHost ? 0.6 : 1}
                  style={{
                    position: 'absolute',
                    left: pos.left,
                    top: pos.top,
                    width: seatSize,
                    height: seatSize,
                    borderRadius: seatSize / 2,
                    backgroundColor: occupant ? '#22222F' : '#1A1A24',
                    borderWidth: 2,
                    borderColor: isMe
                      ? '#D4A017'
                      : occupant
                        ? '#3A3A48'
                        : '#2A2A38',
                    alignItems: 'center',
                    justifyContent: 'center',
                    paddingHorizontal: 2,
                  }}
                >
                  <Text
                    style={{
                      color: occupant ? '#F0EDE8' : '#5A5560',
                      fontSize,
                      fontWeight: '600',
                      textAlign: 'center',
                    }}
                    numberOfLines={2}
                  >
                    {occupant ? occupant.name : `${i + 1}`}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        {/* Unseated players */}
        {unseatedPlayers.length > 0 && (
          <View className="px-6 mt-6">
            <Text className="text-wolf-muted text-xs font-bold tracking-widest mb-2">
              {isHost ? 'WAITING FOR SEAT' : 'JOINED'}
            </Text>
            <View className="flex-row flex-wrap" style={{ gap: 8 }}>
              {unseatedPlayers.map(p => (
                <View key={p._id} className="bg-wolf-card rounded-full px-3 py-1.5">
                  <Text className="text-wolf-text text-sm">
                    {p.name}
                    {p.isHost ? ' (host)' : ''}
                  </Text>
                </View>
              ))}
            </View>
          </View>
        )}

        {/* Roles section */}
        <View className="px-6 mt-6">
          <Text className="text-wolf-muted text-xs font-bold tracking-widest mb-2">
            ROLES ({game.selectedRoles.length} / {game.playerCount})
          </Text>
          {isHost ? (
            <TouchableOpacity
              onPress={openRoleModal}
              className="bg-wolf-card rounded-xl px-4 py-4"
              activeOpacity={0.75}
            >
              <Text className="text-wolf-text text-sm">
                {game.selectedRoles.length === 0
                  ? 'Tap to pick roles'
                  : formatRoleSummary(game.selectedRoles)}
              </Text>
            </TouchableOpacity>
          ) : (
            <View className="bg-wolf-card rounded-xl px-4 py-4">
              <Text className="text-wolf-text text-sm">
                {game.selectedRoles.length === 0
                  ? 'Host is picking roles…'
                  : formatRoleSummary(game.selectedRoles)}
              </Text>
            </View>
          )}
        </View>

        {/* Dev-only: fill empty seats with bots so the start button can be tested
            without 30 phones. Hidden in production builds (__DEV__ === false). */}
        {__DEV__ && isHost && players.length < game.playerCount && (
          <View className="px-6 mt-6">
            <TouchableOpacity
              onPress={handleSeedBots}
              activeOpacity={0.75}
              className="bg-wolf-card border border-wolf-accent rounded-xl py-3 items-center"
            >
              <Text className="text-wolf-accent text-xs font-bold tracking-widest">
                FILL EMPTY SEATS (DEV)
              </Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Start button (host only) */}
        {isHost && (
          <View className="px-6 mt-8">
            <TouchableOpacity
              onPress={handleStart}
              disabled={!canStart}
              style={{ opacity: canStart ? 1 : 0.4 }}
              className="bg-wolf-accent rounded-xl py-5 items-center"
            >
              <Text className="text-wolf-bg text-lg font-extrabold tracking-widest">
                START
              </Text>
            </TouchableOpacity>
            {!canStart && (
              <Text className="text-wolf-muted text-xs text-center mt-2">
                {!allSeated
                  ? 'All players must be seated.'
                  : !rolesValid
                    ? `Pick exactly ${game.playerCount} roles.`
                    : ''}
              </Text>
            )}
          </View>
        )}

        {!isHost && (
          <View className="px-6 mt-8">
            <Text className="text-wolf-muted text-xs text-center tracking-widest">
              WAITING FOR HOST TO START
            </Text>
          </View>
        )}
      </ScrollView>

      {/* Seat assignment modal */}
      <Modal
        visible={seatModalIndex !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setSeatModalIndex(null)}
      >
        <Pressable
          onPress={() => setSeatModalIndex(null)}
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
              Seat {(seatModalIndex ?? 0) + 1}
            </Text>

            {seatModalOccupant && (
              <View className="mb-4">
                <Text className="text-wolf-muted text-xs text-center mb-2">
                  Currently: {seatModalOccupant.name}
                </Text>
                <TouchableOpacity
                  onPress={() => handleRemoveFromSeat(seatModalOccupant._id)}
                  className="bg-wolf-card rounded-xl py-3"
                >
                  <Text className="text-wolf-red text-center font-bold">
                    Remove from seat
                  </Text>
                </TouchableOpacity>
              </View>
            )}

            <Text className="text-wolf-muted text-xs font-bold tracking-widest mt-2 mb-2">
              {seatModalOccupant ? 'REPLACE WITH' : 'ASSIGN'}
            </Text>
            <ScrollView style={{ maxHeight: 280 }}>
              {unseatedPlayers.length === 0 ? (
                <Text className="text-wolf-muted text-sm text-center py-4">
                  No unseated players.
                </Text>
              ) : (
                unseatedPlayers.map(p => (
                  <TouchableOpacity
                    key={p._id}
                    onPress={() => handleAssign(p._id)}
                    className="bg-wolf-card rounded-xl px-4 py-3 mb-2"
                  >
                    <Text className="text-wolf-text">
                      {p.name}
                      {p.isHost ? ' (host)' : ''}
                    </Text>
                  </TouchableOpacity>
                ))
              )}
            </ScrollView>
            <TouchableOpacity onPress={() => setSeatModalIndex(null)} className="mt-3 py-2">
              <Text className="text-wolf-muted text-center">Cancel</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Roles picker modal */}
      <Modal
        visible={rolesModalOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setRolesModalOpen(false)}
      >
        <View
          style={{
            flex: 1,
            backgroundColor: 'rgba(0,0,0,0.85)',
            justifyContent: 'flex-end',
          }}
        >
          <View className="bg-wolf-surface rounded-t-3xl" style={{ height: '85%' }}>
            <View className="flex-row items-center px-6 py-4 border-b border-wolf-card">
              <TouchableOpacity onPress={() => setRolesModalOpen(false)} className="w-16">
                <Text className="text-wolf-text">Cancel</Text>
              </TouchableOpacity>
              <Text className="flex-1 text-wolf-text text-base font-bold text-center">
                Roles ({draftTotal} / {game.playerCount})
              </Text>
              <TouchableOpacity
                onPress={saveRoles}
                disabled={draftTotal !== game.playerCount}
                style={{ opacity: draftTotal === game.playerCount ? 1 : 0.4 }}
                className="w-16 items-end"
              >
                <Text className="text-wolf-accent font-bold">Done</Text>
              </TouchableOpacity>
            </View>
            <View
              className="flex-row px-4 py-3 border-b border-wolf-card"
              style={{ gap: 6 }}
            >
              {CATEGORIES.map(tab => {
                const active = roleFilter === tab.key;
                return (
                  <TouchableOpacity
                    key={tab.key}
                    onPress={() => setRoleFilter(tab.key)}
                    style={{
                      flex: 1,
                      backgroundColor: active ? tab.color : '#22222F',
                      paddingVertical: 8,
                      borderRadius: 8,
                      alignItems: 'center',
                      justifyContent: 'center',
                      overflow: 'hidden',
                    }}
                  >
                    {/* Solo tab marks its split-loyalty visual the same way
                        the Roles browser does: a 4px stripe on each side,
                        split top/bottom between village + each wolf hue. */}
                    {tab.key === 'solo' && active && (
                      <>
                        <View
                          style={{
                            position: 'absolute',
                            top: 0,
                            bottom: 0,
                            left: 0,
                            width: 4,
                            flexDirection: 'column',
                          }}
                        >
                          <View style={{ flex: 1, backgroundColor: '#4A90D9' }} />
                          <View style={{ flex: 1, backgroundColor: '#C05050' }} />
                        </View>
                        <View
                          style={{
                            position: 'absolute',
                            top: 0,
                            bottom: 0,
                            right: 0,
                            width: 4,
                            flexDirection: 'column',
                          }}
                        >
                          <View style={{ flex: 1, backgroundColor: '#4A90D9' }} />
                          <View style={{ flex: 1, backgroundColor: '#8B1818' }} />
                        </View>
                      </>
                    )}
                    <Text
                      className="text-wolf-text font-bold"
                      style={{ fontSize: 11, letterSpacing: 0.5 }}
                    >
                      {tab.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <ScrollView contentContainerStyle={{ paddingHorizontal: 24, paddingVertical: 16 }}>
              {(() => {
                const filtered = V1_ROLES.filter(
                  role => V1_ROLE_CATEGORY_MAP.get(role) === roleFilter,
                );
                if (filtered.length === 0) {
                  return (
                    <View className="py-10 items-center">
                      <Text className="text-wolf-muted text-sm text-center">
                        No roles in this team yet.
                      </Text>
                    </View>
                  );
                }
                return filtered.map(role => {
                const count = draftCounts[role] ?? 0;
                const canIncrement = draftTotal < game.playerCount;
                return (
                  <View
                    key={role}
                    className="flex-row items-center py-3 border-b border-wolf-card"
                  >
                    <Text className="text-wolf-text text-base flex-1">{role}</Text>
                    <TouchableOpacity
                      onPress={() => decrement(role)}
                      disabled={count === 0}
                      style={{ opacity: count === 0 ? 0.3 : 1 }}
                      className="w-9 h-9 bg-wolf-card rounded-full items-center justify-center"
                    >
                      <Text className="text-wolf-text text-lg">−</Text>
                    </TouchableOpacity>
                    <Text
                      className="text-wolf-text mx-3 text-center"
                      style={{ minWidth: 24, fontVariant: ['tabular-nums'] }}
                    >
                      {count}
                    </Text>
                    <TouchableOpacity
                      onPress={() => increment(role)}
                      disabled={!canIncrement}
                      style={{ opacity: canIncrement ? 1 : 0.3 }}
                      className="w-9 h-9 bg-wolf-card rounded-full items-center justify-center"
                    >
                      <Text className="text-wolf-text text-lg">+</Text>
                    </TouchableOpacity>
                  </View>
                );
                });
              })()}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}
