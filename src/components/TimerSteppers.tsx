import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';

export type TimerConfigValues = {
  dayDurationSec: number;
  accusationSec: number;
  defenseSec: number;
  voteTimerSec: number;
  preVoteSec: number;
  maxNominationsPerDay: number;
  wolfPickerSec: number;
  nightActionSec: number;
};

// Keep in sync with DAY_CONFIG_DEFAULTS in convex/helpers.ts — these are the
// values a freshly created game starts with when the host hasn't set their own.
export const TIMER_DEFAULTS: TimerConfigValues = {
  dayDurationSec: 180,
  accusationSec: 30,
  defenseSec: 30,
  voteTimerSec: 5,
  preVoteSec: 15,
  maxNominationsPerDay: 3,
  wolfPickerSec: 60,
  nightActionSec: 30,
};

type StepperConfig = {
  key: keyof TimerConfigValues;
  label: string;
  step: number;
  min: number;
  max?: number;
  isTime: boolean;
};

export const TIMER_STEPPERS: StepperConfig[] = [
  { key: 'dayDurationSec', label: 'LENGTH OF DAY', step: 30, min: 30, isTime: true },
  { key: 'accusationSec', label: 'ACCUSATION', step: 10, min: 10, isTime: true },
  { key: 'defenseSec', label: 'DEFENSE', step: 10, min: 10, isTime: true },
  { key: 'voteTimerSec', label: 'VOTE', step: 1, min: 1, isTime: false },
  { key: 'preVoteSec', label: 'PRE-VOTE (REMOTE)', step: 5, min: 5, isTime: true },
  { key: 'maxNominationsPerDay', label: 'NOMINATIONS', step: 1, min: 1, isTime: false },
  { key: 'wolfPickerSec', label: 'WOLF DECISION', step: 10, min: 10, max: 180, isTime: true },
  { key: 'nightActionSec', label: 'NIGHT ACTIONS', step: 10, min: 10, max: 180, isTime: true },
];

export function formatTimerValue(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

/**
 * The stack of −/value/+ stepper rows shared by the in-game Settings modal
 * (TimersConfigModal) and the home-screen Timer Defaults editor. Callers own
 * the values and persistence; this component is purely the controls.
 */
export default function TimerSteppers({
  values,
  onChange,
}: {
  values: TimerConfigValues;
  onChange: (key: keyof TimerConfigValues, next: number) => void;
}) {
  return (
    <>
      {TIMER_STEPPERS.map(({ key, label, step, min, max, isTime }) => {
        const value = values[key];
        const atMax = max !== undefined && value >= max;
        return (
          <View key={key} className="flex-row items-center justify-between">
            <Text
              className="text-wolf-muted"
              style={{ fontSize: 11, fontWeight: '700', letterSpacing: 1.5 }}
            >
              {label}
            </Text>
            <View className="flex-row items-center" style={{ gap: 14 }}>
              <TouchableOpacity
                onPress={() => onChange(key, Math.max(min, value - step))}
                disabled={value <= min}
                style={{ opacity: value <= min ? 0.3 : 1 }}
                className="w-9 h-9 bg-wolf-card rounded-full items-center justify-center"
              >
                <Text className="text-wolf-text text-xl">−</Text>
              </TouchableOpacity>
              <Text
                className="text-wolf-text text-center"
                style={{
                  fontSize: 22,
                  fontWeight: '600',
                  minWidth: 80,
                  fontVariant: ['tabular-nums'],
                }}
              >
                {isTime ? formatTimerValue(value) : String(value)}
              </Text>
              <TouchableOpacity
                onPress={() =>
                  onChange(
                    key,
                    max !== undefined ? Math.min(max, value + step) : value + step,
                  )
                }
                disabled={atMax}
                style={{ opacity: atMax ? 0.3 : 1 }}
                className="w-9 h-9 bg-wolf-card rounded-full items-center justify-center"
              >
                <Text className="text-wolf-text text-xl">+</Text>
              </TouchableOpacity>
            </View>
          </View>
        );
      })}
    </>
  );
}
