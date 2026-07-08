import React from 'react';
import { View, Text, TouchableOpacity, Dimensions, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image as ExpoImage } from 'expo-image';
import { useNavigation } from '@react-navigation/native';
import type { StackNavigationProp } from '@react-navigation/stack';
import type { RootStackParamList } from '../navigation/types';
import { THEMES } from '../data/themeArt';
import { useTheme } from '../contexts/ThemeContext';
import { getTableArt } from '../data/tableArt';
import RoleCard from '../components/RoleCard';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

type NavProp = StackNavigationProp<RootStackParamList, 'Themes'>;

export default function ThemesScreen() {
  const navigation = useNavigation<NavProp>();
  const { theme, setTheme } = useTheme();
  const art = getTableArt(theme);
  const cardWidth = Math.min(SCREEN_WIDTH * 0.5, 220);

  return (
    <View style={{ flex: 1, backgroundColor: '#0F0F14' }}>
      <ExpoImage
        source={art.lobby}
        style={StyleSheet.absoluteFill}
        contentFit="cover"
        cachePolicy="memory-disk"
      />
      {/* Light scrim — matches LobbyScreen; keeps the header/labels legible
          over the low-contrast lobby art. */}
      <View
        style={{
          ...StyleSheet.absoluteFillObject,
          backgroundColor: 'rgba(15, 15, 20, 0.32)',
        }}
      />
      <SafeAreaView className="flex-1">
      <View className="flex-1 px-6 pt-6 pb-12">
        <View className="flex-row items-center mb-4">
          <TouchableOpacity onPress={() => navigation.goBack()} className="py-2 pr-4">
            <Text className="text-wolf-text text-base font-bold" numberOfLines={1}>‹ Back</Text>
          </TouchableOpacity>
          <Text className="text-wolf-text text-2xl font-bold tracking-widest flex-1 text-center mr-16">
            THEMES
          </Text>
        </View>

        <Text className="text-wolf-text font-bold text-center text-sm mb-6 px-4">
          Choose the art style for role cards.
        </Text>

        <View className="flex-1 items-center justify-center mb-6">
          <RoleCard role="Seer" width={cardWidth} />
        </View>

        <View className="gap-y-3">
          {THEMES.map(t => {
            const selected = t.key === theme;
            return (
              <TouchableOpacity
                key={t.key}
                activeOpacity={0.75}
                onPress={() => setTheme(t.key)}
                className={`rounded-2xl px-5 py-4 border items-center ${
                  selected ? 'bg-wolf-accent border-wolf-accent' : 'bg-wolf-card border-wolf-surface'
                }`}
              >
                <Text
                  className={`text-lg font-semibold tracking-wider ${
                    selected ? 'text-wolf-bg' : 'text-wolf-text'
                  }`}
                >
                  {t.label.toUpperCase()}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>
      </SafeAreaView>
    </View>
  );
}
