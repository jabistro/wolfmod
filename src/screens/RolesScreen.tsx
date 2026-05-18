import React, { useState } from 'react';
import { View, Text, TouchableOpacity, SafeAreaView, StyleSheet } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import RolesBrowser, { type SortMode } from '../components/RolesBrowser';

export default function RolesScreen() {
  const navigation = useNavigation();
  const [sortMode, setSortMode] = useState<SortMode>('alpha');

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Text style={styles.backText}>‹ Back</Text>
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
});
