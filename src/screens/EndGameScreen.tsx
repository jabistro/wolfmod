import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  SafeAreaView,
  ScrollView,
  ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { StackNavigationProp } from '@react-navigation/stack';
import { useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import type { RootStackParamList } from '../navigation/types';
import { useDeviceId } from '../hooks/useDeviceId';
import { teamForRole, type Team } from '../data/v1Roles';
import { SeatingCircle } from '../components/SeatingCircle';
import { useAndroidBack } from '../hooks/useAndroidBack';

type Nav = StackNavigationProp<RootStackParamList, 'EndGame'>;
type Route = RouteProp<RootStackParamList, 'EndGame'>;

const TEAM_COLORS: Record<Team, string> = {
  village: '#4A90D9',
  wolf: '#8B1818',
  solo: '#8B6436',
};

// Wolf-aligned roles that aren't actual wolves get the "Team Wolf" hue used
// in the Roles browser, distinct from the deep red of true wolves.
const TEAM_WOLF_COLOR = '#C05050';
const TEAMWOLF_ROLES = new Set<string>(['Minion', 'Reviler']);

function pillColorFor(role: string | null, team: Team | null): string {
  if (role && TEAMWOLF_ROLES.has(role)) return TEAM_WOLF_COLOR;
  if (team) return TEAM_COLORS[team];
  return '#3A3A48';
}

type HistoryEntry = {
  nightNumber: number;
  kind: string;
  targetName: string | null;
  secondTargetName: string | null;
  team: string | null;
  sameTeam: string | null;
  outcome: string | null;
  victimNames: string[] | null;
};

function renderEntryBody(entry: HistoryEntry): React.ReactNode {
  const t = entry.targetName ?? '—';
  switch (entry.kind) {
    case 'wolf_kill': {
      const label =
        entry.outcome === 'killed'
          ? 'KILLED'
          : entry.outcome === 'delayed'
            ? 'DEATH DELAYED'
            : entry.outcome === 'converted'
              ? 'CONVERTED'
              : 'SAVED';
      const color =
        entry.outcome === 'killed'
          ? '#B03A2E'
          : entry.outcome === 'delayed'
            ? '#E0A030'
            : entry.outcome === 'converted'
              ? '#D4A017'
              : '#5BA0E5';
      const redirected =
        entry.secondTargetName != null && entry.secondTargetName !== t;
      return (
        <Text className="text-wolf-text text-sm">
          Targeted {t}
          {redirected ? (
            <>
              {' '}
              →{' '}
              <Text className="font-bold" style={{ color: '#5BA0E5' }}>
                {entry.secondTargetName}
              </Text>
            </>
          ) : null}{' '}
          —{' '}
          <Text className="font-bold" style={{ color }}>
            {label}
          </Text>
        </Text>
      );
    }
    case 'seer_check':
      return (
        <Text className="text-wolf-text text-sm">
          Checked {t} —{' '}
          <Text
            className="font-bold"
            style={{ color: entry.team === 'wolf' ? '#B03A2E' : '#5BA0E5' }}
          >
            {entry.team === 'wolf' ? 'WOLF' : 'VILLAGER'}
          </Text>
        </Text>
      );
    case 'pi_check':
      return (
        <Text className="text-wolf-text text-sm">
          Investigated {t} —{' '}
          <Text
            className="font-bold"
            style={{ color: entry.team === 'wolf' ? '#B03A2E' : '#5BA0E5' }}
          >
            {entry.team === 'wolf' ? 'WOLF' : 'VILLAGER'}
          </Text>
        </Text>
      );
    case 'pi_skip':
      return <Text className="text-wolf-muted text-sm italic">Passed</Text>;
    case 'mentalist_check': {
      const second = entry.secondTargetName ?? '—';
      return (
        <Text className="text-wolf-text text-sm">
          Compared {t} &amp; {second} —{' '}
          <Text
            className="font-bold"
            style={{
              color: entry.sameTeam === 'same' ? '#5BA0E5' : '#E07070',
            }}
          >
            {entry.sameTeam === 'same' ? 'SAME' : 'DIFFERENT'}
          </Text>
        </Text>
      );
    }
    case 'mentalist_skip':
      return <Text className="text-wolf-muted text-sm italic">Passed</Text>;
    case 'bg_protect':
      if (entry.outcome === 'saved') {
        return (
          <Text className="text-wolf-text text-sm">
            Protected {t} —{' '}
            <Text className="font-bold" style={{ color: '#5BA0E5' }}>
              SAVED
            </Text>
          </Text>
        );
      }
      return <Text className="text-wolf-text text-sm">Protected {t}</Text>;
    case 'witch_save':
      return (
        <Text className="text-wolf-text text-sm">
          {t} —{' '}
          <Text className="font-bold" style={{ color: '#5BA0E5' }}>
            SAVED
          </Text>
        </Text>
      );
    case 'witch_poison':
      return (
        <Text className="text-wolf-text text-sm">
          {t} —{' '}
          <Text className="font-bold" style={{ color: '#B03A2E' }}>
            POISONED
          </Text>
        </Text>
      );
    case 'witch_done':
      return <Text className="text-wolf-muted text-sm italic">Passed</Text>;
    case 'leprechaun_redirect': {
      if (entry.outcome === 'blocked') {
        return (
          <Text className="text-wolf-text text-sm">
            Wolves had no kill —{' '}
            <Text className="font-bold" style={{ color: '#E0A030' }}>
              ACKNOWLEDGED
            </Text>
          </Text>
        );
      }
      if (entry.outcome === 'leave') {
        return (
          <Text className="text-wolf-text text-sm">Left the kill on {t}</Text>
        );
      }
      const dest = entry.secondTargetName ?? '—';
      return (
        <Text className="text-wolf-text text-sm">
          Moved kill from {t} →{' '}
          <Text className="font-bold" style={{ color: '#5BA0E5' }}>
            {dest}
          </Text>
        </Text>
      );
    }
    case 'huntress_shot':
      return (
        <Text className="text-wolf-text text-sm">
          Shot {t} —{' '}
          <Text
            className="font-bold"
            style={{ color: entry.outcome === 'killed' ? '#B03A2E' : '#5BA0E5' }}
          >
            {entry.outcome === 'killed' ? 'KILLED' : 'SAVED'}
          </Text>
        </Text>
      );
    case 'huntress_skip':
      return <Text className="text-wolf-muted text-sm italic">Passed</Text>;
    case 'revealer_shot': {
      const label =
        entry.outcome === 'killed'
          ? 'KILLED'
          : entry.outcome === 'missed'
            ? 'MISSED'
            : 'SAVED';
      const color =
        entry.outcome === 'killed'
          ? '#B03A2E'
          : entry.outcome === 'missed'
            ? '#E0A030'
            : '#5BA0E5';
      return (
        <Text className="text-wolf-text text-sm">
          Shot {t} —{' '}
          <Text className="font-bold" style={{ color }}>
            {label}
          </Text>
        </Text>
      );
    }
    case 'revealer_skip':
      return <Text className="text-wolf-muted text-sm italic">Passed</Text>;
    case 'reviler_shot': {
      const label =
        entry.outcome === 'killed'
          ? 'KILLED'
          : entry.outcome === 'missed'
            ? 'MISSED'
            : 'SAVED';
      const color =
        entry.outcome === 'killed'
          ? '#B03A2E'
          : entry.outcome === 'missed'
            ? '#E0A030'
            : '#5BA0E5';
      return (
        <Text className="text-wolf-text text-sm">
          Reviled {t} —{' '}
          <Text className="font-bold" style={{ color }}>
            {label}
          </Text>
        </Text>
      );
    }
    case 'reviler_skip':
      return <Text className="text-wolf-muted text-sm italic">Passed</Text>;
    case 'tough_guy_wounded':
      return (
        <Text className="text-wolf-text text-sm">
          Attacked by wolves —{' '}
          <Text className="font-bold" style={{ color: '#E0A030' }}>
            DEATH DELAYED
          </Text>
        </Text>
      );
    case 'wolf_blocked':
      return (
        <Text className="text-wolf-text text-sm">
          Diseased blood —{' '}
          <Text className="font-bold" style={{ color: '#E0A030' }}>
            NO KILL
          </Text>
        </Text>
      );
    case 'hunter_shot':
    case 'hunter_wolf_shot': {
      const color = entry.outcome === 'killed' ? '#B03A2E' : '#E0A030';
      const label = entry.outcome === 'killed' ? 'KILLED' : 'MISSED';
      return (
        <Text className="text-wolf-text text-sm">
          Shot {t} —{' '}
          <Text className="font-bold" style={{ color }}>
            {label}
          </Text>
        </Text>
      );
    }
    case 'hunter_skip':
    case 'hunter_wolf_skip':
      return <Text className="text-wolf-muted text-sm italic">Held fire</Text>;
    case 'mad_bomber_kill': {
      const victims = entry.victimNames ?? [];
      if (victims.length === 0) {
        return (
          <Text className="text-wolf-text text-sm">
            Detonation —{' '}
            <Text className="font-bold" style={{ color: '#E0A030' }}>
              NO VICTIMS
            </Text>
          </Text>
        );
      }
      return (
        <Text className="text-wolf-text text-sm">
          Detonated —{' '}
          <Text className="font-bold" style={{ color: '#B03A2E' }}>
            {victims.join(', ')}
          </Text>
        </Text>
      );
    }
    case 'doppelganger_conversion': {
      // outcome carries the inherited role name (set in endGameView).
      const newRole = entry.outcome ?? '—';
      return (
        <Text className="text-wolf-text text-sm">
          Doppelganged {t} —{' '}
          <Text className="font-bold" style={{ color: '#D4A017' }}>
            {newRole.toUpperCase()}
          </Text>
        </Text>
      );
    }
    case 'doppelganger_conversion_reveal':
      return (
        <Text className="font-bold text-sm" style={{ color: '#D4A017' }}>
          CONVERSION
        </Text>
      );
    case 'nightmare_put_to_sleep':
      return (
        <Text className="text-wolf-text text-sm">
          Targeted {t} —{' '}
          <Text className="font-bold" style={{ color: '#B68AD9' }}>
            NIGHTMARED
          </Text>
        </Text>
      );
    case 'nightmare_blocked':
      return (
        <Text className="font-bold text-sm" style={{ color: '#B68AD9' }}>
          NIGHTMARED
        </Text>
      );
    default:
      return <Text className="text-wolf-muted text-sm">{entry.kind}</Text>;
  }
}

export default function EndGameScreen() {
  const navigation = useNavigation<Nav>();
  const { params } = useRoute<Route>();
  const deviceClientId = useDeviceId();
  const insets = useSafeAreaInsets();
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const toggleExpanded = (id: string) =>
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const view = useQuery(
    api.games.endGameView,
    deviceClientId
      ? { gameId: params.gameId as Id<'games'>, deviceClientId }
      : 'skip',
  );

  const goHome = React.useCallback(() => {
    navigation.popToTop();
    return true;
  }, [navigation]);
  useAndroidBack(goHome);

  if (!deviceClientId || view === undefined) {
    return (
      <SafeAreaView className="flex-1 bg-wolf-bg items-center justify-center">
        <ActivityIndicator color="#D4A017" />
      </SafeAreaView>
    );
  }
  if (view === null) {
    return (
      <SafeAreaView className="flex-1 bg-wolf-bg items-center justify-center">
        <Text className="text-wolf-muted">Game not found.</Text>
      </SafeAreaView>
    );
  }

  const { game, players } = view;
  const winnerLabel =
    game.winner === 'village'
      ? 'VILLAGE WINS'
      : game.winner === 'wolf'
        ? 'WOLVES WIN'
        : 'GAME OVER';
  const winnerBg =
    game.winner === 'village'
      ? '#1F4E80'
      : game.winner === 'wolf'
        ? '#8B1818'
        : '#22222F';

  return (
    <SafeAreaView className="flex-1 bg-wolf-bg">
      <TouchableOpacity
        onPress={() => navigation.popToTop()}
        hitSlop={8}
        style={{
          position: 'absolute',
          left: 8,
          top: 40,
          padding: 8,
          zIndex: 10,
        }}
      >
        <Text
          style={{
            color: '#8A8590',
            fontSize: 12,
            fontWeight: '700',
            letterSpacing: 2,
          }}
        >
          DONE
        </Text>
      </TouchableOpacity>
      <View className="px-4 pt-10 pb-2 items-center">
        <Text className="text-wolf-muted text-xs tracking-widest">GAME OVER</Text>
      </View>

      <ScrollView contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: 24 }}>
        <View className="items-center mt-2 mb-4">
          <SeatingCircle
            totalSeats={game.playerCount}
            players={players}
            centerOverlay={
              <View
                className="rounded-2xl px-5 py-2"
                style={{ backgroundColor: winnerBg }}
              >
                <Text className="text-wolf-text text-lg font-extrabold tracking-widest text-center">
                  {winnerLabel}
                </Text>
              </View>
            }
          />
        </View>

        <Text className="text-wolf-muted text-xs font-bold tracking-widest mb-2 mt-2">
          ROLES REVEALED
        </Text>
        <View className="gap-y-2">
          {players.map(p => {
            const team = p.role ? teamForRole(p.role) : null;
            const teamColor = pillColorFor(p.role ?? null, team);
            const history = (p.history ?? []) as HistoryEntry[];
            const hasHistory = history.length > 0;
            const isExpanded = expandedIds.has(p._id);
            // A Cursed who never converted ends the game with role === 'Cursed';
            // a converted one has role === 'Werewolf' with originalRole pointing
            // back to 'Cursed' + a conversion night number from the server.
            const wasConverted =
              p.originalRole === 'Cursed' &&
              p.role !== 'Cursed' &&
              p.cursedConvertedAtNight != null;
            // Doppelganger subtitle is just "DOPPELGANGER" — the role pill
            // on the right shows what they became, and the per-night logs
            // (Doppelganged X — ROLE on N0, CONVERSION on the reveal night)
            // tell the full story.
            const startedAsDoppelganger = p.originalRole === 'Doppelganger';
            // Sasquatch flips out of spite on the first day with no lynch —
            // role-patched to Werewolf at the start of that night, same shape
            // as the Cursed flip but driven by table inaction, not a wolf
            // attack.
            const sasquatchFlipped =
              p.originalRole === 'Sasquatch' &&
              p.role !== 'Sasquatch' &&
              p.sasquatchConvertedAtNight != null;
            return (
              <View
                key={p._id}
                className="bg-wolf-card rounded-xl overflow-hidden"
                style={{ borderWidth: 1, borderColor: '#2A2A38' }}
              >
                <TouchableOpacity
                  activeOpacity={hasHistory ? 0.7 : 1}
                  disabled={!hasHistory}
                  onPress={() => toggleExpanded(p._id)}
                  className="px-4 py-3 flex-row items-center"
                >
                  <Text className="text-wolf-muted text-xs w-7">
                    {typeof p.seatPosition === 'number'
                      ? p.seatPosition + 1
                      : '·'}
                  </Text>
                  <View className="flex-1 ml-2">
                    <Text className="text-wolf-text text-base font-semibold">
                      {p.name}
                      {p.isMe && (
                        <Text className="text-wolf-accent text-xs"> (you)</Text>
                      )}
                    </Text>
                    {wasConverted && (
                      <Text className="text-wolf-muted text-xs italic uppercase">
                        Cursed → Werewolf (n{p.cursedConvertedAtNight})
                      </Text>
                    )}
                    {sasquatchFlipped && (
                      <Text className="text-wolf-muted text-xs italic uppercase">
                        Sasquatch → Werewolf (n{p.sasquatchConvertedAtNight})
                      </Text>
                    )}
                    {startedAsDoppelganger && (
                      <Text className="text-wolf-muted text-xs italic uppercase">
                        Doppelganger
                      </Text>
                    )}
                    {!p.alive && (
                      <Text className="text-wolf-muted text-xs italic uppercase">
                        {p.eliminationLabel
                          ? `eliminated ${p.eliminationLabel}`
                          : 'eliminated'}
                      </Text>
                    )}
                  </View>
                  <View
                    className="rounded-full px-3 py-1"
                    style={{ backgroundColor: teamColor }}
                  >
                    <Text
                      numberOfLines={1}
                      className="text-wolf-text text-xs font-bold"
                    >
                      {p.role ?? '—'}
                    </Text>
                  </View>
                  {hasHistory ? (
                    <Text className="text-wolf-muted text-xs ml-2 w-4 text-center">
                      {isExpanded ? '▾' : '▸'}
                    </Text>
                  ) : (
                    // Spacer so caret-less rows align their pill with rows
                    // that DO have a caret. Same total width as the caret
                    // group: ml-2 (8px) + w-4 (16px) = 24px.
                    <View className="ml-2 w-4" />
                  )}
                </TouchableOpacity>
                {hasHistory && isExpanded && (() => {
                  const groups: HistoryEntry[][] = [];
                  for (const entry of history) {
                    const last = groups[groups.length - 1];
                    if (last && last[0].nightNumber === entry.nightNumber) {
                      last.push(entry);
                    } else {
                      groups.push([entry]);
                    }
                  }
                  return (
                    <View
                      style={{
                        borderTopWidth: 1,
                        borderTopColor: '#2A2A38',
                      }}
                    >
                      {groups.map((group, gi) => (
                        <View
                          key={`night-${group[0].nightNumber}-${gi}`}
                          className="px-4 py-3 gap-y-2"
                          style={{
                            backgroundColor: gi % 2 === 0 ? '#1A1A24' : '#20202D',
                          }}
                        >
                          {group.map((entry, i) => (
                            <View
                              key={`${entry.nightNumber}-${entry.kind}-${i}`}
                              className="flex-row"
                            >
                              <Text className="text-wolf-muted text-xs font-bold tracking-widest w-16">
                                N{entry.nightNumber}
                              </Text>
                              <View className="flex-1">{renderEntryBody(entry)}</View>
                            </View>
                          ))}
                        </View>
                      ))}
                    </View>
                  );
                })()}
              </View>
            );
          })}
        </View>
      </ScrollView>

      <View
        style={{
          paddingHorizontal: 24,
          paddingBottom: Math.max(insets.bottom, 16) + 16,
        }}
      >
        <TouchableOpacity
          onPress={() => navigation.popToTop()}
          className="bg-wolf-accent rounded-xl py-5 items-center"
          activeOpacity={0.75}
        >
          <Text className="text-wolf-bg text-lg font-extrabold tracking-widest">
            HOME
          </Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}
