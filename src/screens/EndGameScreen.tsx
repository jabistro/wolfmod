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

type Nav = StackNavigationProp<RootStackParamList, 'EndGame'>;
type Route = RouteProp<RootStackParamList, 'EndGame'>;

const TEAM_COLORS: Record<Team, string> = {
  village: '#4A90D9',
  wolf: '#8B1818',
  solo: '#8B6436',
};

type HistoryEntry = {
  nightNumber: number;
  kind: string;
  targetName: string | null;
  secondTargetName: string | null;
  team: string | null;
  sameTeam: string | null;
  outcome: string | null;
};

function renderEntryBody(entry: HistoryEntry): React.ReactNode {
  const t = entry.targetName ?? '—';
  switch (entry.kind) {
    case 'wolf_kill':
      return (
        <Text className="text-wolf-text text-sm">
          Targeted {t} —{' '}
          <Text
            className="font-bold"
            style={{ color: entry.outcome === 'killed' ? '#B03A2E' : '#5BA0E5' }}
          >
            {entry.outcome === 'killed' ? 'KILLED' : 'SAVED'}
          </Text>
        </Text>
      );
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
      return <Text className="text-wolf-text text-sm">Protected {t}</Text>;
    case 'witch_save':
      return <Text className="text-wolf-text text-sm">Saved {t}</Text>;
    case 'witch_poison':
      return <Text className="text-wolf-text text-sm">Poisoned {t}</Text>;
    case 'witch_done':
      return <Text className="text-wolf-muted text-sm italic">Passed</Text>;
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
      <View className="px-4 pt-10 pb-4 items-center">
        <Text className="text-wolf-muted text-xs tracking-widest">GAME OVER</Text>
        <View
          className="mt-3 rounded-2xl px-8 py-4"
          style={{ backgroundColor: winnerBg }}
        >
          <Text className="text-wolf-text text-2xl font-extrabold tracking-widest">
            {winnerLabel}
          </Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: 24 }}>
        <Text className="text-wolf-muted text-xs font-bold tracking-widest mb-2 mt-2">
          ROLES REVEALED
        </Text>
        <View className="gap-y-2">
          {players.map(p => {
            const team = p.role ? teamForRole(p.role) : null;
            const teamColor = team ? TEAM_COLORS[team] : '#3A3A48';
            const history = (p.history ?? []) as HistoryEntry[];
            const hasHistory = history.length > 0;
            const isExpanded = expandedIds.has(p._id);
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
                    {!p.alive && (
                      <Text className="text-wolf-muted text-xs italic">
                        eliminated
                      </Text>
                    )}
                  </View>
                  <View
                    className="rounded-full px-3 py-1"
                    style={{ backgroundColor: teamColor }}
                  >
                    <Text className="text-wolf-text text-xs font-bold">
                      {p.role ?? '—'}
                    </Text>
                  </View>
                  {hasHistory && (
                    <Text className="text-wolf-muted text-xs ml-2 w-4 text-center">
                      {isExpanded ? '▾' : '▸'}
                    </Text>
                  )}
                </TouchableOpacity>
                {hasHistory && isExpanded && (
                  <View
                    className="px-4 py-3 gap-y-2"
                    style={{
                      borderTopWidth: 1,
                      borderTopColor: '#2A2A38',
                      backgroundColor: '#1A1A24',
                    }}
                  >
                    {history.map((entry, i) => (
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
                )}
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
