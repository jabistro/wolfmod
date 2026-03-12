import React, { useRef, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  Image,
  TouchableOpacity,
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
const SORTED_ROLES = CATEGORIES.map(cat =>
  ROLES.filter(r => r.category === cat.key).sort((a, b) => a.name.localeCompare(b.name))
);

export default function RolesScreen() {
  const navigation = useNavigation();
  const [activeIndex, setActiveIndex] = useState(0);
  const [selectedRole, setSelectedRole] = useState<Role | null>(null);
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
        <View style={styles.headerSpacer} />
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
                data={SORTED_ROLES[i]}
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
                      onPress={() => setSelectedRole(item)}
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
                      <Text style={styles.cardName} numberOfLines={2}>{item.name}</Text>
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
        visible={!!selectedRole}
        transparent
        animationType="fade"
        onRequestClose={() => setSelectedRole(null)}
      >
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPress={() => setSelectedRole(null)}
        >
          {selectedRole && (
            <View style={styles.modalCard}>
              <View style={styles.modalImageWrapper}>
                <Image
                  source={selectedRole.image}
                  style={styles.modalImage}
                  resizeMode="cover"
                />
              </View>
              <Text style={styles.modalName}>{selectedRole.name}</Text>
            </View>
          )}
        </TouchableOpacity>
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
  headerSpacer: {
    width: 60,
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
  cardName: {
    color: '#F0EDE8',
    fontSize: 10,
    textAlign: 'center',
    marginTop: 4,
    lineHeight: 13,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.88)',
    justifyContent: 'center',
    alignItems: 'center',
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
  modalName: {
    color: '#F0EDE8',
    fontSize: 22,
    fontWeight: '600',
    textAlign: 'center',
    marginTop: 18,
  },
});
