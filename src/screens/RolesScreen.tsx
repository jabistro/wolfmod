import React, { useRef, useState, useMemo } from 'react';
import {
  View,
  Text,
  FlatList,
  Image,
  TouchableOpacity,
  Pressable,
  Modal,
  SafeAreaView,
  ScrollView,
  Dimensions,
  StyleSheet,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { ROLES, CATEGORIES, type RoleCategory, type Role } from '../data/roles';
import { getRoleValue } from '../data/roleValues';

function getBarColors(role: Role): string[] {
  if (role.barColors) return role.barColors;
  return [CATEGORIES.find(c => c.key === role.category)!.color];
}

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const COLUMNS = 3;
const H_PADDING = 12;
const GAP = 8;
const CARD_WIDTH = (SCREEN_WIDTH - H_PADDING * 2 - GAP * (COLUMNS - 1)) / COLUMNS;
const CARD_HEIGHT = CARD_WIDTH * 1.4;

// Pre-sort role lists once at module level
const sortedRoles = CATEGORIES.map(cat =>
  ROLES.filter(r => r.category === cat.key).sort((a, b) => a.name.localeCompare(b.name))
);

export default function RolesScreen() {
  const navigation = useNavigation();
  const [activeIndex, setActiveIndex] = useState(0);
  const [sortMode, setSortMode] = useState<'alpha' | 'value'>('alpha');
  const [modalRoleList, setModalRoleList] = useState<Role[] | null>(null);
  const [modalIndex, setModalIndex] = useState(0);
  const modalFlatListRef = useRef<FlatList<Role>>(null);

  const sortedRoles = useMemo(() =>
    CATEGORIES.map(cat => {
      const roles = ROLES.filter(r => r.category === cat.key);
      if (sortMode === 'alpha') {
        return roles.sort((a, b) => a.name.localeCompare(b.name));
      }
      const isWolfTab = cat.key === 'wolves' || cat.key === 'teamwolf';
      return roles.sort((a, b) => {
        const valA = getRoleValue(a.name);
        const valB = getRoleValue(b.name);
        const diff = isWolfTab ? valA - valB : valB - valA;
        return diff !== 0 ? diff : a.name.localeCompare(b.name);
      });
    }),
  [sortMode]);
  // Track which pages have been rendered so they stay mounted once visited
  const [renderedPages, setRenderedPages] = useState(() => new Set([0]));
  const scrollRef = useRef<ScrollView>(null);
  const isProgrammaticScroll = useRef(false);
  const isNavigatingBack = useRef(false);

  function preloadAdjacent(index: number) {
    setRenderedPages(prev => {
      const next = new Set(prev);
      if (index > 0) next.add(index - 1);
      next.add(index);
      if (index < CATEGORIES.length - 1) next.add(index + 1);
      return next;
    });
  }

  function handleTabPress(index: number) {
    isProgrammaticScroll.current = true;
    preloadAdjacent(index);
    setActiveIndex(index);
    scrollRef.current?.scrollTo({ x: index * SCREEN_WIDTH, animated: true });
  }

  function handleScroll(e: NativeSyntheticEvent<NativeScrollEvent>) {
    if (isProgrammaticScroll.current || isNavigatingBack.current) return;
    const index = Math.round(e.nativeEvent.contentOffset.x / SCREEN_WIDTH);
    if (index !== activeIndex) {
      setActiveIndex(index);
      preloadAdjacent(index);
    }
  }

  function handleMomentumScrollEnd(e: NativeSyntheticEvent<NativeScrollEvent>) {
    isProgrammaticScroll.current = false;
    const index = Math.round(e.nativeEvent.contentOffset.x / SCREEN_WIDTH);
    preloadAdjacent(index);
  }

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => { isNavigatingBack.current = true; navigation.goBack(); }} style={styles.backBtn}>
          <Text style={styles.backText}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Roles</Text>
        <TouchableOpacity style={styles.sortBtn} onPress={() => setSortMode(m => m === 'alpha' ? 'value' : 'alpha')}>
          <Text style={styles.sortBtnText}>{sortMode === 'alpha' ? 'A–Z' : '+/−'}</Text>
        </TouchableOpacity>
      </View>

      {/* Tabs */}
      <View style={styles.tabRow}>
        {CATEGORIES.map((cat, i) => (
          <TouchableOpacity
            key={cat.key}
            onPress={() => handleTabPress(i)}
            style={[
              styles.tab,
              { backgroundColor: activeIndex === i ? cat.color : '#2A2A38' },
            ]}
          >
            {cat.key === 'solo' && activeIndex === i && (
              <>
                <View style={[styles.soloStripe, { left: 0 }]}>
                  <View style={{ flex: 1, backgroundColor: '#4A90D9' }} />
                  <View style={{ flex: 1, backgroundColor: '#C05050' }} />
                </View>
                <View style={[styles.soloStripe, { right: 0 }]}>
                  <View style={{ flex: 1, backgroundColor: '#4A90D9' }} />
                  <View style={{ flex: 1, backgroundColor: '#8B1818' }} />
                </View>
              </>
            )}
            <Text style={styles.tabLabel}>{cat.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Paged Grids */}
      <ScrollView
        ref={scrollRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onScroll={handleScroll}
        onMomentumScrollEnd={handleMomentumScrollEnd}
        scrollEventThrottle={16}
        style={styles.pager}
      >
        {CATEGORIES.map((cat, i) => (
          <View key={cat.key} style={styles.page}>
            {renderedPages.has(i) && (
              <FlatList
                data={sortedRoles[i]}
                keyExtractor={item => item.name}
                numColumns={COLUMNS}
                contentContainerStyle={styles.grid}
                initialNumToRender={12}
                maxToRenderPerBatch={12}
                windowSize={5}
                removeClippedSubviews
                renderItem={({ item, index }) => {
                  const col = index % COLUMNS;
                  return (
                    <TouchableOpacity
                      onPress={() => {
                        setModalIndex(index);
                        setModalRoleList(sortedRoles[i]);
                      }}
                      style={[styles.card, { marginLeft: col === 0 ? 0 : GAP }]}
                    >
                      <Image source={item.thumb} style={styles.cardImage} resizeMode="cover" />
                      {(() => {
                        const colors = getBarColors(item);
                        if (colors.length === 1) {
                          return <View style={[styles.colorBar, { backgroundColor: colors[0] }]} />;
                        }
                        return (
                          <View style={styles.colorBar}>
                            <View style={{ flex: 1, backgroundColor: colors[0], borderBottomLeftRadius: 4 }} />
                            <View style={{ flex: 1, backgroundColor: colors[1], borderBottomRightRadius: 4 }} />
                          </View>
                        );
                      })()}
                      <View style={styles.cardFooter}>
                        <Text style={styles.cardName} numberOfLines={2}>{item.name}</Text>
                        {(() => {
                          const val = getRoleValue(item.name);
                          const bg = val > 0 ? '#1a4a1a' : val < 0 ? '#4a1a1a' : '#2a2a2a';
                          const color = val > 0 ? '#4caf50' : val < 0 ? '#ef5350' : '#8A8590';
                          return (
                            <View style={[styles.valueBadge, { backgroundColor: bg }]}>
                              <Text style={[styles.valueBadgeText, { color }]}>
                                {val > 0 ? `+${val}` : `${val}`}
                              </Text>
                            </View>
                          );
                        })()}
                      </View>
                    </TouchableOpacity>
                  );
                }}
              />
            )}
          </View>
        ))}
      </ScrollView>

      {/* Detail Modal */}
      <Modal
        visible={!!modalRoleList}
        transparent
        animationType="fade"
        onRequestClose={() => setModalRoleList(null)}
      >
        <View style={styles.modalOverlay}>
          <FlatList
            ref={modalFlatListRef}
            data={modalRoleList ?? []}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            keyExtractor={item => item.name}
            initialScrollIndex={modalIndex}
            getItemLayout={(_, index) => ({
              length: SCREEN_WIDTH,
              offset: SCREEN_WIDTH * index,
              index,
            })}
            onMomentumScrollEnd={e => {
              const i = Math.round(e.nativeEvent.contentOffset.x / SCREEN_WIDTH);
              setModalIndex(i);
            }}
            renderItem={({ item }) => {
              const val = getRoleValue(item.name);
              const bg = val > 0 ? '#1a4a1a' : val < 0 ? '#4a1a1a' : '#2a2a2a';
              const color = val > 0 ? '#4caf50' : val < 0 ? '#ef5350' : '#8A8590';
              return (
                <Pressable
                  style={styles.modalPage}
                  onPress={() => setModalRoleList(null)}
                >
                  <Pressable style={styles.modalCard} onPress={e => e.stopPropagation()}>
                    <View style={styles.modalImageWrapper}>
                      <Image source={item.image} style={styles.modalImage} resizeMode="cover" />
                    </View>
                    <View style={styles.modalNameRow}>
                      <Text style={styles.modalName}>{item.name}</Text>
                      <View style={[styles.valueBadge, { backgroundColor: bg }]}>
                        <Text style={[styles.modalValueText, { color }]}>
                          {val > 0 ? `+${val}` : `${val}`}
                        </Text>
                      </View>
                    </View>
                  </Pressable>
                </Pressable>
              );
            }}
          />
        </View>
      </Modal>
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
  sortBtn: {
    width: 60,
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  sortBtnText: {
    color: '#D4A017',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 1,
  },
  tabRow: {
    flexDirection: 'row',
    paddingHorizontal: H_PADDING,
    gap: 6,
    marginBottom: 12,
  },
  tab: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  soloStripe: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 4,
    flexDirection: 'column',
  },
  tabLabel: {
    color: '#F0EDE8',
    fontSize: 11,
    fontWeight: '600',
  },
  pager: {
    flex: 1,
  },
  page: {
    width: SCREEN_WIDTH,
    flex: 1,
  },
  grid: {
    paddingHorizontal: H_PADDING,
    paddingBottom: 24,
  },
  card: {
    width: CARD_WIDTH,
    marginBottom: 16,
  },
  cardImage: {
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    borderRadius: 6,
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
  valueBadge: {
    borderRadius: 3,
    paddingHorizontal: 3,
    paddingVertical: 1,
  },
  valueBadgeText: {
    fontSize: 9,
    fontWeight: '700',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.88)',
  },
  modalPage: {
    width: SCREEN_WIDTH,
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalCard: {
    alignItems: 'center',
  },
  modalImageWrapper: {
    width: SCREEN_WIDTH * 0.82,
    height: SCREEN_WIDTH * 0.82 * 1.4,
    borderRadius: 16,
    overflow: 'hidden',
  },
  modalImage: {
    width: '100%',
    height: '100%',
  },
  modalNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 18,
    gap: 8,
  },
  modalName: {
    color: '#F0EDE8',
    fontSize: 22,
    fontWeight: '600',
    textAlign: 'center',
  },
  modalValueText: {
    fontSize: 14,
    fontWeight: '700',
  },
});
