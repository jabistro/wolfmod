import React, { useState } from 'react';
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

type Candidate = { _id: Id<'players'>; name: string };

type Props = {
  visible: boolean;
  onClose: () => void;
  gameId: Id<'games'>;
  deviceClientId: string;
  candidates: Candidate[];
  /** Fired after the mutation succeeds. The modal also closes itself. */
  onPassed?: () => void;
};

export default function PassHostPickerModal({
  visible,
  onClose,
  gameId,
  deviceClientId,
  candidates,
  onPassed,
}: Props) {
  const insets = useSafeAreaInsets();
  const passHost = useMutation(api.games.passHost);
  const [passing, setPassing] = useState<Id<'players'> | null>(null);

  async function handlePass(target: Candidate) {
    setPassing(target._id);
    try {
      await passHost({
        gameId,
        targetPlayerId: target._id,
        callerDeviceClientId: deviceClientId,
      });
      onClose();
      onPassed?.();
    } catch (e) {
      showAlert(
        'Could not pass host',
        e instanceof Error ? e.message : String(e),
      );
    } finally {
      setPassing(null);
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
              Pass Host
            </Text>
            <View className="w-16" />
          </View>

          <ScrollView
            style={{ maxHeight: 380 }}
            contentContainerStyle={{ paddingHorizontal: 24, paddingVertical: 12 }}
          >
            {candidates.length === 0 ? (
              <Text className="text-wolf-muted text-sm text-center py-6">
                No living players to pass host to.
              </Text>
            ) : (
              candidates.map(c => (
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
        </View>
      </View>
    </Modal>
  );
}
