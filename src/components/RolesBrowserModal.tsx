import React, { useState } from 'react';
import { Modal, View, Text, TouchableOpacity, SafeAreaView, StyleSheet } from 'react-native';
import RolesBrowser, { type SortMode } from './RolesBrowser';

type Props = {
  visible: boolean;
  onClose: () => void;
};

export default function RolesBrowserModal({ visible, onClose }: Props) {
  const [sortMode, setSortMode] = useState<SortMode>('alpha');

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
          <Text style={styles.title}>Roles</Text>
          <TouchableOpacity
            style={styles.sortBtn}
            onPress={() => setSortMode(m => (m === 'alpha' ? 'value' : 'alpha'))}
          >
            <Text style={styles.sortBtnText}>{sortMode === 'alpha' ? 'A–Z' : '+/−'}</Text>
          </TouchableOpacity>
        </View>
        <RolesBrowser sortMode={sortMode} />
      </SafeAreaView>
    </Modal>
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
    paddingTop: 12,
    paddingBottom: 12,
  },
  closeBtn: {
    width: 60,
  },
  closeText: {
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
});
