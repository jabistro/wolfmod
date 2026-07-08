import React from 'react';
import { View, Text, Image, StyleSheet } from 'react-native';
import { ROLES, CATEGORIES, type Role } from '../data/roles';
import { getDisplayArt } from '../data/themeArt';
import { useTheme } from '../contexts/ThemeContext';
import { getRoleValue } from '../data/roleValues';
import { getRoleDescription } from '../data/roleDescriptions';

function getTeamColor(role: Role): string {
  if (role.barColors && role.barColors.length > 0) return role.barColors[0];
  return CATEGORIES.find(c => c.key === role.category)!.color;
}

type Props = {
  role: string;
  width?: number;
  // When set, the card renders in compact mode: the portrait is capped at this
  // height (keeping its 3:4 aspect) and centered in a dark matte frame, with a
  // smaller value badge and description text. The card stays wide so the
  // description wraps in fewer lines — this keeps the overall card SHORT.
  // Used on RoleReveal so a long teammate list isn't pushed off-screen.
  imageHeight?: number;
  // Drop the description panel entirely (e.g. the graveyard, where only the
  // identity matters and the rules text is noise).
  hideDescription?: boolean;
  // Override the value-badge diameter (compact cards default to 28). The
  // graveyard wants a much smaller circle so the art reads as the focus.
  badgeSize?: number;
  // Compact only: pad the matte beneath the portrait by the same amount of
  // black space the matte leaves on each side, so the art sits in an evenly
  // framed box (top-aligned). Used by the graveyard.
  evenFrame?: boolean;
};

export default function RoleCard({
  role,
  width = 280,
  imageHeight: imageHeightProp,
  hideDescription = false,
  badgeSize: badgeSizeProp,
  evenFrame = false,
}: Props) {
  const { theme } = useTheme();
  const roleData = ROLES.find(r => r.name === role);
  if (!roleData) return null;

  const value = getRoleValue(role);
  const teamColor = getTeamColor(roleData);
  const description = getRoleDescription(role);
  const valueText = value > 0 ? `+${value}` : `${value}`;

  const compact = imageHeightProp !== undefined;
  const imageHeight = imageHeightProp ?? width * (4 / 3);
  // In compact mode the portrait keeps its native 3:4 aspect at the capped
  // height; the card is wider than the art so a dark matte fills the sides.
  const imageWidth = compact ? Math.round(imageHeight * (3 / 4)) : width;

  // Shrink the value badge + description alongside the card.
  const badgeSize = badgeSizeProp ?? (compact ? 28 : 36);
  const badgeFont = badgeSizeProp
    ? Math.max(9, Math.round(badgeSizeProp * 0.5))
    : compact
      ? 12
      : 14;
  // Side matte each side of the portrait; mirror it beneath when evenFrame.
  const sideMatte = compact ? Math.max(0, Math.round((width - imageWidth) / 2)) : 0;
  const matteHeight = compact ? imageHeight + (evenFrame ? sideMatte : 0) : imageHeight;
  // The 16bit pixel font renders much taller per glyph, so its description text
  // grows the card enough to force scrolling on the Themes picker. Shrink the
  // description font (and line-height) for that deck only.
  const is16bit = theme === '16bit';
  const descFontSize = (compact ? 12 : 13) * (is16bit ? 0.8 : 1);
  const descLineHeight = (compact ? 16 : 18) * (is16bit ? 0.8 : 1);
  const descPadV = compact ? 8 : 10;

  // Narrow cards need a smaller name font so single-word roles like "WEREWOLF"
  // fit on one line. Multi-word names wrap to two lines naturally at the space;
  // single-word names lock to one line with auto-shrink so a long name like
  // "DOPPELGANGER" doesn't break mid-word in the header.
  const isNarrow = width < 220;
  const nameFontSize = isNarrow ? 14 : 16;
  const nameLetterSpacing = isNarrow ? 0.5 : 1;
  const isMultiWord = role.includes(' ');

  return (
    <View style={[styles.card, { width }]}>
      <View style={styles.header}>
        <View
          style={[
            styles.valueBadge,
            { backgroundColor: teamColor, width: badgeSize, height: badgeSize, borderRadius: badgeSize / 2 },
          ]}
        >
          <Text style={[styles.valueText, { fontSize: badgeFont }]}>{valueText}</Text>
        </View>
        <Text
          numberOfLines={isMultiWord ? 2 : 1}
          adjustsFontSizeToFit
          minimumFontScale={0.7}
          style={[
            styles.name,
            { fontSize: nameFontSize, letterSpacing: nameLetterSpacing },
          ]}
        >
          {role.toUpperCase()}
        </Text>
        <View style={{ width: badgeSize }} />
      </View>
      {compact ? (
        <View
          style={{
            width,
            height: matteHeight,
            backgroundColor: '#0F0F14',
            alignItems: 'center',
            justifyContent: evenFrame ? 'flex-start' : 'center',
          }}
        >
          <Image
            source={getDisplayArt(role, theme).image}
            style={{ width: imageWidth, height: imageHeight }}
            resizeMode="cover"
          />
        </View>
      ) : (
        <Image
          source={getDisplayArt(role, theme).image}
          style={{ width, height: imageHeight }}
          resizeMode="cover"
        />
      )}
      {!hideDescription && description.length > 0 && (
        <View style={[styles.descPanel, { paddingVertical: descPadV }]}>
          <Text style={[styles.descText, { fontSize: descFontSize, lineHeight: descLineHeight }]}>
            {description}
          </Text>
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
    // The pixel font rides high in a tall line box; kill Android's font padding
    // and center on both axes so the number sits dead-center in the circle.
    textAlign: 'center',
    textAlignVertical: 'center',
    includeFontPadding: false,
  },
  name: {
    flex: 1,
    color: '#F0EDE8',
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 1,
    textAlign: 'center',
  },
  descPanel: {
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  descText: {
    color: '#F0EDE8',
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'left',
  },
});
