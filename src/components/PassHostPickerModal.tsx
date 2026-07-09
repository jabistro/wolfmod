import React, { useState } from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  Pressable,
  ActivityIndicator,
  StyleSheet,
  Dimensions,
} from 'react-native';
import { useMutation } from 'convex/react';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import { showAlert } from './ThemedAlert';
import HintedScrollView from './HintedScrollView';

const { height: SCREEN_HEIGHT } = Dimensions.get('window');

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

/**
 * Pass-host picker — a centered pop-up (matching BUILD / GRAVEYARD) that lists
 * the other players as tap-to-pass rows. Tapping the dim backdrop closes it.
 */
export default function PassHostPickerModal({
  visible,
  onClose,
  gameId,
  deviceClientId,
  candidates,
  onPassed,
}: Props) {
  const passHost = useMutation(api.games.passHost);
  const [passing, setPassing] = useState<Id<'players'> | null>(null);

  function confirmPass(target: Candidate) {
    showAlert(
      'Pass host?',
      `${target.name} becomes the host and takes over moderating. You can't take it back — you'd have to ask them to pass it to you.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Pass Host', onPress: () => handlePass(target) },
      ],
    );
  }

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
      animationType="fade"
      presentationStyle="overFullScreen"
      transparent
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.panel} onPress={e => e.stopPropagation()}>
          <View style={styles.header}>
            <TouchableOpacity onPress={onClose} style={styles.closeBtn} hitSlop={12}>
              <Text style={styles.closeText}>Close</Text>
            </TouchableOpacity>
            <Text style={styles.title}>PASS HOST</Text>
            <View style={styles.closeBtn} />
          </View>

          <HintedScrollView
            style={styles.list}
            contentContainerStyle={styles.listContent}
            showsVerticalScrollIndicator={false}
          >
            {candidates.length === 0 ? (
              <Text style={styles.emptyText}>
                No other players to pass host to.
              </Text>
            ) : (
              candidates.map(c => (
                <TouchableOpacity
                  key={c._id}
                  onPress={() => confirmPass(c)}
                  disabled={passing !== null}
                  style={[
                    styles.row,
                    { opacity: passing && passing !== c._id ? 0.4 : 1 },
                  ]}
                >
                  <Text style={styles.rowName} numberOfLines={1}>
                    {c.name}
                  </Text>
                  {passing === c._id ? (
                    <ActivityIndicator color="#D4A017" />
                  ) : (
                    <Text style={styles.chevron}>›</Text>
                  )}
                </TouchableOpacity>
              ))
            )}
          </HintedScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  panel: {
    width: '100%',
    maxWidth: 420,
    maxHeight: SCREEN_HEIGHT * 0.75,
    backgroundColor: '#1A1A24',
    borderRadius: 24,
    borderWidth: 1,
    borderColor: '#2C2C3A',
    paddingBottom: 8,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#2C2C3A',
  },
  closeBtn: { width: 60 },
  closeText: { color: '#F0EDE8', fontSize: 16 },
  title: {
    flex: 1,
    color: '#F0EDE8',
    fontSize: 20,
    fontWeight: 'bold',
    textAlign: 'center',
    letterSpacing: 2,
  },
  list: { maxHeight: SCREEN_HEIGHT * 0.62 },
  listContent: { paddingHorizontal: 16, paddingVertical: 6 },
  emptyText: {
    color: '#8A8590',
    fontSize: 14,
    textAlign: 'center',
    paddingVertical: 24,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#3A3A47',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 16,
    marginVertical: 4,
    gap: 12,
  },
  rowName: {
    flex: 1,
    color: '#F0EDE8',
    fontSize: 16,
    minWidth: 0,
  },
  chevron: { color: '#8A8590', fontSize: 16 },
});
