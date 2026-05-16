import React, { useEffect, useState } from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMutation } from 'convex/react';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';

type Props = {
  visible: boolean;
  onClose: () => void;
  gameId: Id<'games'>;
  deviceClientId: string;
  initial: {
    dayDurationSec: number;
    accusationSec: number;
    defenseSec: number;
    voteTimerSec: number;
    maxNominationsPerDay: number;
  };
};

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

type StepperConfig = {
  key:
    | 'dayDurationSec'
    | 'accusationSec'
    | 'defenseSec'
    | 'voteTimerSec'
    | 'maxNominationsPerDay';
  label: string;
  step: number;
  min: number;
  isTime: boolean;
};

const STEPPERS: StepperConfig[] = [
  { key: 'dayDurationSec', label: 'LENGTH OF DAY', step: 30, min: 30, isTime: true },
  { key: 'accusationSec', label: 'ACCUSATION', step: 10, min: 10, isTime: true },
  { key: 'defenseSec', label: 'DEFENSE', step: 10, min: 10, isTime: true },
  { key: 'voteTimerSec', label: 'VOTE', step: 1, min: 1, isTime: false },
  { key: 'maxNominationsPerDay', label: 'NOMINATIONS', step: 1, min: 1, isTime: false },
];

export default function TimersConfigModal({
  visible,
  onClose,
  gameId,
  deviceClientId,
  initial,
}: Props) {
  const insets = useSafeAreaInsets();
  const setDayConfig = useMutation(api.day.setDayConfig);
  const [values, setValues] = useState(initial);
  const [submitting, setSubmitting] = useState(false);

  // Re-seed when the modal opens so it always reflects the latest config.
  useEffect(() => {
    if (visible) setValues(initial);
  }, [visible, initial]);

  function update(key: StepperConfig['key'], next: number) {
    setValues(v => ({ ...v, [key]: next }));
  }

  async function handleSave() {
    setSubmitting(true);
    try {
      await setDayConfig({
        gameId,
        callerDeviceClientId: deviceClientId,
        ...values,
      });
      onClose();
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View
        style={{
          flex: 1,
          backgroundColor: 'rgba(0,0,0,0.85)',
          justifyContent: 'flex-end',
        }}
      >
        <View
          className="bg-wolf-surface rounded-t-3xl"
          style={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
        >
          <View className="flex-row items-center px-6 py-4 border-b border-wolf-card">
            <TouchableOpacity onPress={onClose} className="w-16">
              <Text className="text-wolf-text">Cancel</Text>
            </TouchableOpacity>
            <Text className="flex-1 text-wolf-text text-base font-bold text-center">
              Timers
            </Text>
            <TouchableOpacity
              onPress={handleSave}
              disabled={submitting}
              className="w-16 items-end"
            >
              {submitting ? (
                <ActivityIndicator color="#D4A017" />
              ) : (
                <Text className="text-wolf-accent font-bold">Save</Text>
              )}
            </TouchableOpacity>
          </View>

          <View style={{ paddingHorizontal: 24, paddingVertical: 20, gap: 18 }}>
            {STEPPERS.map(({ key, label, step, min, isTime }) => {
              const value = values[key];
              return (
                <View
                  key={key}
                  className="flex-row items-center justify-between"
                >
                  <Text
                    className="text-wolf-muted"
                    style={{ fontSize: 11, fontWeight: '700', letterSpacing: 1.5 }}
                  >
                    {label}
                  </Text>
                  <View className="flex-row items-center" style={{ gap: 14 }}>
                    <TouchableOpacity
                      onPress={() => update(key, Math.max(min, value - step))}
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
                      {isTime ? formatTime(value) : String(value)}
                    </Text>
                    <TouchableOpacity
                      onPress={() => update(key, value + step)}
                      className="w-9 h-9 bg-wolf-card rounded-full items-center justify-center"
                    >
                      <Text className="text-wolf-text text-xl">+</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              );
            })}
          </View>
        </View>
      </View>
    </Modal>
  );
}
