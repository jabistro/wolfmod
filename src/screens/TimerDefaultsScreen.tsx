import React, { useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { StackNavigationProp } from '@react-navigation/stack';
import type { RootStackParamList } from '../navigation/types';
import { useTimerDefaults } from '../contexts/TimerDefaultsContext';
import TimerSteppers, {
  TIMER_DEFAULTS,
  type TimerConfigValues,
} from '../components/TimerSteppers';

type NavProp = StackNavigationProp<RootStackParamList, 'TimerDefaults'>;

export default function TimerDefaultsScreen() {
  const navigation = useNavigation<NavProp>();
  const { timerDefaults, setTimerDefaults } = useTimerDefaults();
  const [values, setValues] = useState<TimerConfigValues>(timerDefaults);

  function update(key: keyof TimerConfigValues, next: number) {
    setValues(v => ({ ...v, [key]: next }));
  }

  function handleSave() {
    setTimerDefaults(values);
    navigation.goBack();
  }

  return (
    <SafeAreaView className="flex-1 bg-wolf-bg">
      <View className="flex-1 px-6 pt-6 pb-12">
        <View className="flex-row items-center mb-2">
          <TouchableOpacity onPress={() => navigation.goBack()} className="py-2 pr-4">
            <Text className="text-wolf-text text-base">‹ Back</Text>
          </TouchableOpacity>
          <Text className="text-wolf-text text-2xl font-bold tracking-widest flex-1 text-center mr-16">
            TIMERS
          </Text>
        </View>

        <Text className="text-wolf-muted text-sm text-center mb-8 px-4">
          These values become the starting timers for every new game you create.
          The host can still adjust them mid-game from the in-game settings.
        </Text>

        <ScrollView
          className="flex-1"
          contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', paddingBottom: '10%' }}
        >
          <View className="bg-wolf-surface rounded-2xl px-5 py-6" style={{ gap: 18 }}>
            <TimerSteppers values={values} onChange={update} />
          </View>

          <TouchableOpacity
            onPress={() => setValues(TIMER_DEFAULTS)}
            className="items-center mt-5 py-2"
          >
            <Text className="text-wolf-muted text-sm tracking-wider">
              RESET TO DEFAULTS
            </Text>
          </TouchableOpacity>
        </ScrollView>

        <TouchableOpacity
          onPress={handleSave}
          activeOpacity={0.85}
          className="bg-wolf-accent rounded-xl py-4 items-center mt-4"
        >
          <Text className="text-wolf-bg text-lg font-extrabold tracking-widest">
            SAVE
          </Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}
