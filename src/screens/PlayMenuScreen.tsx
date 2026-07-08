import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image as ExpoImage } from 'expo-image';
import { useNavigation } from '@react-navigation/native';
import type { StackNavigationProp } from '@react-navigation/stack';
import type { RootStackParamList } from '../navigation/types';
import { useTheme } from '../contexts/ThemeContext';
import { getTableArt } from '../data/tableArt';

type Nav = StackNavigationProp<RootStackParamList, 'PlayMenu'>;

export default function PlayMenuScreen() {
  const navigation = useNavigation<Nav>();
  const { theme } = useTheme();
  const art = getTableArt(theme);

  return (
    <View style={{ flex: 1, backgroundColor: '#0F0F14' }}>
      <ExpoImage
        source={art.createJoin}
        style={StyleSheet.absoluteFill}
        contentFit="cover"
        cachePolicy="memory-disk"
      />
      {/* Light scrim — keeps the scene vivid while lifting the header and the
          Create / Join buttons off the art. */}
      <View
        style={{
          ...StyleSheet.absoluteFillObject,
          backgroundColor: 'rgba(15, 15, 20, 0.32)',
        }}
      />
      <SafeAreaView className="flex-1">
      <View className="flex-row items-center px-4 pt-10 pb-3">
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Text className="text-wolf-text text-base font-bold" numberOfLines={1}>
            ‹ Back
          </Text>
        </TouchableOpacity>
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
    </View>
  );
}
