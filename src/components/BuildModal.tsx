import React, { useMemo, useState } from 'react';
import {
  Modal,
  View,
  Text,
  Image,
  FlatList,
  TouchableOpacity,
  Pressable,
  StyleSheet,
  Dimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ROLES, CATEGORIES, roleSortKey, type Role, type RoleCategory } from '../data/roles';
import { getRoleValue } from '../data/roleValues';
import RoleCard from './RoleCard';
import { getDisplayArt } from '../data/themeArt';
import { useTheme } from '../contexts/ThemeContext';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const COLUMNS = 3;
const H_PADDING = 12;
const GAP = 8;
// The unbuffered (W - 40) / 3 leaves exactly 0px of slack after 3 cards + 2
// gaps + container padding. Subpixel rounding then tips one row over the edge
// on some devices (seen on Galaxy S20 Ultra → wraps to 2 cols). The −2 buffer
// per card reserves ~6px of total row slack so the layout stays at 3 columns.
const CARD_WIDTH =
  Math.floor((SCREEN_WIDTH - H_PADDING * 2 - GAP * (COLUMNS - 1)) / COLUMNS) -
  2;
const CARD_HEIGHT = Math.floor(CARD_WIDTH * 1.4);

const CATEGORY_RANK: Record<RoleCategory, number> = {
  villagers: 0,
  wolves: 1,
  teamwolf: 2,
  solo: 3,
};

function getBarColors(role: Role): string[] {
  if (role.barColors) return role.barColors;
  return [CATEGORIES.find(c => c.key === role.category)!.color];
}

type Props = {
  visible: boolean;
  onClose: () => void;
  selectedRoles: string[];
};

type Entry = { role: Role; count: number };

export default function BuildModal({ visible, onClose, selectedRoles }: Props) {
  const { theme } = useTheme();
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
      animationType="slide"
      presentationStyle="overFullScreen"
      transparent={false}
      onRequestClose={onClose}
    >
      <SafeAreaView style={styles.container}>
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

        <FlatList
          data={entries}
          keyExtractor={item => item.role.name}
          numColumns={COLUMNS}
          contentContainerStyle={styles.grid}
          columnWrapperStyle={styles.row}
          renderItem={({ item: { role, count } }) => {
            const colors = getBarColors(role);
            const val = getRoleValue(role.name);
            const valBg =
              val > 0 ? '#1a4a1a' : val < 0 ? '#4a1a1a' : '#2a2a2a';
            const valColor =
              val > 0 ? '#4caf50' : val < 0 ? '#ef5350' : '#8A8590';
            return (
              <TouchableOpacity
                onPress={() => setEnlarged(role)}
                style={styles.card}
              >
                <View>
                  <Image
                    source={getDisplayArt(role.name, theme).thumb}
                    style={styles.cardImage}
                    resizeMode="cover"
                  />
                  {count > 1 && (
                    <View style={styles.countChip}>
                      <Text style={styles.countChipText}>×{count}</Text>
                    </View>
                  )}
                </View>
                {colors.length === 1 ? (
                  <View
                    style={[styles.colorBar, { backgroundColor: colors[0] }]}
                  />
                ) : (
                  <View style={styles.colorBar}>
                    <View
                      style={{
                        flex: 1,
                        backgroundColor: colors[0],
                        borderBottomLeftRadius: 4,
                      }}
                    />
                    <View
                      style={{
                        flex: 1,
                        backgroundColor: colors[1],
                        borderBottomRightRadius: 4,
                      }}
                    />
                  </View>
                )}
                <View style={styles.cardFooter}>
                  <Text style={styles.cardName} numberOfLines={2}>
                    {role.name}
                  </Text>
                  <View style={[styles.valueBadge, { backgroundColor: valBg }]}>
                    <Text style={[styles.valueBadgeText, { color: valColor }]}>
                      {val > 0 ? `+${val}` : `${val}`}
                    </Text>
                  </View>
                </View>
              </TouchableOpacity>
            );
          }}
        />

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
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0F0F14' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 12,
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
  grid: {
    paddingHorizontal: H_PADDING,
    paddingTop: 4,
    paddingBottom: 24,
  },
  row: {
    gap: GAP,
    marginBottom: 16,
  },
  card: { width: CARD_WIDTH },
  cardImage: { width: CARD_WIDTH, height: CARD_HEIGHT, borderRadius: 6 },
  countChip: {
    position: 'absolute',
    top: 4,
    right: 4,
    backgroundColor: 'rgba(15,15,20,0.85)',
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderWidth: 1,
    borderColor: '#D4A017',
  },
  countChipText: {
    color: '#D4A017',
    fontSize: 11,
    fontWeight: '700',
  },
  colorBar: {
    height: 5,
    flexDirection: 'row',
    borderBottomLeftRadius: 4,
    borderBottomRightRadius: 4,
    overflow: 'hidden',
  },
  cardFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
    gap: 4,
  },
  cardName: {
    color: '#F0EDE8',
    fontSize: 10,
    textAlign: 'center',
    lineHeight: 13,
    flexShrink: 1,
  },
  valueBadge: { borderRadius: 3, paddingHorizontal: 3, paddingVertical: 1 },
  valueBadgeText: { fontSize: 9, fontWeight: '700' },
  enlargeOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.88)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
