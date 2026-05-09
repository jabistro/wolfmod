import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  TextInput,
  SafeAreaView,
  Alert,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { StackNavigationProp } from '@react-navigation/stack';
import { useMutation } from 'convex/react';
import { api } from '../../convex/_generated/api';
import type { RootStackParamList } from '../navigation/types';
import { useDeviceId } from '../hooks/useDeviceId';

type Nav = StackNavigationProp<RootStackParamList, 'CreateGame'>;

const MIN = 3;
const MAX = 30;

export default function CreateGameScreen() {
  const navigation = useNavigation<Nav>();
  const deviceClientId = useDeviceId();
  const createGame = useMutation(api.games.createGame);

  const [name, setName] = useState('');
  const [playerCount, setPlayerCount] = useState(8);
  const [submitting, setSubmitting] = useState(false);

  async function handleCreate() {
    if (!deviceClientId) return;
    if (!name.trim()) {
      Alert.alert('Name required', 'Please enter your name.');
      return;
    }
    setSubmitting(true);
    try {
      const result = await createGame({
        playerCount,
        hostName: name.trim(),
        deviceClientId,
      });
      navigation.replace('Lobby', { gameId: result.gameId });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      Alert.alert('Could not create game', msg);
    } finally {
      setSubmitting(false);
    }
  }

  const ready = !!deviceClientId && !submitting && name.trim().length > 0;

  return (
    <SafeAreaView className="flex-1 bg-wolf-bg">
      <View className="flex-row items-center px-4 pt-10 pb-3">
        <TouchableOpacity onPress={() => navigation.goBack()} className="w-16">
          <Text className="text-wolf-text text-base">‹ Back</Text>
        </TouchableOpacity>
        <Text className="flex-1 text-wolf-text text-xl font-bold text-center">Create Game</Text>
        <View className="w-16" />
      </View>

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <View className="flex-1 px-8 justify-center" style={{ gap: 36 }}>
          <View style={{ gap: 8 }}>
            <Text className="text-wolf-muted text-xs font-bold tracking-widest">YOUR NAME</Text>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder="Enter your name"
              placeholderTextColor="#5A5560"
              autoCapitalize="words"
              autoCorrect={false}
              maxLength={20}
              className="bg-wolf-card text-wolf-text rounded-xl px-4 py-4 text-lg"
            />
          </View>

          <View className="items-center" style={{ gap: 12 }}>
            <Text className="text-wolf-muted text-xs font-bold tracking-widest">PLAYER COUNT</Text>
            <View className="flex-row items-center" style={{ gap: 24 }}>
              <TouchableOpacity
                onPress={() => setPlayerCount(p => Math.max(MIN, p - 1))}
                disabled={playerCount <= MIN}
                style={{ opacity: playerCount <= MIN ? 0.3 : 1 }}
                className="w-14 h-14 bg-wolf-card rounded-full items-center justify-center"
              >
                <Text className="text-wolf-text text-3xl">−</Text>
              </TouchableOpacity>
              <Text
                className="text-wolf-text text-6xl font-semibold text-center"
                style={{ minWidth: 90, fontVariant: ['tabular-nums'] }}
              >
                {playerCount}
              </Text>
              <TouchableOpacity
                onPress={() => setPlayerCount(p => Math.min(MAX, p + 1))}
                disabled={playerCount >= MAX}
                style={{ opacity: playerCount >= MAX ? 0.3 : 1 }}
                className="w-14 h-14 bg-wolf-card rounded-full items-center justify-center"
              >
                <Text className="text-wolf-text text-3xl">+</Text>
              </TouchableOpacity>
            </View>
          </View>

          <TouchableOpacity
            onPress={handleCreate}
            disabled={!ready}
            style={{ opacity: ready ? 1 : 0.4 }}
            className="bg-wolf-accent rounded-xl py-5 items-center"
          >
            {submitting ? (
              <ActivityIndicator color="#0F0F14" />
            ) : (
              <Text className="text-wolf-bg text-lg font-extrabold tracking-widest">
                CREATE GAME
              </Text>
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
