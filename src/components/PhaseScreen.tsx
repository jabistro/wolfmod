import React from 'react';
import { View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { useTheme } from '../contexts/ThemeContext';
import { getTableArt } from '../data/tableArt';

/**
 * Full-bleed game-screen wrapper. Renders the themed meadow backdrop edge to
 * edge (behind the status bar too), drops a legibility scrim over it, then
 * lays the safe-area content on top — so the whole phase reads like a scene
 * instead of a dark utility screen. Drop-in replacement for a screen's
 * `<SafeAreaView className="flex-1 bg-wolf-bg">` root.
 */
export function PhaseScreen({
  phase,
  children,
  className,
}: {
  phase: 'day' | 'night';
  children: React.ReactNode;
  className?: string;
}) {
  const { theme } = useTheme();
  const art = getTableArt(theme);
  return (
    <View style={{ flex: 1, backgroundColor: '#0F0F14' }}>
      <Image
        source={phase === 'night' ? art.backdropNight : art.backdropDay}
        style={StyleSheet.absoluteFill}
        contentFit="cover"
        cachePolicy="memory-disk"
      />
      {/* Light overall scrim — keeps the scene vivid in the center while
          taking just enough edge off for the seat rings to read. */}
      <View
        style={{
          ...StyleSheet.absoluteFillObject,
          backgroundColor:
            phase === 'night' ? 'rgba(8, 10, 20, 0.34)' : 'rgba(15, 15, 20, 0.26)',
        }}
      />
      <SafeAreaView className={`flex-1 ${className ?? ''}`}>
        {children}
      </SafeAreaView>
    </View>
  );
}
