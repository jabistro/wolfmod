import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  SafeAreaView,
  Modal,
  ScrollView,
  Pressable,
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
import {
  V1_ROLES,
  isSingletonRole,
  isWolfTeam,
  incompatibleRolesInBuild,
} from '../data/v1Roles';
import { ROLES, CATEGORIES, roleSortKey, type RoleCategory } from '../data/roles';
import { getRoleValue } from '../data/roleValues';
import TimersConfigModal from '../components/TimersConfigModal';
import RolesBrowserModal from '../components/RolesBrowserModal';
import { showAlert } from '../components/ThemedAlert';
import { useAndroidBack } from '../hooks/useAndroidBack';
import { DEV_FEATURES_AVAILABLE } from '../config/devFlags';
import { useDevMode } from '../contexts/DevModeContext';

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
const MIN_PLAYER_COUNT = 3;
const MAX_PLAYER_COUNT = 40;

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

function BalanceLine({ roles }: { roles: string[] }) {
  let total = 0;
  for (const r of roles) total += getRoleValue(r);
  const color = total > 0 ? '#4caf50' : total < 0 ? '#ef5350' : '#8A8590';
  return (
    <Text
      style={{
        color,
        fontSize: 12,
        fontWeight: '600',
        marginTop: 16,
      }}
    >
      Balance: {total > 0 ? `+${total}` : total}
    </Text>
  );
}

