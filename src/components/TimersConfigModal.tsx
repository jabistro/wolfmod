import React, { useEffect, useState } from 'react';
import {
  Modal,
  ScrollView,
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMutation } from 'convex/react';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import { showAlert } from './ThemedAlert';

type PassHostCandidate = { _id: Id<'players'>; name: string };

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
    wolfPickerSec: number;
  };
  /**
   * When provided, the modal renders a PASS HOST row at the top opening
   * an inline picker. Pass undefined to hide the row (e.g. when caller
   * isn't actually host, though the cog is host-only today).
   */
  passHostCandidates?: PassHostCandidate[];
  /**
   * Room code shown at the top of the modal so the host has it handy when
   * someone at the table forgets it.
   */
  roomCode?: string;
  /**
   * When true, render an END GAME row at the bottom. Caller passes true
   * for mid-game contexts (not lobby — lobby uses Leave to tear down).
   */
  canEndGame?: boolean;
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
    | 'maxNominationsPerDay'
    | 'wolfPickerSec';
  label: string;
  step: number;
  min: number;
  max?: number;
  isTime: boolean;
};

const STEPPERS: StepperConfig[] = [
  { key: 'dayDurationSec', label: 'LENGTH OF DAY', step: 30, min: 30, isTime: true },
  { key: 'accusationSec', label: 'ACCUSATION', step: 10, min: 10, isTime: true },
  { key: 'defenseSec', label: 'DEFENSE', step: 10, min: 10, isTime: true },
  { key: 'voteTimerSec', label: 'VOTE', step: 1, min: 1, isTime: false },
  { key: 'maxNominationsPerDay', label: 'NOMINATIONS', step: 1, min: 1, isTime: false },
  { key: 'wolfPickerSec', label: 'WOLF DECISION', step: 10, min: 10, max: 60, isTime: true },
];

export default function TimersConfigModal({
  visible,
  onClose,
  gameId,
  deviceClientId,
  initial,
  passHostCandidates,
  roomCode,
  canEndGame,
}: Props) {
  const insets = useSafeAreaInsets();
  const setDayConfig = useMutation(api.day.setDayConfig);
  const passHost = useMutation(api.games.passHost);
  const endGameByHost = useMutation(api.games.endGameByHost);
  const [values, setValues] = useState(initial);
  const [submitting, setSubmitting] = useState(false);
  const [mode, setMode] = useState<'main' | 'pick-host'>('main');
  const [passing, setPassing] = useState<Id<'players'> | null>(null);
  const [ending, setEnding] = useState(false);

  // Re-seed when the modal opens so it always reflects the latest config.
  useEffect(() => {
    if (visible) {
      setValues(initial);
      setMode('main');
    }
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
      showAlert('Error', e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  function handleEndGame() {
    showAlert(
      'End game for everyone?',
      'This closes the game on every phone. Players will be sent to the end screen.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'End Game',
          style: 'destructive',
          onPress: async () => {
            setEnding(true);
            try {
              await endGameByHost({
                gameId,
                callerDeviceClientId: deviceClientId,
              });
              onClose();
            } catch (e) {
              showAlert(
                'Could not end game',
                e instanceof Error ? e.message : String(e),
              );
            } finally {
              setEnding(false);
            }
          },
        },
      ],
    );
  }

  async function handlePass(target: PassHostCandidate) {
    setPassing(target._id);
    try {
      await passHost({
        gameId,
        targetPlayerId: target._id,
        callerDeviceClientId: deviceClientId,
      });
      onClose();
    } catch (e) {
      showAlert(
        'Could not pass host',
        e instanceof Error ? e.message : String(e),
      );
    } finally {
      setPassing(null);
    }
  }

  const isPicking = mode === 'pick-host';

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={() => {
        if (isPicking) setMode('main');
        else onClose();
      }}
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
            <TouchableOpacity
              onPress={() => (isPicking ? setMode('main') : onClose())}
              className="w-16"
            >
              <Text className="text-wolf-text">
                {isPicking ? 'Back' : 'Cancel'}
              </Text>
            </TouchableOpacity>
            <Text className="flex-1 text-wolf-text text-base font-bold text-center">
              {isPicking ? 'Pass Host' : 'Settings'}
            </Text>
            {isPicking ? (
              <View className="w-16" />
            ) : (
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
            )}
          </View>

          {isPicking ? (
            <ScrollView
              style={{ maxHeight: 360 }}
              contentContainerStyle={{ paddingHorizontal: 24, paddingVertical: 12 }}
            >
              {(passHostCandidates ?? []).length === 0 ? (
                <Text className="text-wolf-muted text-sm text-center py-6">
                  No other players to pass host to.
                </Text>
              ) : (
                (passHostCandidates ?? []).map(c => (
                  <TouchableOpacity
                    key={c._id}
                    onPress={() => handlePass(c)}
                    disabled={passing !== null}
                    className="bg-wolf-card rounded-xl px-4 py-4 mb-2 flex-row items-center justify-between"
                    style={{ opacity: passing && passing !== c._id ? 0.4 : 1 }}
                  >
                    <Text className="text-wolf-text text-base">{c.name}</Text>
                    {passing === c._id ? (
                      <ActivityIndicator color="#D4A017" />
                    ) : (
                      <Text className="text-wolf-muted">›</Text>
                    )}
                  </TouchableOpacity>
                ))
              )}
            </ScrollView>
          ) : (
            <View style={{ paddingHorizontal: 24, paddingVertical: 20, gap: 18 }}>
              {roomCode && (
                <View className="items-center">
                  <Text
                    className="text-wolf-muted"
                    style={{ fontSize: 11, fontWeight: '700', letterSpacing: 2 }}
                  >
                    ROOM CODE
                  </Text>
                  <Text
                    className="text-wolf-accent"
                    style={{
                      fontSize: 32,
                      fontWeight: '800',
                      letterSpacing: 8,
                      marginTop: 4,
                    }}
                  >
                    {roomCode}
                  </Text>
                </View>
              )}
              {passHostCandidates !== undefined && (
                <TouchableOpacity
                  onPress={() => setMode('pick-host')}
                  className="flex-row items-center justify-between bg-wolf-card rounded-xl px-4 py-4"
                >
                  <Text
                    className="text-wolf-text"
                    style={{ fontSize: 13, fontWeight: '700', letterSpacing: 1.5 }}
                  >
                    PASS HOST
                  </Text>
                  <Text className="text-wolf-muted">›</Text>
                </TouchableOpacity>
              )}
              {STEPPERS.map(({ key, label, step, min, max, isTime }) => {
                const value = values[key];
                const atMax = max !== undefined && value >= max;
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
                        onPress={() =>
                          update(
                            key,
                            max !== undefined
                              ? Math.min(max, value + step)
                              : value + step,
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
              {canEndGame && (
                <TouchableOpacity
                  onPress={handleEndGame}
                  disabled={ending}
                  style={{ opacity: ending ? 0.4 : 1, marginTop: 6 }}
                  className="rounded-xl px-4 py-4 items-center"
                  // Subtle danger color — destructive action.
                >
                  {ending ? (
                    <ActivityIndicator color="#B03A2E" />
                  ) : (
                    <Text
                      className="text-wolf-red"
                      style={{ fontSize: 13, fontWeight: '700', letterSpacing: 1.5 }}
                    >
                      END GAME FOR EVERYONE
                    </Text>
                  )}
                </TouchableOpacity>
              )}
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}
