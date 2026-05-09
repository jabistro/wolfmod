import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  SafeAreaView,
  ScrollView,
  ActivityIndicator,
} from 'react-native';
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

export default function EndGameScreen() {
  const navigation = useNavigation<Nav>();
  const { params } = useRoute<Route>();
  const deviceClientId = useDeviceId();

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
            return (
              <View
                key={p._id}
                className="bg-wolf-card rounded-xl px-4 py-3 flex-row items-center"
                style={{
                  borderWidth: p.isMe ? 2 : 1,
                  borderColor: p.isMe ? '#D4A017' : '#2A2A38',
                }}
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
              </View>
            );
          })}
        </View>
      </ScrollView>

      <View className="px-6 pb-8">
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