export default function LobbyScreen() {
  const navigation = useNavigation<Nav>();
  const { params } = useRoute<Route>();
  const deviceClientId = useDeviceId();
  const insets = useSafeAreaInsets();
  const { devModeEnabled } = useDevMode();
  // Lobby dev tools require both an opted-in build and the host's toggle being on.
  const showDevTools = DEV_FEATURES_AVAILABLE && devModeEnabled;

  const lobby = useQuery(
    api.games.lobbyView,
    deviceClientId
      ? { gameId: params.gameId as Id<'games'>, deviceClientId }
      : 'skip',
  );

  const assignSeat = useMutation(api.games.assignPlayerToSeat);
  const removeFromSeat = useMutation(api.games.removePlayerFromSeat);
  const removeFromGame = useMutation(api.games.removePlayerFromGame);
  const clearAllSeats = useMutation(api.games.clearAllSeats);
  const setPlayerCount = useMutation(api.games.setPlayerCount);
  const setRoles = useMutation(api.games.setRoles);
  const startGame = useMutation(api.games.startGame);
  const leaveGame = useMutation(api.games.leaveGame);
  const seedTestPlayers = useMutation(api.games.seedTestPlayers);
  const setDevRoleAssignments = useMutation(api.games.setDevRoleAssignments);

  const [seatModalIndex, setSeatModalIndex] = useState<number | null>(null);
  const [rolesModalOpen, setRolesModalOpen] = useState(false);
  const [timersModalOpen, setTimersModalOpen] = useState(false);
  const [browseRolesOpen, setBrowseRolesOpen] = useState(false);
  const [devAssignOpen, setDevAssignOpen] = useState(false);
  const [devPickerSeat, setDevPickerSeat] = useState<number | null>(null);
  const [draftCounts, setDraftCounts] = useState<Record<string, number>>({});
  const [roleFilter, setRoleFilter] = useState<RoleCategory>('villagers');
  const rolesPagerRef = useRef<ScrollView | null>(null);
  const [rolesPagerWidth, setRolesPagerWidth] = useState(SCREEN_WIDTH);

  // Phase-driven nav. In the normal flow Lobby only ever transitions to
  // 'reveal' on host start, but a rejoining player can land on Lobby with the
  // game already mid-flight — route them to the right screen for the current
  // phase.
  useEffect(() => {
    const phase = lobby?.game.phase;
    if (phase === 'reveal') {
      navigation.replace('RoleReveal', { gameId: params.gameId });
    } else if (phase === 'night') {
      navigation.replace('Night', { gameId: params.gameId });
    } else if (phase === 'triggers') {
      navigation.replace('Triggers', { gameId: params.gameId });
    } else if (phase === 'morning') {
      navigation.replace('Morning', { gameId: params.gameId });
    } else if (phase === 'day') {
      navigation.replace('Day', { gameId: params.gameId });
    } else if (phase === 'ended') {
      navigation.replace('EndGame', { gameId: params.gameId });
    }
  }, [lobby?.game.phase, navigation, params.gameId]);

  // Android hardware-back: route to the Leave confirmation. handleLeave is
  // defined further down (it needs `game` and `isHost`), so we forward via
  // a ref that the latest render keeps fresh.
  const handleLeaveRef = useRef<() => void>(() => {});
  useAndroidBack(
    useCallback(() => {
      handleLeaveRef.current();
      return true;
    }, []),
  );

  // Voluntary-leave guard. leaveGame() deletes our player row, which makes
  // lobby.me go null on the next reactive update — same shape as host-kick.
  // Without this flag the "removed" screen would flash between mutation
  // resolve and navigation.popToTop().
  const leftIntentionallyRef = useRef(false);

  const draftTotal = useMemo(
    () => Object.values(draftCounts).reduce((a, b) => a + b, 0),
    [draftCounts],
  );
  // Roles currently in the draft (count > 0) — used to enforce hard-excluded
  // role pairs (e.g. Alpha Wolf can't share a build with Witch/Leprechaun).
  const draftedRoleSet = useMemo(
    () =>
      new Set(
        Object.keys(draftCounts).filter(r => (draftCounts[r] ?? 0) > 0),
      ),
    [draftCounts],
  );
  const draftBalance = useMemo(() => {
    let total = 0;
    for (const [role, count] of Object.entries(draftCounts)) {
      total += getRoleValue(role) * count;
    }
    return total;
  }, [draftCounts]);

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
  if (lobby.me === null && !leftIntentionallyRef.current) {
    handleLeaveRef.current = () => navigation.popToTop();
    return (
      <SafeAreaView className="flex-1 bg-wolf-bg items-center justify-center px-8">
        <Text className="text-wolf-text text-lg text-center mb-3">
          The host removed you from this game.
        </Text>
        <Text className="text-wolf-muted text-center mb-6">
          You can rejoin with the room code if they invite you back.
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
  const tooManyRoles = game.selectedRoles.length > game.playerCount;
  const tooFewRoles =
    game.selectedRoles.length > 0 && game.selectedRoles.length < game.playerCount;
  // Pre-game parity guard: if starting wolves already reach half the table, the
  // wolves win on N1 before the first kill resolves. Counts the literal wolf
  // roles only (isWolfTeam) — Cursed/Sasquatch/Doppelganger start village-team.
  const wolfCount = game.selectedRoles.filter(isWolfTeam).length;
  const wolfParity = wolfCount * 2 >= game.playerCount;
  const canStart = isHost && allSeated && rolesValid && !wolfParity;

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
      showAlert('Error', e instanceof Error ? e.message : String(e));
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
      showAlert('Error', e instanceof Error ? e.message : String(e));
    }
  }

  function handleDeletePlayer(playerId: Id<'players'>, playerName: string) {
    if (!deviceClientId) return;
    showAlert(
      `Remove ${playerName}?`,
      'They leave the lobby and the table shrinks by one seat. Remaining players shift to close the gap. Roles stay picked — adjust them if the count no longer matches.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            try {
              await removeFromGame({
                gameId: game._id,
                playerId,
                callerDeviceClientId: deviceClientId,
              });
              setSeatModalIndex(null);
            } catch (e) {
              showAlert('Error', e instanceof Error ? e.message : String(e));
            }
          },
        },
      ],
    );
  }

  function handleClearAllSeats() {
    if (!deviceClientId) return;
    showAlert(
      'Clear all seats?',
      'Every player will be unseated. Roles stay picked.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: async () => {
            try {
              await clearAllSeats({
                gameId: game._id,
                callerDeviceClientId: deviceClientId,
              });
            } catch (e) {
              showAlert('Error', e instanceof Error ? e.message : String(e));
            }
          },
        },
      ],
    );
  }

  async function changePlayerCount(delta: number) {
    if (!deviceClientId) return;
    const next = game.playerCount + delta;
    if (next < MIN_PLAYER_COUNT || next > MAX_PLAYER_COUNT) return;
    try {
      await setPlayerCount({
        gameId: game._id,
        playerCount: next,
        callerDeviceClientId: deviceClientId,
      });
    } catch (e) {
      showAlert('Error', e instanceof Error ? e.message : String(e));
    }
  }

  function openRoleModal() {
    const counts: Record<string, number> = {};
    for (const r of game.selectedRoles) counts[r] = (counts[r] ?? 0) + 1;
    setDraftCounts(counts);
    setRoleFilter('villagers');
    setRolesModalOpen(true);
    // The pager retains its scroll offset across opens; rewind to page 0.
    setTimeout(() => rolesPagerRef.current?.scrollTo({ x: 0, animated: false }), 0);
  }

  function selectRoleTab(key: RoleCategory) {
    setRoleFilter(key);
    const idx = CATEGORIES.findIndex(c => c.key === key);
    if (idx >= 0) {
      rolesPagerRef.current?.scrollTo({ x: idx * rolesPagerWidth, animated: true });
    }
  }

  function increment(role: string) {
    if (draftTotal >= game.playerCount) return;
    if (isSingletonRole(role) && (draftCounts[role] ?? 0) >= 1) return;
    // Hard-excluded role pair already in the build — block (defensive; the +
    // button is also disabled in the picker row below).
    if (incompatibleRolesInBuild(role, draftedRoleSet).length > 0) return;
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
      showAlert('Error', e instanceof Error ? e.message : String(e));
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
      showAlert('Error', e instanceof Error ? e.message : String(e));
    }
  }

  // Dev pin write. `role === null` clears the seat's pin; otherwise replaces
  // it. We compute the full next pin list locally and send it (the mutation
  // uses replace semantics, so build → send is the whole contract).
  async function applyDevPin(seatPosition: number, role: string | null) {
    if (!deviceClientId) return;
    const current = game.devRoleAssignments ?? [];
    const next = current.filter(p => p.seatPosition !== seatPosition);
    if (role !== null) next.push({ seatPosition, role });
    try {
      await setDevRoleAssignments({
        gameId: game._id,
        assignments: next,
        callerDeviceClientId: deviceClientId,
      });
    } catch (e) {
      showAlert('Error', e instanceof Error ? e.message : String(e));
    }
  }

  async function clearAllDevPins() {
    if (!deviceClientId) return;
    try {
      await setDevRoleAssignments({
        gameId: game._id,
        assignments: [],
        callerDeviceClientId: deviceClientId,
      });
    } catch (e) {
      showAlert('Error', e instanceof Error ? e.message : String(e));
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
      showAlert('Cannot start game', e instanceof Error ? e.message : String(e));
    }
  }

  function handleLeave() {
    showAlert(
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
            leftIntentionallyRef.current = true;
            try {
              await leaveGame({
                gameId: game._id,
                callerDeviceClientId: deviceClientId,
              });
              navigation.popToTop();
            } catch (e) {
              leftIntentionallyRef.current = false;
              showAlert('Error', e instanceof Error ? e.message : String(e));
            }
          },
        },
      ],
    );
  }
  handleLeaveRef.current = handleLeave;

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
          {isHost ? (
            <View
              className="flex-row items-center mt-2"
              style={{ gap: 12 }}
            >
              <TouchableOpacity
                onPress={() => changePlayerCount(-1)}
                disabled={
                  game.playerCount <= MIN_PLAYER_COUNT ||
                  game.playerCount <= players.length
                }
                style={{
                  opacity:
                    game.playerCount <= MIN_PLAYER_COUNT ||
                    game.playerCount <= players.length
                      ? 0.3
                      : 1,
                }}
                className="w-7 h-7 bg-wolf-card rounded-full items-center justify-center"
              >
                <Text className="text-wolf-text text-base">−</Text>
              </TouchableOpacity>
              <Text className="text-wolf-muted text-xs tracking-widest">
                {players.length} / {game.playerCount} JOINED
              </Text>
              <TouchableOpacity
                onPress={() => changePlayerCount(1)}
                disabled={game.playerCount >= MAX_PLAYER_COUNT}
                style={{
                  opacity: game.playerCount >= MAX_PLAYER_COUNT ? 0.3 : 1,
                }}
                className="w-7 h-7 bg-wolf-card rounded-full items-center justify-center"
              >
                <Text className="text-wolf-text text-base">+</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <Text className="text-wolf-muted text-xs tracking-widest mt-2">
              {players.length} / {game.playerCount} JOINED
            </Text>
          )}
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

        {isHost && seatedByPosition.size > 0 && (
          <View className="items-center mt-4">
            <TouchableOpacity
              onPress={handleClearAllSeats}
              activeOpacity={0.6}
              className="px-3 py-1.5"
            >
              <Text className="text-wolf-red text-xs font-bold tracking-widest">
                CLEAR ALL SEATS
              </Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Unseated players */}
        {unseatedPlayers.length > 0 && (
          <View className="px-6 mt-6">
            <Text className="text-wolf-muted text-xs font-bold tracking-widest mb-2">
              {isHost ? 'WAITING FOR SEAT' : 'JOINED'}
            </Text>
            <View className="flex-row flex-wrap" style={{ gap: 8 }}>
              {unseatedPlayers.map(p => {
                const canDelete = isHost && !p.isHost;
                return (
                  <TouchableOpacity
                    key={p._id}
                    disabled={!canDelete}
                    activeOpacity={canDelete ? 0.6 : 1}
                    onPress={
                      canDelete
                        ? () => handleDeletePlayer(p._id, p.name)
                        : undefined
                    }
                    className="bg-wolf-card rounded-full px-3 py-1.5"
                  >
                    <Text className="text-wolf-text text-sm">
                      {p.name}
                      {p.isHost ? ' (host)' : ''}
                      {canDelete ? '  ×' : ''}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        )}

        {/* Roles section */}
        <View className="px-6 mt-6">
          <View className="flex-row items-center justify-between mb-2">
            <View className="flex-row items-center" style={{ gap: 8 }}>
              <Text className="text-wolf-muted text-xs font-bold tracking-widest">
                ROLES ({game.selectedRoles.length} / {game.playerCount})
              </Text>
              {tooManyRoles && (
                <Text className="text-wolf-red text-xs font-bold tracking-widest">
                  TOO MANY
                </Text>
              )}
              {tooFewRoles && (
                <Text className="text-wolf-accent text-xs font-bold tracking-widest">
                  NEED MORE
                </Text>
              )}
              {!tooManyRoles && !tooFewRoles && wolfParity && (
                <Text className="text-wolf-red text-xs font-bold tracking-widest">
                  WOLF PARITY
                </Text>
              )}
            </View>
            <TouchableOpacity
              onPress={() => setBrowseRolesOpen(true)}
              hitSlop={8}
              activeOpacity={0.6}
            >
              <Text className="text-wolf-accent text-xs font-bold tracking-widest">
                BROWSE ALL ›
              </Text>
            </TouchableOpacity>
          </View>
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
              {game.selectedRoles.length > 0 && <BalanceLine roles={game.selectedRoles} />}
            </TouchableOpacity>
          ) : (
            <View className="bg-wolf-card rounded-xl px-4 py-4">
              <Text className="text-wolf-text text-sm">
                {game.selectedRoles.length === 0
                  ? 'Host is picking roles…'
                  : formatRoleSummary(game.selectedRoles)}
              </Text>
              {game.selectedRoles.length > 0 && <BalanceLine roles={game.selectedRoles} />}
            </View>
          )}
        </View>

        {/* Settings section */}
        <View className="px-6 mt-6">
          <Text className="text-wolf-muted text-xs font-bold tracking-widest mb-2">
            SETTINGS
          </Text>
          {isHost ? (
            <TouchableOpacity
              onPress={() => setTimersModalOpen(true)}
              className="bg-wolf-card rounded-xl px-4 py-4"
              activeOpacity={0.75}
            >
              <Text className="text-wolf-text text-sm">
                {Math.floor(game.dayDurationSec / 60)}:
                {(game.dayDurationSec % 60).toString().padStart(2, '0')} day ·{' '}
                {game.accusationSec}s acc · {game.defenseSec}s def ·{' '}
                {game.voteTimerSec}s vote · {game.maxNominationsPerDay} noms
              </Text>
            </TouchableOpacity>
          ) : (
            <View className="bg-wolf-card rounded-xl px-4 py-4">
              <Text className="text-wolf-text text-sm">
                {Math.floor(game.dayDurationSec / 60)}:
                {(game.dayDurationSec % 60).toString().padStart(2, '0')} day ·{' '}
                {game.accusationSec}s acc · {game.defenseSec}s def ·{' '}
                {game.voteTimerSec}s vote · {game.maxNominationsPerDay} noms
              </Text>
            </View>
          )}
        </View>

        {/* Visible in local dev (__DEV__) or playtest builds that opt in via
            EXPO_PUBLIC_ALLOW_BOTS, and only while the host's Developer mode
            toggle (Settings) is on. Unset that EAS env var before real release. */}
        {showDevTools &&
          isHost &&
          players.length < game.playerCount && (
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

        {showDevTools &&
          isHost &&
          game.selectedRoles.length > 0 && (
          <View className="px-6 mt-3">
            <TouchableOpacity
              onPress={() => setDevAssignOpen(true)}
              activeOpacity={0.75}
              className="bg-wolf-card border border-wolf-accent rounded-xl py-3 items-center"
            >
              <Text className="text-wolf-accent text-xs font-bold tracking-widest">
                ASSIGN ROLES (DEV)
                {(game.devRoleAssignments?.length ?? 0) > 0
                  ? ` · ${game.devRoleAssignments?.length} PINNED`
                  : ''}
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
                  : tooManyRoles
                    ? `Too many roles — remove ${game.selectedRoles.length - game.playerCount} or add seats.`
                    : tooFewRoles
                      ? `Need ${game.playerCount - game.selectedRoles.length} more role${game.playerCount - game.selectedRoles.length === 1 ? '' : 's'}.`
                      : !rolesValid
                        ? `Pick ${game.playerCount} roles.`
                        : wolfParity
                          ? `Too many wolves — wolves must be less than half the table (max ${Math.ceil(game.playerCount / 2) - 1} for ${game.playerCount} players).`
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
                  className="bg-wolf-card rounded-xl py-3 mb-2"
                >
                  <Text className="text-wolf-text text-center font-bold">
                    Remove from seat
                  </Text>
                </TouchableOpacity>
                {!seatModalOccupant.isHost && (
                  <TouchableOpacity
                    onPress={() =>
                      handleDeletePlayer(
                        seatModalOccupant._id,
                        seatModalOccupant.name,
                      )
                    }
                    className="bg-wolf-card rounded-xl py-3"
                  >
                    <Text className="text-wolf-red text-center font-bold">
                      Remove from game
                    </Text>
                  </TouchableOpacity>
                )}
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
              <View className="flex-1 items-center">
                <Text className="text-wolf-text text-base font-bold">
                  Roles ({draftTotal} / {game.playerCount})
                </Text>
                <Text
                  style={{
                    color:
                      draftBalance > 0
                        ? '#4caf50'
                        : draftBalance < 0
                          ? '#ef5350'
                          : '#8A8590',
                    fontSize: 12,
                    fontWeight: '600',
                    marginTop: 2,
                  }}
                >
                  Balance: {draftBalance > 0 ? `+${draftBalance}` : draftBalance}
                </Text>
              </View>
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
                    onPress={() => selectRoleTab(tab.key)}
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
            <View
              style={{ flex: 1 }}
              onLayout={e => {
                const w = e.nativeEvent.layout.width;
                if (w > 0 && w !== rolesPagerWidth) {
                  setRolesPagerWidth(w);
                  // Re-anchor the pager to the current tab after a width change.
                  const idx = CATEGORIES.findIndex(c => c.key === roleFilter);
                  if (idx >= 0) {
                    requestAnimationFrame(() =>
                      rolesPagerRef.current?.scrollTo({ x: idx * w, animated: false }),
                    );
                  }
                }
              }}
            >
              <ScrollView
                ref={rolesPagerRef}
                horizontal
                pagingEnabled
                showsHorizontalScrollIndicator={false}
                onMomentumScrollEnd={e => {
                  const idx = Math.round(
                    e.nativeEvent.contentOffset.x / rolesPagerWidth,
                  );
                  const next = CATEGORIES[idx];
                  if (next && next.key !== roleFilter) setRoleFilter(next.key);
                }}
              >
                {CATEGORIES.map(cat => {
                  const filtered = V1_ROLES.filter(
                    role => V1_ROLE_CATEGORY_MAP.get(role) === cat.key,
                  ).sort((a, b) => roleSortKey(a).localeCompare(roleSortKey(b)));
                  return (
                    <ScrollView
                      key={cat.key}
                      style={{ width: rolesPagerWidth }}
                      contentContainerStyle={{
                        paddingHorizontal: 24,
                        paddingTop: 16,
                        paddingBottom: 16 + insets.bottom,
                      }}
                    >
                      {filtered.length === 0 ? (
                        <View className="py-10 items-center">
                          <Text className="text-wolf-muted text-sm text-center">
                            No roles in this team yet.
                          </Text>
                        </View>
                      ) : (
                        filtered.map(role => {
                          const count = draftCounts[role] ?? 0;
                          const atSingletonCap = isSingletonRole(role) && count >= 1;
                          // Hard-excluded pairing already drafted (e.g. Witch
                          // or Leprechaun when Alpha Wolf is in, or vice versa).
                          const conflicts = incompatibleRolesInBuild(
                            role,
                            draftedRoleSet,
                          );
                          const blockedByConflict = count === 0 && conflicts.length > 0;
                          const canIncrement =
                            draftTotal < game.playerCount &&
                            !atSingletonCap &&
                            !blockedByConflict;
                          const val = getRoleValue(role);
                          const bg =
                            val > 0 ? '#1a4a1a' : val < 0 ? '#4a1a1a' : '#2a2a2a';
                          const color =
                            val > 0 ? '#4caf50' : val < 0 ? '#ef5350' : '#8A8590';
                          return (
                            <View
                              key={role}
                              className="flex-row items-center py-3 border-b border-wolf-card"
                            >
                              <View className="flex-1 pr-2">
                                <Text className="text-wolf-text text-base">
                                  {role}
                                </Text>
                                {blockedByConflict && (
                                  <Text className="text-wolf-red text-xs mt-0.5">
                                    Can't combine with {conflicts.join(' or ')}
                                  </Text>
                                )}
                              </View>
                              <View
                                style={{
                                  backgroundColor: bg,
                                  borderRadius: 4,
                                  paddingHorizontal: 6,
                                  paddingVertical: 2,
                                  marginRight: 12,
                                }}
                              >
                                <Text style={{ color, fontSize: 12, fontWeight: '700' }}>
                                  {val > 0 ? `+${val}` : `${val}`}
                                </Text>
                              </View>
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
                        })
                      )}
                    </ScrollView>
                  );
                })}
              </ScrollView>
            </View>
          </View>
        </View>
      </Modal>

      {/* Browse-all-roles modal. Available to host and players while waiting
          in the lobby. When the host starts the game, LobbyScreen unmounts
          via the phase-change effect above and this modal closes with it. */}
      <RolesBrowserModal
        visible={browseRolesOpen}
        onClose={() => setBrowseRolesOpen(false)}
      />

      {/* Dev: pin seats to specific roles before starting. Outer modal lists
          every seat; tapping a seat opens an inline picker. Pin writes are
          immediate (no draft state). Hidden in release builds via the
          `__DEV__ || EXPO_PUBLIC_ALLOW_BOTS` gate on the open button. */}
      <Modal
        visible={devAssignOpen}
        transparent
        animationType="slide"
        onRequestClose={() => {
          setDevAssignOpen(false);
          setDevPickerSeat(null);
        }}
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
              <TouchableOpacity
                onPress={() => {
                  setDevAssignOpen(false);
                  setDevPickerSeat(null);
                }}
                className="w-16"
              >
                <Text className="text-wolf-text">Done</Text>
              </TouchableOpacity>
              <Text className="flex-1 text-wolf-text text-base font-bold text-center">
                Assign Roles (DEV)
              </Text>
              <View className="w-16 items-end">
                {(game.devRoleAssignments?.length ?? 0) > 0 && (
                  <TouchableOpacity onPress={clearAllDevPins}>
                    <Text className="text-wolf-red text-xs font-bold tracking-widest">
                      CLEAR
                    </Text>
                  </TouchableOpacity>
                )}
              </View>
            </View>
            <Text className="text-wolf-muted text-xs text-center px-6 pt-3">
              Pinned seats get the chosen role on START. Unpinned seats get the
              rest randomly.
            </Text>
            <ScrollView
              contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
            >
              {(() => {
                const pinBySeat = new Map<number, string>();
                for (const p of game.devRoleAssignments ?? []) {
                  pinBySeat.set(p.seatPosition, p.role);
                }
                const rows: React.ReactElement[] = [];
                for (let seat = 0; seat < game.playerCount; seat++) {
                  const occupant = seatedByPosition.get(seat);
                  const pinned = pinBySeat.get(seat);
                  rows.push(
                    <TouchableOpacity
                      key={seat}
                      onPress={() => setDevPickerSeat(seat)}
                      activeOpacity={0.75}
                      className="bg-wolf-card rounded-xl px-4 py-3 mb-2 flex-row items-center"
                    >
                      <View className="flex-1">
                        <Text className="text-wolf-text text-sm font-bold">
                          Seat {seat + 1}
                          {occupant ? ` · ${occupant.name}` : ' · (empty)'}
                        </Text>
                      </View>
                      <View
                        className="rounded-full px-3 py-1"
                        style={{
                          backgroundColor: pinned ? '#D4A017' : '#2A2A38',
                        }}
                      >
                        <Text
                          className="text-xs font-bold tracking-widest"
                          style={{ color: pinned ? '#0F0F14' : '#8A8590' }}
                        >
                          {pinned ?? 'RANDOM'}
                        </Text>
                      </View>
                    </TouchableOpacity>,
                  );
                }
                return rows;
              })()}
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* Dev: inline role picker for one seat. Sits above the assign modal so
          tapping a seat row routes here, makes a pick, and bounces back. */}
      <Modal
        visible={devPickerSeat !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setDevPickerSeat(null)}
      >
        <Pressable
          onPress={() => setDevPickerSeat(null)}
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
            {devPickerSeat !== null &&
              (() => {
                const totalByRole = new Map<string, number>();
                for (const r of game.selectedRoles) {
                  totalByRole.set(r, (totalByRole.get(r) ?? 0) + 1);
                }
                const usedByRole = new Map<string, number>();
                for (const p of game.devRoleAssignments ?? []) {
                  if (p.seatPosition === devPickerSeat) continue;
                  usedByRole.set(p.role, (usedByRole.get(p.role) ?? 0) + 1);
                }
                const uniqueRoles: string[] = [];
                const seen = new Set<string>();
                for (const r of game.selectedRoles) {
                  if (!seen.has(r)) {
                    seen.add(r);
                    uniqueRoles.push(r);
                  }
                }
                uniqueRoles.sort();
                const currentPin = (game.devRoleAssignments ?? []).find(
                  p => p.seatPosition === devPickerSeat,
                )?.role;
                const occupant = seatedByPosition.get(devPickerSeat);
                return (
                  <>
                    <Text className="text-wolf-text text-lg font-bold mb-1 text-center">
                      Seat {devPickerSeat + 1}
                    </Text>
                    <Text className="text-wolf-muted text-xs text-center mb-4">
                      {occupant ? occupant.name : '(empty seat)'}
                    </Text>
                    <ScrollView style={{ maxHeight: 360 }}>
                      <TouchableOpacity
                        onPress={async () => {
                          const seat = devPickerSeat;
                          setDevPickerSeat(null);
                          if (seat !== null) await applyDevPin(seat, null);
                        }}
                        className="bg-wolf-card rounded-xl py-3 mb-2"
                      >
                        <Text
                          className="text-center font-bold tracking-widest"
                          style={{
                            color: currentPin === undefined ? '#D4A017' : '#F0EDE8',
                          }}
                        >
                          RANDOM
                          {currentPin === undefined ? '  ✓' : ''}
                        </Text>
                      </TouchableOpacity>
                      {uniqueRoles.map(role => {
                        const total = totalByRole.get(role) ?? 0;
                        const used = usedByRole.get(role) ?? 0;
                        const remaining = total - used;
                        const isSelected = currentPin === role;
                        const disabled = remaining <= 0 && !isSelected;
                        return (
                          <TouchableOpacity
                            key={role}
                            disabled={disabled}
                            onPress={async () => {
                              const seat = devPickerSeat;
                              setDevPickerSeat(null);
                              if (seat !== null) await applyDevPin(seat, role);
                            }}
                            className="bg-wolf-card rounded-xl px-4 py-3 mb-2 flex-row items-center"
                            style={{ opacity: disabled ? 0.35 : 1 }}
                          >
                            <Text
                              className="flex-1 text-wolf-text font-bold"
                              style={{
                                color: isSelected ? '#D4A017' : '#F0EDE8',
                              }}
                            >
                              {role}
                              {isSelected ? '  ✓' : ''}
                            </Text>
                            <Text className="text-wolf-muted text-xs tracking-widest">
                              {remaining} / {total} LEFT
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </ScrollView>
                    <TouchableOpacity
                      onPress={() => setDevPickerSeat(null)}
                      className="mt-3 py-2"
                    >
                      <Text className="text-wolf-muted text-center">Cancel</Text>
                    </TouchableOpacity>
                  </>
                );
              })()}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Timers config modal (host only). Sets day-phase clocks and the
          nomination budget. Mutation rejects non-host callers, so we still
          guard against opening for non-hosts above. */}
      {deviceClientId && (
        <TimersConfigModal
          visible={timersModalOpen}
          onClose={() => setTimersModalOpen(false)}
          gameId={game._id}
          deviceClientId={deviceClientId}
          initial={{
            dayDurationSec: game.dayDurationSec,
            accusationSec: game.accusationSec,
            defenseSec: game.defenseSec,
            voteTimerSec: game.voteTimerSec,
            preVoteSec: game.preVoteSec,
            maxNominationsPerDay: game.maxNominationsPerDay,
            wolfPickerSec: game.wolfPickerSec,
            nightActionSec: game.nightActionSec,
          }}
          passHostCandidates={
            isHost
              ? players
                  .filter(
                    p =>
                      p._id !== me?._id && !/^Bot \d+$/.test(p.name),
                  )
                  .map(p => ({ _id: p._id, name: p.name }))
              : undefined
          }
          roomCode={game.roomCode}
        />
      )}
    </SafeAreaView>
  );
}
