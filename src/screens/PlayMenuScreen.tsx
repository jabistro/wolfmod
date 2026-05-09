import React from 'react';
import { View, Text, TouchableOpacity, SafeAreaView } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { StackNavigationProp } from '@react-navigation/stack';
import type { RootStackParamList } from '../navigation/types';

type Nav = StackNavigationProp<RootStackParamList, 'PlayMenu'>;

export default function PlayMenuScreen() {
  const navigation = useNavigation<Nav>();

  return (
    <SafeAreaView className="flex-1 bg-wolf-bg">
      <View className="flex-row items-center px-4 pt-10 pb-3">
        <TouchableOpacity onPress={() => navigation.goBack()} className="w-16">
          <Text className="text-wolf-text text-base">‹ Back</Text>
        </TouchableOpacity>
        <Text className="flex-1 text-wolf-text text-xl font-bold text-center">Play</Text>
        <View className="w-16" />
      </View>

      <View className="flex-1 px-6 justify-center gap-y-4">
        <TouchableOpacity
          onPress={() => navigation.navigate('CreateGame')}
          activeOpacity={0.75}
          className="items-center bg-wolf-card border border-wolf-surface rounded-2xl py-7"
        >
          <Text className="text-wolf-text text-2xl font-bold tracking-widest">CREATE GAME</Text>
          <Text className="text-wolf-muted text-xs mt-1 tracking-widest uppercase">
            Host a new game
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          onPress={() => navigation.navigate('JoinGame')}
          activeOpacity={0.75}
          className="items-center bg-wolf-card border border-wolf-surface rounded-2xl py-7"
        >
          <Text className="text-wolf-text text-2xl font-bold tracking-widest">JOIN GAME</Text>
          <Text className="text-wolf-muted text-xs mt-1 tracking-widest uppercase">
            Enter a room code
          </Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}
