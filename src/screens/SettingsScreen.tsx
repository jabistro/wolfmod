import React from 'react';
import { View, Text, TouchableOpacity, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { StackNavigationProp } from '@react-navigation/stack';
import type { RootStackParamList } from '../navigation/types';

type NavProp = StackNavigationProp<RootStackParamList, 'Settings'>;

type Row = {
  label: string;
  onPress?: () => void;
  enabled: boolean;
};

export default function SettingsScreen() {
  const navigation = useNavigation<NavProp>();

  const rows: Row[] = [
    { label: 'THEMES', onPress: () => navigation.navigate('Themes'), enabled: true },
  ];

  return (
    <SafeAreaView className="flex-1 bg-wolf-bg">
      <View className="flex-1 px-6 pt-6 pb-12">
        <View className="flex-row items-center mb-8">
          <TouchableOpacity onPress={() => navigation.goBack()} className="py-2 pr-4">
            <Text className="text-wolf-accent text-lg">‹ BACK</Text>
          </TouchableOpacity>
          <Text className="text-wolf-text text-2xl font-bold tracking-widest flex-1 text-center mr-16">
            SETTINGS
          </Text>
        </View>

        <ScrollView className="flex-1">
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
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}
