import React from 'react';
import { View, Text, Image, StyleSheet } from 'react-native';
import { ROLES, CATEGORIES, type Role } from '../data/roles';
import { getRoleValue } from '../data/roleValues';
import { getRoleDescription } from '../data/roleDescriptions';

function getTeamColor(role: Role): string {
  if (role.barColors && role.barColors.length > 0) return role.barColors[0];
  return CATEGORIES.find(c => c.key === role.category)!.color;
}

type Props = {
  role: string;
  width?: number;
};

export default function RoleCard({ role, width = 280 }: Props) {
  const roleData = ROLES.find(r => r.name === role);
  if (!roleData) return null;

  const value = getRoleValue(role);
  const teamColor = getTeamColor(roleData);
  const description = getRoleDescription(role);
  const valueText = value > 0 ? `+${value}` : `${value}`;
  const imageHeight = width * (4 / 3);

  return (
    <View style={[styles.card, { width }]}>
      <View style={styles.header}>
        <View style={[styles.valueBadge, { backgroundColor: teamColor }]}>
          <Text style={styles.valueText}>{valueText}</Text>
        </View>
        <Text style={styles.name} numberOfLines={1}>
          {role.toUpperCase()}
        </Text>
        <View style={styles.headerSpacer} />
      </View>
      <Image
        source={roleData.image}
        style={{ width, height: imageHeight }}
        resizeMode="cover"
      />
      {description.length > 0 && (
        <View style={styles.descPanel}>
          <Text style={styles.descText}>{description}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#1A1A24',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#22222F',
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 10,
    gap: 10,
    backgroundColor: '#0F0F14',
  },
  valueBadge: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  valueText: {
    color: '#F0EDE8',
    fontSize: 14,
    fontWeight: '800',
  },
  name: {
    flex: 1,
    color: '#F0EDE8',
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 1,
    textAlign: 'center',
  },
  headerSpacer: {
    width: 36,
  },
  descPanel: {
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  descText: {
    color: '#F0EDE8',
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'center',
  },
});
