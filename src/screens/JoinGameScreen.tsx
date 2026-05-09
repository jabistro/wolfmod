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

type Nav = StackNavigationProp<RootStackParamList, 'JoinGame'>;

export default function JoinGameScreen() {
  const navigation = useNavigation<Nav>();
  const deviceClientId = useDeviceId();
  const joinGame = useMutation(api.games.joinGame);

  const [roomCode, setRoomCode] = useState('');
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleJoin() {
    if (!deviceClientId) return;
    const code = roomCode.trim().toUpperCase();
    if (code.length !== 4) {
      Alert.alert('Invalid code', 'Room code is 4 letters.');
      return;
    }
    if (!name.trim()) {
      Alert.alert('Name required', 'Please enter your name.');
      return;
    }
    setSubmitting(true);
    try {
      const result = await joinGame({
        roomCode: code,
        name: name.trim(),
        deviceClientId,
      });
      navigation.replace('Lobby', { gameId: result.gameId });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      Alert.alert('Could not join', msg);
    } finally {
      setSubmitting(false);
    }
  }

  const ready =
    !!deviceClientId &&
    !submitting &&
    roomCode.trim().length === 4 &&
    name.trim().length > 0;

  return (
    <SafeAreaView className="flex-1 bg-wolf-bg">
      <View className="flex-row items-center px-4 pt-10 pb-3">
        <TouchableOpacity onPress={() => navigation.goBack()} className="w-16">
          <Text className="text-wolf-text text-base">‹ Back</Text>
        </TouchableOpacity>
        <Text className="flex-1 text-wolf-text text-xl font-bold text-center">Join Game</Text>
        <View className="w-16" />
      </View>

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <View className="flex-1 px-8 justify-center" style={{ gap: 28 }}>
          <View style={{ gap: 8 }}>
            <Text className="text-wolf-muted text-xs font-bold tracking-widest">ROOM CODE</Text>
            <TextInput
              value={roomCode}
              onChangeText={t => setRoomCode(t.toUpperCase())}
              placeholder="ABCD"
              placeholderTextColor="#5A5560"
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={4}
              className="bg-wolf-card text-wolf-accent rounded-xl px-4 py-5 text-3xl font-extrabold text-center"
              style={{ letterSpacing: 8 }}
            />
          </View>

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

          <TouchableOpacity
            onPress={handleJoin}
            disabled={!ready}
            style={{ opacity: ready ? 1 : 0.4 }}
            className="bg-wolf-accent rounded-xl py-5 items-center"
          >
            {submitting ? (
              <ActivityIndicator color="#0F0F14" />
            ) : (
              <Text className="text-wolf-bg text-lg font-extrabold tracking-widest">
                JOIN GAME
              </Text>
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
