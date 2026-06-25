import React from 'react';
import { View, Text, TouchableOpacity, TextInput, Switch } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { StackNavigationProp } from '@react-navigation/stack';
import type { RootStackParamList } from '../navigation/types';
import { usePlayerName } from '../contexts/PlayerNameContext';
import { useDevMode } from '../contexts/DevModeContext';
import { useRoleReveal } from '../contexts/RoleRevealContext';
import { DEV_FEATURES_AVAILABLE } from '../config/devFlags';

type NavProp = StackNavigationProp<RootStackParamList, 'Settings'>;

type Row = {
  label: string;
  onPress?: () => void;
  enabled: boolean;
};

export default function SettingsScreen() {
  const navigation = useNavigation<NavProp>();
  const { playerName, setPlayerName } = usePlayerName();
  const { devModeEnabled, setDevModeEnabled } = useDevMode();
  const {
    revealOnLynch,
    setRevealOnLynch,
    revealOnNightDeath,
    setRevealOnNightDeath,
  } = useRoleReveal();

  const rows: Row[] = [
    { label: 'THEMES', onPress: () => navigation.navigate('Themes'), enabled: true },
    { label: 'TIMERS', onPress: () => navigation.navigate('TimerDefaults'), enabled: true },
  ];

  return (
    <SafeAreaView className="flex-1 bg-wolf-bg">
      <View className="flex-1 px-6 pt-6 pb-12">
        <View className="flex-row items-center mb-8">
          <TouchableOpacity onPress={() => navigation.goBack()} className="py-2 pr-4">
            <Text className="text-wolf-text text-base">‹ Back</Text>
          </TouchableOpacity>
          <Text className="text-wolf-text text-2xl font-bold tracking-widest flex-1 text-center mr-16">
            SETTINGS
          </Text>
        </View>

        <View style={{ gap: 8 }} className="mb-2">
          <Text className="text-wolf-muted text-xs font-bold tracking-widest">YOUR NAME</Text>
          <TextInput
            value={playerName}
            onChangeText={setPlayerName}
            placeholder="Enter your name"
            placeholderTextColor="#5A5560"
            autoCapitalize="words"
            autoCorrect={false}
            maxLength={20}
            className="bg-wolf-card text-wolf-text rounded-xl px-4 py-4 text-lg"
          />
          <Text className="text-wolf-muted text-xs px-1">
            Pre-fills your name when you create or join a game.
          </Text>
        </View>

        {/* Role reveal variant. Off by default — these seed a new game's
            setting at create time; the host can still flip them in the lobby. */}
        <View className="mt-4">
          <Text className="text-wolf-muted text-xs font-bold tracking-widest mb-1 px-1">
            ROLE REVEAL
          </Text>
          <View className="bg-wolf-card border border-wolf-surface rounded-2xl px-5 py-4 flex-row items-center justify-between">
            <View className="flex-1 pr-4">
              <Text className="text-wolf-text text-base font-semibold tracking-wider">
                ON LYNCH
              </Text>
              <Text className="text-wolf-muted text-xs mt-1">
                When the village votes someone out, reveal their role.
              </Text>
            </View>
            <Switch
              value={revealOnLynch}
              onValueChange={setRevealOnLynch}
              trackColor={{ false: '#1A1A24', true: '#D4A017' }}
              thumbColor="#F0EDE8"
              ios_backgroundColor="#1A1A24"
            />
          </View>
          <View className="bg-wolf-card border border-wolf-surface rounded-2xl px-5 py-4 mt-2 flex-row items-center justify-between">
            <View className="flex-1 pr-4">
              <Text className="text-wolf-text text-base font-semibold tracking-wider">
                ON NIGHT DEATH
              </Text>
              <Text className="text-wolf-muted text-xs mt-1">
                When a player dies in the night, reveal their role at dawn.
              </Text>
            </View>
            <Switch
              value={revealOnNightDeath}
              onValueChange={setRevealOnNightDeath}
              trackColor={{ false: '#1A1A24', true: '#D4A017' }}
              thumbColor="#F0EDE8"
              ios_backgroundColor="#1A1A24"
            />
          </View>
        </View>

        {/* Only meaningful in builds that expose lobby dev tools; hidden in
            real release builds where DEV_FEATURES_AVAILABLE is false. */}
        {DEV_FEATURES_AVAILABLE && (
          <View className="bg-wolf-card border border-wolf-surface rounded-2xl px-5 py-4 mb-3 mt-4 flex-row items-center justify-between">
            <View className="flex-1 pr-4">
              <Text className="text-wolf-text text-lg font-semibold tracking-wider">
                DEVELOPER MODE
              </Text>
              <Text className="text-wolf-muted text-xs mt-1">
                Show FILL SEATS / ASSIGN ROLES in the lobby. Turn off to play a real game.
              </Text>
            </View>
            <Switch
              value={devModeEnabled}
              onValueChange={setDevModeEnabled}
              trackColor={{ false: '#1A1A24', true: '#D4A017' }}
              thumbColor="#F0EDE8"
              ios_backgroundColor="#1A1A24"
            />
          </View>
        )}

        <View className="mt-4">
          {rows.map(row => (
            <TouchableOpacity
              key={row.label}
              activeOpacity={0.75}
              onPress={row.onPress}
              disabled={!row.enabled}
              className="bg-wolf-card border border-wolf-surface rounded-2xl px-5 py-4 mb-3 items-center"
              style={!row.enabled ? { opacity: 0.35 } : undefined}
            >
              <Text className="text-wolf-text text-lg font-semibold tracking-wider">
                {row.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>
    </SafeAreaView>
  );
}
