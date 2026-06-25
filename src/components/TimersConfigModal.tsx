import React, { useEffect, useState } from 'react';
import {
  Modal,
  ScrollView,
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  Switch,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMutation } from 'convex/react';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import { showAlert } from './ThemedAlert';
import TimerSteppers, { type TimerConfigValues } from './TimerSteppers';

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
    preVoteSec: number;
    maxNominationsPerDay: number;
    wolfPickerSec: number;
    nightActionSec: number;
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
  /**
   * When provided, render the "role reveal" variant toggles and persist them
   * with the rest of the config. Omit to hide the section entirely.
   */
  revealConfig?: { revealOnLynch: boolean; revealOnNightDeath: boolean };
};

export default function TimersConfigModal({
  visible,
  onClose,
  gameId,
  deviceClientId,
  initial,
  passHostCandidates,
  roomCode,
  canEndGame,
  revealConfig,
}: Props) {
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const setDayConfig = useMutation(api.day.setDayConfig);
  const passHost = useMutation(api.games.passHost);
  const endGameByHost = useMutation(api.games.endGameByHost);
  const [values, setValues] = useState(initial);
  const [revealLynch, setRevealLynch] = useState(!!revealConfig?.revealOnLynch);
  const [revealNight, setRevealNight] = useState(
    !!revealConfig?.revealOnNightDeath,
  );
  const [submitting, setSubmitting] = useState(false);
  const [mode, setMode] = useState<'main' | 'pick-host'>('main');
  const [passing, setPassing] = useState<Id<'players'> | null>(null);
  const [ending, setEnding] = useState(false);

  // Re-seed only when the modal OPENS so it reflects the latest config. We
  // intentionally depend on `visible` alone, not on `initial`/`revealConfig`:
  // callers pass those as fresh object literals every render, and the host
  // screens re-render ~5×/sec (ticking clock). Including them here re-fired
  // this effect constantly and wiped each edit the instant it was made.
  useEffect(() => {
    if (visible) {
      setValues(initial);
      setRevealLynch(!!revealConfig?.revealOnLynch);
      setRevealNight(!!revealConfig?.revealOnNightDeath);
      setMode('main');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  function update(key: keyof TimerConfigValues, next: number) {
    setValues(v => ({ ...v, [key]: next }));
  }

  async function handleSave() {
    setSubmitting(true);
    try {
      await setDayConfig({
        gameId,
        callerDeviceClientId: deviceClientId,
        ...values,
        ...(revealConfig
          ? { revealOnLynch: revealLynch, revealOnNightDeath: revealNight }
          : {}),
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
            // Cap the scroll area so a tall config (timers + role-reveal +
            // end-game) can never push the fixed Save header off the top of
            // the screen — the content scrolls instead.
            <ScrollView
              style={{ maxHeight: windowHeight * 0.62 }}
              contentContainerStyle={{
                paddingHorizontal: 24,
                paddingVertical: 20,
                gap: 18,
              }}
            >
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
              <TimerSteppers values={values} onChange={update} />
              {revealConfig && (
                <View style={{ gap: 10 }}>
                  <Text
                    className="text-wolf-muted"
                    style={{ fontSize: 11, fontWeight: '700', letterSpacing: 2 }}
                  >
                    ROLE REVEAL
                  </Text>
                  <View className="flex-row items-center justify-between bg-wolf-card rounded-xl px-4 py-3">
                    <Text
                      className="text-wolf-text flex-1 pr-3"
                      style={{ fontSize: 13, fontWeight: '700', letterSpacing: 1 }}
                    >
                      ON LYNCH
                    </Text>
                    <Switch
                      value={revealLynch}
                      onValueChange={setRevealLynch}
                      trackColor={{ false: '#1A1A24', true: '#D4A017' }}
                      thumbColor="#F0EDE8"
                      ios_backgroundColor="#1A1A24"
                    />
                  </View>
                  <View className="flex-row items-center justify-between bg-wolf-card rounded-xl px-4 py-3">
                    <Text
                      className="text-wolf-text flex-1 pr-3"
                      style={{ fontSize: 13, fontWeight: '700', letterSpacing: 1 }}
                    >
                      ON NIGHT DEATH
                    </Text>
                    <Switch
                      value={revealNight}
                      onValueChange={setRevealNight}
                      trackColor={{ false: '#1A1A24', true: '#D4A017' }}
                      thumbColor="#F0EDE8"
                      ios_backgroundColor="#1A1A24"
                    />
                  </View>
                </View>
              )}
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
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}
