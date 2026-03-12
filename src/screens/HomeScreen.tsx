import React from 'react';
import { View, Text, Image, TouchableOpacity, SafeAreaView } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';

type HomeNavProp = NativeStackNavigationProp<RootStackParamList, 'Home'>;

const NAV_BUTTONS = ['Build', 'Clock', 'Roles', 'Settings', 'Tutorial'];

export default function HomeScreen() {
  const navigation = useNavigation<HomeNavProp>();

  function handlePress(label: string) {
    if (label === 'Roles') navigation.navigate('Roles');
  }

  return (
    <SafeAreaView className="flex-1 bg-wolf-bg">
      <View className="flex-1 items-center px-6 pt-10 pb-24">

        {/* Logo */}
        <View className="items-center mt-6">
          <View className="w-52 h-52 items-center justify-center">
            <Image
              source={require('../../assets/wolfmod_logo.png')}
              className="w-full h-full"
              resizeMode="contain"
            />
          </View>
        </View>

        {/* Header */}
        <View className="items-center mt-4">
          <Text className="text-wolf-accent text-5xl font-bold tracking-widest">
            WolfMod
          </Text>
          <Text className="text-wolf-muted text-sm tracking-widest uppercase mt-1">
            Moderator Companion
          </Text>
        </View>

        {/* Nav Buttons */}
        <View className="w-3/4 gap-y-3 mt-auto">
          {NAV_BUTTONS.map((label) => (
            <TouchableOpacity
              key={label}
              activeOpacity={0.75}
              onPress={() => handlePress(label)}
              className="items-center bg-wolf-card border border-wolf-surface rounded-2xl px-5 py-4"
            >
              <Text className="text-wolf-text text-lg font-semibold tracking-wider">
                {label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

      </View>
    </SafeAreaView>
  );
}
