import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image as ExpoImage } from 'expo-image';
import { useNavigation } from '@react-navigation/native';
import type { StackNavigationProp } from '@react-navigation/stack';
import type { RootStackParamList } from '../navigation/types';
import { useTheme } from '../contexts/ThemeContext';
import { getTableArt } from '../data/tableArt';
import appConfig from '../../app.json';

type HomeNavProp = StackNavigationProp<RootStackParamList, 'Home'>;

const NAV_BUTTONS = ['PLAY', 'MODCLOCK', 'ROLES', 'SETTINGS'];
const DISABLED_BUTTONS = new Set<string>();

// Per-theme typography test (home screen only for now). Each deck gets its own
// font family; the pixel font (16bit) also needs smaller sizes so long words
// like MODCLOCK don't overflow. fontSize/letterSpacing live here rather than in
// classNames so the custom family fully controls the look.
type HomeFontRole = { fontFamily: string; fontSize: number; letterSpacing: number };
const HOME_FONTS: Record<
  string,
  { header: HomeFontRole; button: HomeFontRole; footer: HomeFontRole }
> = {
  ghibli: {
    header: { fontFamily: 'Quicksand_700Bold', fontSize: 48, letterSpacing: 2 },
    button: { fontFamily: 'Quicksand_600SemiBold', fontSize: 16, letterSpacing: 1 },
    footer: { fontFamily: 'Quicksand_500Medium', fontSize: 10, letterSpacing: 2 },
  },
  chibi: {
    header: { fontFamily: 'Baloo2_700Bold', fontSize: 48, letterSpacing: 1 },
    button: { fontFamily: 'Baloo2_600SemiBold', fontSize: 16, letterSpacing: 1 },
    footer: { fontFamily: 'Baloo2_500Medium', fontSize: 10, letterSpacing: 2 },
  },
  '16bit': {
    header: { fontFamily: 'PressStart2P_400Regular', fontSize: 26, letterSpacing: 0 },
    button: { fontFamily: 'PressStart2P_400Regular', fontSize: 11, letterSpacing: 0 },
    footer: { fontFamily: 'PressStart2P_400Regular', fontSize: 7, letterSpacing: 1 },
  },
};

export default function HomeScreen() {
  const navigation = useNavigation<HomeNavProp>();
  const { theme } = useTheme();
  const art = getTableArt(theme);
  // The ghibli home backdrop is light at the bottom, so the footer needs a
  // dark ink there; chibi + 16bit are dark at the bottom, so it needs a light
  // one. (The muted grey #8A8590 washes out on both.)
  const footerColor = theme === 'ghibli' ? '#2A2A33' : '#D8D5CF';
  const fonts = HOME_FONTS[theme] ?? HOME_FONTS.ghibli;

  function handlePress(label: string) {
    if (label === 'PLAY') navigation.navigate('PlayMenu');
    if (label === 'ROLES') navigation.navigate('Roles');
    if (label === 'MODCLOCK') navigation.navigate('ClockSetup');
    if (label === 'SETTINGS') navigation.navigate('Settings');
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#0F0F14' }}>
      <ExpoImage
        source={art.home}
        style={StyleSheet.absoluteFill}
        contentFit="cover"
        cachePolicy="memory-disk"
      />
      {/* Light scrim — keeps the scene vivid while lifting the header text and
          footer off the art. */}
      <View
        style={{
          ...StyleSheet.absoluteFillObject,
          backgroundColor: 'rgba(15, 15, 20, 0.28)',
        }}
      />
      <SafeAreaView className="flex-1">
        <View className="flex-1 px-6 pt-4 pb-4">

        {/* Header */}
        <View className="flex-row items-center justify-center mt-2">
          <Text
            className="text-wolf-text"
            style={{
              ...fonts.header,
              textShadowColor: 'rgba(0, 0, 0, 0.75)',
              textShadowOffset: { width: 0, height: 2 },
              textShadowRadius: 6,
            }}
          >
            WolfMod
          </Text>
        </View>

        {/* Bottom cluster */}
        <View className="items-center mt-auto">
          {/* Nav Buttons */}
          <View className="w-3/5 gap-y-3">
            {NAV_BUTTONS.map((label) => {
              const disabled = DISABLED_BUTTONS.has(label);
              return (
                <TouchableOpacity
                  key={label}
                  activeOpacity={0.75}
                  onPress={() => handlePress(label)}
                  disabled={disabled}
                  className="items-center bg-wolf-card border border-wolf-surface rounded-xl px-5 py-3"
                  style={disabled ? { opacity: 0.35 } : undefined}
                >
                  <Text
                    className="text-wolf-text"
                    style={[
                      fonts.button,
                      { includeFontPadding: false, textAlignVertical: 'center' },
                    ]}
                  >
                    {label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <Text
            className="uppercase mt-6"
            style={{ ...fonts.footer, color: footerColor }}
          >
            Built by Bistro
          </Text>
          <Text className="mt-1" style={{ ...fonts.footer, color: footerColor }}>
            v{appConfig.expo.version}
          </Text>
        </View>

        </View>
      </SafeAreaView>
    </View>
  );
}
