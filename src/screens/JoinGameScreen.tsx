import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { StackNavigationProp } from '@react-navigation/stack';
import { useMutation } from 'convex/react';
import { ConvexError } from 'convex/values';
import { api } from '../../convex/_generated/api';
import type { RootStackParamList } from '../navigation/types';
import { useDeviceId } from '../hooks/useDeviceId';

type Nav = StackNavigationProp<RootStackParamList, 'JoinGame'>;

function cleanJoinError(e: unknown): string {
  if (e instanceof ConvexError) {
    return typeof e.data === 'string' ? e.data : 'Could not join the game.';
  }
  // Convex wraps regular Errors with "[CONVEX M(...)] Server Error\nUncaught Error: <msg>\n at ..."
  const raw = e instanceof Error ? e.message : String(e);
  const m = raw.match(/Uncaught Error:\s*([^\n]+)/);
  if (m) return m[1].trim();
  return 'Could not join the game.';
}

export default function JoinGameScreen() {
  const navigation = useNavigation<Nav>();
  const deviceClientId = useDeviceId();
  const joinGame = useMutation(api.games.joinGame);

  const [roomCode, setRoomCode] = useState('');
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function handleJoin() {
    if (!deviceClientId) return;
    const code = roomCode.trim().toUpperCase();
    if (code.length !== 4) {
      setErrorMsg('Room code is 4 letters.');
      return;
    }
    if (!name.trim()) {
      setErrorMsg('Please enter your name.');
      return;
    }
    setErrorMsg(null);
    setSubmitting(true);
    try {
      const result = await joinGame({
        roomCode: code,
        name: name.trim(),
        deviceClientId,
      });
      navigation.replace('Lobby', { gameId: result.gameId });
    } catch (e) {
      setErrorMsg(cleanJoinError(e));
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
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1 }}
      >
        <View className="flex-1 px-8 justify-center" style={{ gap: 28 }}>
          <View style={{ gap: 8 }}>
            <Text className="text-wolf-muted text-xs font-bold tracking-widest">ROOM CODE</Text>
            <TextInput
              value={roomCode}
              onChangeText={t => {
                setRoomCode(t.toUpperCase());
                if (errorMsg) setErrorMsg(null);
              }}
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
              onChangeText={t => {
                setName(t);
                if (errorMsg) setErrorMsg(null);
              }}
              placeholder="Enter your name"
              placeholderTextColor="#5A5560"
              autoCapitalize="words"
              autoCorrect={false}
              maxLength={20}
              className="bg-wolf-card text-wolf-text rounded-xl px-4 py-4 text-lg"
            />
          </View>

          {errorMsg ? (
            <View
              className="rounded-xl px-4 py-3"
              style={{
                backgroundColor: 'rgba(176, 58, 46, 0.12)',
                borderWidth: 1,
                borderColor: '#B03A2E',
              }}
            >
              <Text className="text-wolf-red text-sm font-semibold text-center">
                {errorMsg}
              </Text>
            </View>
          ) : null}

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
