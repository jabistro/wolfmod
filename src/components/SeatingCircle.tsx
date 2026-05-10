import React from 'react';
import { View, Text, TouchableOpacity, Dimensions } from 'react-native';
import type { Id } from '../../convex/_generated/dataModel';

export type SeatingPlayer = {
  _id: Id<'players'>;
  name: string;
  seatPosition?: number;
};

interface SeatingCircleProps {
  /**
   * The original game.playerCount. Layout always uses this so seat positions
   * stay stable as the game progresses — when a player is eliminated, their
   * seat just becomes a visual gap (mechanical neighbors are unchanged).
   */
  totalSeats: number;
  /** Currently visible (typically alive) players. Each must have seatPosition. */
  players: readonly SeatingPlayer[];
  /** Highlight the current player's seat in gold. */
  meId?: Id<'players'>;
  /** Highlight a selected/pending target. Trumps the meId highlight. */
  selectedId?: Id<'players'>;
  /**
   * Multi-select highlight (e.g., Mentalist's two picks). Each id in the
   * set gets the selected accent. Combined with `selectedId` if both are set.
   */
  selectedIds?: ReadonlySet<string>;
  /**
   * If provided, only seats in this set are tappable. Other seats render
   * dimmed and ignore taps. Useful for role-specific picker rules
   * (wolves can't kill wolves, BG can't repeat last protected, etc.).
   */
  selectableIds?: ReadonlySet<string>;
  /** Tap handler. If absent (or selectableIds excludes the tapped seat), tap is a no-op. */
  onPress?: (player: SeatingPlayer) => void;
  /** Override the default circle size; defaults to ~min(320, screen-32). */
  size?: number;
}

const SCREEN_WIDTH = Dimensions.get('window').width;
const DEFAULT_CIRCLE_SIZE = Math.min(320, SCREEN_WIDTH - 32);
const MIN_SEAT = 30;
const MAX_SEAT = 64;

function computeSeatSize(totalSeats: number, containerSize: number): number {
  const s = Math.sin(Math.PI / totalSeats);
  const fitMax = (containerSize * s) / (1 + s);
  return Math.max(MIN_SEAT, Math.min(MAX_SEAT, fitMax * 0.85));
}

function seatPos(
  index: number,
  total: number,
  containerSize: number,
  seatSize: number,
) {
  const radius = (containerSize - seatSize) / 2;
  const angle = (2 * Math.PI * index) / total - Math.PI / 2;
  return {
    left: containerSize / 2 + radius * Math.cos(angle) - seatSize / 2,
    top: containerSize / 2 + radius * Math.sin(angle) - seatSize / 2,
  };
}

function seatFontSize(seatSize: number, longName: boolean): number {
  if (seatSize >= 56) return longName ? 9 : 11;
  if (seatSize >= 44) return longName ? 8 : 10;
  if (seatSize >= 36) return 8;
  return 7;
}

export function SeatingCircle({
  totalSeats,
  players,
  meId,
  selectedId,
  selectedIds,
  selectableIds,
  onPress,
  size = DEFAULT_CIRCLE_SIZE,
}: SeatingCircleProps) {
  const playerBySeat = new Map<number, SeatingPlayer>();
  for (const p of players) {
    if (typeof p.seatPosition === 'number') {
      playerBySeat.set(p.seatPosition, p);
    }
  }
  const seatSize = computeSeatSize(totalSeats, size);

  return (
    <View style={{ width: size, height: size, position: 'relative' }}>
      {Array.from({ length: totalSeats }).map((_, i) => {
        const occupant = playerBySeat.get(i);
        // Empty seat (eliminated or unfilled): leave as a visual gap so the
        // remaining alive players keep their original positions.
        if (!occupant) return null;

        const pos = seatPos(i, totalSeats, size, seatSize);
        const isMe = occupant._id === meId;
        const isSelected =
          occupant._id === selectedId ||
          (selectedIds?.has(occupant._id as unknown as string) ?? false);
        const isSelectable =
          selectableIds === undefined ||
          selectableIds.has(occupant._id as unknown as string);
        const tappable = !!onPress && isSelectable;
        const fontSize = seatFontSize(seatSize, occupant.name.length > 6);

        const borderColor = isSelected
          ? '#D4A017'
          : isMe
            ? '#D4A017'
            : isSelectable
              ? '#3A3A48'
              : '#2A2A38';
        const backgroundColor = isSelected ? '#3A2A14' : '#22222F';

        const content = (
          <Text
            style={{
              color: isSelectable ? '#F0EDE8' : '#5A5560',
              fontSize,
              fontWeight: isSelected || isMe ? '700' : '600',
              textAlign: 'center',
            }}
            numberOfLines={2}
          >
            {occupant.name}
          </Text>
        );

        const sharedStyle = {
          position: 'absolute' as const,
          left: pos.left,
          top: pos.top,
          width: seatSize,
          height: seatSize,
          borderRadius: seatSize / 2,
          backgroundColor,
          borderWidth: isSelected || isMe ? 2 : 1,
          borderColor,
          alignItems: 'center' as const,
          justifyContent: 'center' as const,
          paddingHorizontal: 2,
          opacity: isSelectable ? 1 : 0.5,
        };

        if (tappable) {
          return (
            <TouchableOpacity
              key={i}
              activeOpacity={0.6}
              onPress={() => onPress!(occupant)}
              style={sharedStyle}
            >
              {content}
            </TouchableOpacity>
          );
        }
        return (
          <View key={i} style={sharedStyle}>
            {content}
          </View>
        );
      })}
    </View>
  );
}
