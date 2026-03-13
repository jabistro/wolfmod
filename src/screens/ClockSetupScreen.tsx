import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  SafeAreaView,
  StyleSheet,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { StackNavigationProp } from '@react-navigation/stack';
import type { RootStackParamList } from '../navigation/types';

type Nav = StackNavigationProp<RootStackParamList, 'ClockSetup'>;

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

interface StepperRowProps {
  label: string;
  displayValue: string;
  onDecrement: () => void;
  onIncrement: () => void;
  decrementDisabled: boolean;
}

function StepperRow({ label, displayValue, onDecrement, onIncrement, decrementDisabled }: StepperRowProps) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <View style={styles.stepper}>
        <TouchableOpacity
          onPress={onDecrement}
          disabled={decrementDisabled}
          style={[styles.stepBtn, decrementDisabled && styles.stepBtnDisabled]}
        >
          <Text style={styles.stepBtnText}>−</Text>
        </TouchableOpacity>
        <Text style={styles.stepValue}>{displayValue}</Text>
        <TouchableOpacity onPress={onIncrement} style={styles.stepBtn}>
          <Text style={styles.stepBtnText}>+</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

export default function ClockSetupScreen() {
  const navigation = useNavigation<Nav>();
  const [daySeconds, setDaySeconds] = useState(180);
  const [accusationSeconds, setAccusationSeconds] = useState(30);
  const [defenseSeconds, setDefenseSeconds] = useState(30);
  const [nominations, setNominations] = useState(3);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Text style={styles.backText}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Clock Setup</Text>
        <View style={styles.headerSpacer} />
      </View>

      <View style={styles.body}>
        <StepperRow
          label="LENGTH OF DAY"
          displayValue={formatTime(daySeconds)}
          onDecrement={() => setDaySeconds(s => Math.max(30, s - 30))}
          onIncrement={() => setDaySeconds(s => s + 30)}
          decrementDisabled={daySeconds <= 30}
        />
        <StepperRow
          label="ACCUSATION"
          displayValue={formatTime(accusationSeconds)}
          onDecrement={() => setAccusationSeconds(s => Math.max(10, s - 10))}
          onIncrement={() => setAccusationSeconds(s => s + 10)}
          decrementDisabled={accusationSeconds <= 10}
        />
        <StepperRow
          label="DEFENSE"
          displayValue={formatTime(defenseSeconds)}
          onDecrement={() => setDefenseSeconds(s => Math.max(10, s - 10))}
          onIncrement={() => setDefenseSeconds(s => s + 10)}
          decrementDisabled={defenseSeconds <= 10}
        />
        <StepperRow
          label="NOMINATIONS"
          displayValue={String(nominations)}
          onDecrement={() => setNominations(n => Math.max(1, n - 1))}
          onIncrement={() => setNominations(n => n + 1)}
          decrementDisabled={nominations <= 1}
        />

        <TouchableOpacity
          style={styles.beginBtn}
          onPress={() =>
            navigation.navigate('Clock', {
              dayDuration: daySeconds,
              accusationDuration: accusationSeconds,
              defenseDuration: defenseSeconds,
              nominations,
            })
          }
        >
          <Text style={styles.beginBtnText}>BEGIN</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0F0F14',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 40,
    paddingBottom: 12,
  },
  backBtn: {
    width: 60,
  },
  backText: {
    color: '#F0EDE8',
    fontSize: 16,
  },
  title: {
    flex: 1,
    color: '#F0EDE8',
    fontSize: 20,
    fontWeight: 'bold',
    textAlign: 'center',
  },
  headerSpacer: {
    width: 60,
  },
  body: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 28,
  },
  row: {
    alignItems: 'center',
    gap: 10,
  },
  rowLabel: {
    color: '#8A8590',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1.5,
  },
  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 20,
  },
  stepBtn: {
    width: 44,
    height: 44,
    backgroundColor: '#22222F',
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepBtnDisabled: {
    opacity: 0.3,
  },
  stepBtnText: {
    color: '#F0EDE8',
    fontSize: 24,
    lineHeight: 26,
  },
  stepValue: {
    color: '#F0EDE8',
    fontSize: 32,
    fontWeight: '600',
    minWidth: 90,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },
  beginBtn: {
    marginTop: 16,
    backgroundColor: '#D4A017',
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
  },
  beginBtnText: {
    color: '#0F0F14',
    fontSize: 18,
    fontWeight: '800',
    letterSpacing: 2,
  },
});
