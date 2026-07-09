import React, { useMemo, useState } from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  Pressable,
  StyleSheet,
  Dimensions,
} from 'react-native';
import { ROLES, roleSortKey, type Role, type RoleCategory } from '../data/roles';
import { getRoleValue } from '../data/roleValues';
import RoleCard from './RoleCard';
import HintedScrollView from './HintedScrollView';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

const CATEGORY_RANK: Record<RoleCategory, number> = {
  villagers: 0,
  wolves: 1,
  teamwolf: 2,
  solo: 3,
};

type Props = {
  visible: boolean;
  onClose: () => void;
  selectedRoles: string[];
};

type Entry = { role: Role; count: number };

/**
 * The BUILD panel — a centered pop-up (NOT a full-screen takeover) listing the
 * roles in the current game as name × quantity rows. Each row has a "View Card"
 * button that opens the full RoleCard overlay. Close sits top-left, the point
 * balance top-right. Tapping the dim backdrop also closes it.
 */
export default function BuildModal({ visible, onClose, selectedRoles }: Props) {
  const [enlarged, setEnlarged] = useState<Role | null>(null);

  const { entries, balance } = useMemo(() => {
    const counts = new Map<string, number>();
    let bal = 0;
    for (const name of selectedRoles) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
      bal += getRoleValue(name);
    }
    const list: Entry[] = [];
    for (const [name, count] of counts) {
      const role = ROLES.find(r => r.name === name);
      if (role) list.push({ role, count });
    }
    list.sort((a, b) => {
      const ra = CATEGORY_RANK[a.role.category];
      const rb = CATEGORY_RANK[b.role.category];
      return ra !== rb ? ra - rb : roleSortKey(a.role.name).localeCompare(roleSortKey(b.role.name));
    });
    return { entries: list, balance: bal };
  }, [selectedRoles]);

  const balanceColor =
    balance > 0 ? '#4caf50' : balance < 0 ? '#ef5350' : '#8A8590';

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
            <Text style={styles.title}>BUILD</Text>
            <View style={styles.balancePill}>
              <Text style={[styles.balanceText, { color: balanceColor }]}>
                {balance > 0 ? `+${balance}` : balance}
              </Text>
            </View>
          </View>

          <HintedScrollView
            style={styles.list}
            contentContainerStyle={styles.listContent}
            showsVerticalScrollIndicator={false}
          >
            {entries.map(({ role, count }) => (
              <View key={role.name} style={styles.row}>
                <View style={styles.rowLeft}>
                  <Text style={styles.roleName} numberOfLines={1}>
                    {role.name}
                  </Text>
                  <View style={styles.qtyChip}>
                    <Text style={styles.qtyChipText}>×{count}</Text>
                  </View>
                </View>
                <TouchableOpacity
                  onPress={() => setEnlarged(role)}
                  style={styles.viewBtn}
                  hitSlop={6}
                >
                  <Text style={styles.viewBtnText}>View Card</Text>
                </TouchableOpacity>
              </View>
            ))}
          </HintedScrollView>
        </Pressable>
      </Pressable>

      <Modal
        visible={!!enlarged}
        transparent
        animationType="fade"
        onRequestClose={() => setEnlarged(null)}
      >
        {enlarged && (
          <Pressable
            style={styles.enlargeOverlay}
            onPress={() => setEnlarged(null)}
          >
            <Pressable onPress={e => e.stopPropagation()}>
              <RoleCard role={enlarged.name} width={SCREEN_WIDTH * 0.82} />
            </Pressable>
          </Pressable>
        )}
      </Modal>
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
  balancePill: {
    width: 60,
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  balanceText: {
    fontSize: 16,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  // Cap the scroll area directly (the panel's maxHeight is only a safety net)
  // so the list bounds and scrolls itself — matching HintedScrollView's proven
  // usage in TimersConfigModal.
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
  rowLeft: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minWidth: 0,
  },
  roleName: {
    color: '#F0EDE8',
    fontSize: 16,
    fontWeight: '600',
    flexShrink: 1,
  },
  qtyChip: {
    borderWidth: 1,
    borderColor: '#D4A017',
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  qtyChipText: {
    color: '#D4A017',
    fontSize: 12,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  viewBtn: {
    backgroundColor: '#3A3A47',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#4A4A58',
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  viewBtnText: {
    color: '#F0EDE8',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 1,
  },
  enlargeOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.88)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
