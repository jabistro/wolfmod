import React, { useState } from 'react';
import {
  Modal,
  ScrollView,
  View,
  Text,
  TouchableOpacity,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import RoleCard from './RoleCard';
import { SCENE_TEXT_SHADOW, HUD_CHROME } from '../theme/hud';

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

function GraveyardModal({
  visible,
  onClose,
  entries,
}: {
  visible: boolean;
  onClose: () => void;
  entries: Entry[];
}) {
  const insets = useSafeAreaInsets();
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
          style={{ paddingBottom: Math.max(insets.bottom, 16) + 8, maxHeight: '85%' }}
        >
          <View className="flex-row items-center px-6 py-4 border-b border-wolf-card">
            <View className="w-16" />
            <Text className="flex-1 text-wolf-text text-base font-bold text-center tracking-widest">
              GRAVEYARD
            </Text>
            <TouchableOpacity onPress={onClose} className="w-16 items-end">
              <Text className="text-wolf-accent font-bold">Done</Text>
            </TouchableOpacity>
          </View>

          <ScrollView
            contentContainerStyle={{
              paddingHorizontal: 16,
              paddingVertical: 18,
              flexDirection: 'row',
              flexWrap: 'wrap',
              justifyContent: 'center',
              gap: 16,
            }}
          >
            {entries.map(e => (
              <View key={e._id} className="items-center" style={{ gap: 6 }}>
                <View className="flex-row items-center" style={{ gap: 6 }}>
                  <Text className="text-wolf-text text-sm font-bold tracking-wider">
                    {e.name.toUpperCase()}
                  </Text>
                  {e.label ? (
                    <Text className="text-wolf-muted text-xs font-bold tracking-widest">
                      ({e.label})
                    </Text>
                  ) : null}
                </View>
                <RoleCard
                  role={e.role}
                  width={162}
                  imageHeight={168}
                  badgeSize={20}
                  evenFrame
                  hideDescription
                />
              </View>
            ))}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
