import React, { useEffect, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Dimensions,
  Animated,
} from 'react-native';
import type { Id } from '../../convex/_generated/dataModel';

export type SeatingPlayer = {
  _id: Id<'players'>;
  name: string;
  seatPosition?: number;
  /**
   * Optional. When set to `false`, the seat still renders (faded) so the
   * viewer can see the original roster. Omit or pass `true` and the seat
   * renders normally. Callers that want eliminated players to appear as
   * pure gaps should simply drop them from the `players` array.
   */
  alive?: boolean;
};

export type SeatNomTap = {
  /** Player id of the target seat that's been tapped. */
  targetPlayerId: string;
  /** Display name of the player whose tap is live on this seat. */
  nominatorName: string;
  /** True if the local viewer's own tap is the one on this seat. */
  isMe: boolean;
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
   * Color tone for the selected ring. Defaults to 'neutral' (white) so the
   * gold self-ring stays the only gold marker on the circle. The wolves'
   * kill picker passes 'danger' (red) for the chosen victim.
   */
  selectedVariant?: 'neutral' | 'danger';
  /**
   * If provided, only seats in this set are tappable. Other seats render
   * dimmed and ignore taps. Useful for role-specific picker rules
   * (wolves can't kill wolves, BG can't repeat last protected, etc.).
   */
  selectableIds?: ReadonlySet<string>;
  /**
   * Live nomination-/wolf-vote highlight taps. Each tapped target seat
   * shows a tinted ring + the tapper's name(s) below the seat. Day-phase
   * nominations enforce at most one entry per targetPlayerId server-side;
   * the wolves' picker can attach multiple entries to the same target
   * when several wolves agree, and all names render stacked. `isMe` adds
   * a "(you)" suffix on the label so the viewer can find their own tap
   * at a glance. Color follows `selectedVariant` (white/neutral vs
   * red/danger).
   */
  nomTaps?: ReadonlyArray<SeatNomTap>;
  /**
   * Confirmation dwell: while set, that seat animates from the tap-
   * highlight state to a fully-filled solid (text color inverts to
   * dark). White on neutral (day-phase trial), red on danger (wolves'
   * kill). Used between consensus and the real action firing, so the
   * table has a beat to register who got picked before the screen
   * switches.
   */
  pendingTrialTargetId?: Id<'players'> | null;
  /**
   * Wall-clock deadline (ms epoch) the server's `finalizePendingTrial`
   * will fire at. The seat animation runs from now → this deadline so
   * the fill lands ~when the trial screen takes over. Stable per
   * pending trial — must be passed as an absolute timestamp (not a
   * derived remaining-ms) so the SeatingCircle effect doesn't re-trigger
   * on every tick.
   */
  pendingTrialDwellEndsAt?: number | null;
  /** Tap handler. If absent (or selectableIds excludes the tapped seat), tap is a no-op. */
  onPress?: (player: SeatingPlayer) => void;
  /** Override the default circle size; defaults to ~min(320, screen-32). */
  size?: number;
  /**
   * Optional content rendered centered inside the ring (e.g., "VOTED ON
   * NAME" on the vote-result screen, "VILLAGE WINS" on end-game).
   */
  centerOverlay?: React.ReactNode;
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
  nomTaps,
  pendingTrialTargetId,
  pendingTrialDwellEndsAt,
  onPress,
  size = DEFAULT_CIRCLE_SIZE,
  centerOverlay,
  selectedVariant = 'neutral',
}: SeatingCircleProps) {
  const isDanger = selectedVariant === 'danger';
  const selectedBorder = isDanger ? '#B03A2E' : '#F0EDE8';
  const selectedBackground = isDanger ? '#3A1614' : '#33333F';
  const playerBySeat = new Map<number, SeatingPlayer>();
  for (const p of players) {
    if (typeof p.seatPosition === 'number') {
      playerBySeat.set(p.seatPosition, p);
    }
  }
  const seatSize = computeSeatSize(totalSeats, size);

  // Multiple wolves can vote the same target so each seat may carry more
  // than one tap entry; nomTaps are server-deduped to one entry per target.
  const nomTapsByTarget = new Map<string, SeatNomTap[]>();
  if (nomTaps) {
    for (const t of nomTaps) {
      const arr = nomTapsByTarget.get(t.targetPlayerId);
      if (arr) arr.push(t);
      else nomTapsByTarget.set(t.targetPlayerId, [t]);
    }
  }
  const tapBorder = isDanger ? '#B03A2E' : '#F0EDE8';
  const tapBackground = isDanger ? '#3A1614' : '#33333F';
  const tapLabelColor = isDanger ? '#E07566' : '#F0EDE8';
  const tapLabelFontSize = seatSize >= 56 ? 10 : seatSize >= 44 ? 9 : 8;

  // Pending-trial fill animation. 0 = tap-highlight state, 1 = solid
  // white fill with inverted text. Restarted whenever the pending target
  // id changes (a new trial confirmation began) or the server's dwell
  // deadline updates — both are stable per pending trial, so the effect
  // doesn't churn every tick.
  const pendingAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (pendingTrialTargetId && pendingTrialDwellEndsAt != null) {
      const remaining = Math.max(0, pendingTrialDwellEndsAt - Date.now());
      pendingAnim.setValue(0);
      Animated.timing(pendingAnim, {
        toValue: 1,
        duration: remaining,
        useNativeDriver: false,
      }).start();
    } else {
      pendingAnim.setValue(0);
    }
  }, [pendingTrialTargetId, pendingTrialDwellEndsAt, pendingAnim]);
  const pendingBg = pendingAnim.interpolate({
    inputRange: [0, 1],
    outputRange: isDanger
      ? ['rgba(58, 22, 20, 1)', 'rgba(176, 58, 46, 1)']
      : ['rgba(51, 51, 63, 1)', 'rgba(240, 237, 232, 1)'],
  });
  const pendingTextColor = pendingAnim.interpolate({
    inputRange: [0, 1],
    outputRange: isDanger
      ? ['rgba(240, 237, 232, 1)', 'rgba(240, 237, 232, 1)']
      : ['rgba(240, 237, 232, 1)', 'rgba(15, 15, 20, 1)'],
  });
  const pendingBorder = isDanger ? '#B03A2E' : '#F0EDE8';

  // Render in two passes so tap labels paint on top of every seat.
  // Otherwise seats drawn AFTER a labeled seat (in iteration order) cover
  // the labels positioned below earlier seats — visible on the lower half
  // of the circle where each seat's label sits over the next seat's space.
  const seatNodes: React.ReactNode[] = [];
  const labelNodes: React.ReactNode[] = [];
  for (let i = 0; i < totalSeats; i++) {
    const occupant = playerBySeat.get(i);
    // Empty seat (eliminated mid-game with no faded-roster mode, or
    // simply unfilled): leave as a visual gap so remaining alive players
    // keep their original positions.
    if (!occupant) continue;

    const pos = seatPos(i, totalSeats, size, seatSize);
    const isDead = occupant.alive === false;
    const isMe = occupant._id === meId;
    const isSelected =
      !isDead &&
      (occupant._id === selectedId ||
        (selectedIds?.has(occupant._id as unknown as string) ?? false));
    const isSelectable =
      !isDead &&
      (selectableIds === undefined ||
        selectableIds.has(occupant._id as unknown as string));
    const tappable = !!onPress && isSelectable;
    const fontSize = seatFontSize(seatSize, occupant.name.length > 6);
    const taps = !isDead
      ? nomTapsByTarget.get(occupant._id as unknown as string)
      : undefined;
    const hasTap = !!taps && taps.length > 0;
    const isPending = !isDead && pendingTrialTargetId === occupant._id;

    if (hasTap && !isPending) {
      labelNodes.push(
        <View
          key={`tap-${i}`}
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: pos.left - 4,
            top: pos.top + seatSize + 2,
            width: seatSize + 8,
            alignItems: 'center',
          }}
        >
          {taps!.map((t, tIdx) => (
            <Text
              key={tIdx}
              numberOfLines={1}
              style={{
                color: tapLabelColor,
                fontSize: tapLabelFontSize,
                fontWeight: '700',
              }}
            >
              {t.isMe ? `${t.nominatorName} (you)` : t.nominatorName}
            </Text>
          ))}
        </View>,
      );
    }

    // Pending-trial seat renders as Animated.View so its background and
    // text color can morph over the dwell window. Other seats use the
    // regular static style.
    if (isPending) {
      const animatedSeatStyle = {
        position: 'absolute' as const,
        left: pos.left,
        top: pos.top,
        width: seatSize,
        height: seatSize,
        borderRadius: seatSize / 2,
        backgroundColor: pendingBg,
        borderWidth: 2,
        borderColor: pendingBorder,
        alignItems: 'center' as const,
        justifyContent: 'center' as const,
        paddingHorizontal: 2,
        opacity: 1,
      };
      seatNodes.push(
        <Animated.View key={i} style={animatedSeatStyle} pointerEvents="none">
          <Animated.Text
            style={{
              color: pendingTextColor,
              fontSize,
              fontWeight: '700',
              textAlign: 'center',
            }}
            numberOfLines={2}
          >
            {occupant.name}
          </Animated.Text>
        </Animated.View>,
      );
      continue;
    }

    // Tap-highlight wins over `selected` and the gold self-ring so the
    // village always sees who's been nominated, even on seats that
    // happen to also be the viewer's own.
    const borderColor = isDead
      ? '#2A2A38'
      : hasTap
        ? tapBorder
        : isSelected
          ? selectedBorder
          : isMe
            ? '#D4A017'
            : isSelectable
              ? '#3A3A48'
              : '#2A2A38';
    const backgroundColor = hasTap
      ? tapBackground
      : isSelected
        ? selectedBackground
        : '#22222F';
    const textColor = isDead
      ? '#5A5560'
      : isSelectable
        ? '#F0EDE8'
        : '#5A5560';
    const seatOpacity = isDead ? 0.35 : isSelectable ? 1 : 0.5;
    const content = (
      <Text
        style={{
          color: textColor,
          fontSize,
          fontWeight: hasTap || isSelected || isMe ? '700' : '600',
          textAlign: 'center',
          textDecorationLine: isDead ? 'line-through' : 'none',
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
      borderWidth: hasTap || isSelected || (isMe && !isDead) ? 2 : 1,
      borderColor,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      paddingHorizontal: 2,
      opacity: seatOpacity,
    };
    if (tappable) {
      seatNodes.push(
        <TouchableOpacity
          key={i}
          activeOpacity={0.6}
          onPress={() => onPress!(occupant)}
          style={sharedStyle}
        >
          {content}
        </TouchableOpacity>,
      );
    } else {
      seatNodes.push(
        <View key={i} style={sharedStyle}>
          {content}
        </View>,
      );
    }
  }

  return (
    <View
      style={{ width: size, height: size, position: 'relative', marginTop: 12 }}
    >
      {seatNodes}
      {labelNodes}
      {centerOverlay ? (
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            top: seatSize,
            left: seatSize,
            right: seatSize,
            bottom: seatSize,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {centerOverlay}
        </View>
      ) : null}
    </View>
  );
}
