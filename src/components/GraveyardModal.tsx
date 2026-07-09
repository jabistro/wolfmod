import React, { useState } from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  Pressable,
  StyleSheet,
  Dimensions,
} from 'react-native';
import { useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import HintedScrollView from './HintedScrollView';
import { SCENE_TEXT_SHADOW, HUD_CHROME } from '../theme/hud';

const { height: SCREEN_HEIGHT } = Dimensions.get('window');

type Entry = {
  _id: Id<'players'>;
  name: string;
  seatPosition?: number;
  role: string;
  phase: 'day' | 'night';
  label: string | null;
};

/**
 * Header entry point for the graveyard (the role-reveal variant's persistent
 * record of revealed dead). Self-contained: subscribes to graveyardView, which
 * returns ONLY players whose role has been revealed under the active toggles
 * (per-death gated server-side). Renders nothing until there's at least one
 * revealed player — so it stays invisible in a standard hidden-role game and
 * appears the moment the first reveal lands.
 */
export default function GraveyardButton({
  gameId,
  style,
}: {
  gameId: Id<'games'>;
  /** Layout override — parent positions this inline (right of the BUILD icon
   *  in DayHeader's top-left cluster). */
  style?: object;
}) {
  const [open, setOpen] = useState(false);
  const view = useQuery(api.games.graveyardView, { gameId });
  const entries = (view?.entries ?? []) as Entry[];
  if (entries.length === 0) return null;

  return (
    <>
      <TouchableOpacity
        onPress={() => setOpen(true)}
        hitSlop={8}
        style={{
          padding: 8,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 4,
          ...style,
        }}
      >
        <Text style={{ fontSize: 24, ...SCENE_TEXT_SHADOW }}>⚰️</Text>
        <Text
          style={{ color: HUD_CHROME, fontSize: 16, fontWeight: '800', letterSpacing: 2, ...SCENE_TEXT_SHADOW }}
        >
          {entries.length}
        </Text>
      </TouchableOpacity>
      <GraveyardModal
        visible={open}
        onClose={() => setOpen(false)}
        entries={entries}
      />
    </>
  );
}

/**
 * The GRAVEYARD panel — a centered pop-up (matching BuildModal), listing the
 * revealed dead as Name → Role rows. No time-of-death: a real-table moderator
 * just states who was what role on death, not which day they died. Close sits
 * top-left; tapping the dim backdrop also closes it.
 */
function GraveyardModal({
  visible,
  onClose,
  entries,
}: {
  visible: boolean;
  onClose: () => void;
  entries: Entry[];
}) {
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
            <Text style={styles.title}>GRAVEYARD</Text>
            <View style={styles.closeBtn} />
          </View>

          <HintedScrollView
            style={styles.list}
            contentContainerStyle={styles.listContent}
            showsVerticalScrollIndicator={false}
          >
            {entries.map(e => (
              <View key={e._id} style={styles.row}>
                <Text style={styles.name} numberOfLines={1}>
                  {e.name}
                </Text>
                <Text style={styles.role} numberOfLines={1}>
                  {e.role}
                </Text>
              </View>
            ))}
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
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#24242F',
    gap: 12,
  },
  name: {
    color: '#F0EDE8',
    fontSize: 16,
    fontWeight: '600',
    flexShrink: 1,
    minWidth: 0,
  },
  role: {
    color: '#D4A017',
    fontSize: 15,
    fontWeight: '700',
    flexShrink: 1,
    textAlign: 'right',
  },
});
