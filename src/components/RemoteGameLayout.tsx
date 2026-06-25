import React, { useEffect, useRef, useState } from 'react';
import { BackHandler, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQuery } from 'convex/react';
import ChatPane from './ChatPane';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';

type Props = {
  gameId: Id<'games'>;
  deviceClientId: string | null;
  /** The game's play mode. Chat only mounts when this is 'remote'. */
  mode: 'local' | 'remote' | undefined;
  children: React.ReactNode;
};

/**
 * Split-view shell for the in-game screens. LOCAL games render the screen
 * untouched. REMOTE games dock a collapsible <ChatPane>:
 *   - collapsed → the game screen takes the full height, chat is just a bar.
 *   - expanded  → the game screen is clipped to a fixed slice that shows only
 *     its top header (DAY N / DISCUSSION, etc.), and the chat FLEXES into all
 *     the remaining space. This "snap under the header" via flex (not a
 *     computed height) is robust across devices — no per-device math.
 */
export default function RemoteGameLayout({
  gameId,
  deviceClientId,
  mode,
  children,
}: Props) {
  const insets = useSafeAreaInsets();

  // Real laid-out height of this container (NOT useWindowDimensions, which
  // disagrees per device). Its shrink when the keyboard opens tells ChatPane
  // how much overlap the OS already absorbed by resizing the view.
  const [availH, setAvailH] = useState(0);
  const maxAvailRef = useRef(0);
  if (availH > maxAvailRef.current) maxAvailRef.current = availH;
  const keyboardHandledPx =
    maxAvailRef.current > 0 ? Math.max(0, maxAvailRef.current - availH) : 0;

  // Expand state lives here so we can size the two regions. Auto-collapse the
  // instant the player must act (night picker / vote buttons) so the action
  // UI isn't hidden — edge-triggered, re-openable.
  const [expanded, setExpanded] = useState(true);
  const cs = useQuery(
    api.chat.chatState,
    deviceClientId ? { gameId, deviceClientId } : 'skip',
  );
  // Wolves get their chat OPEN at night to discuss + decide the kill (they
  // collapse it to use the picker). Everyone else collapses at night so the
  // night screen / waiting view is visible.
  const wolfNight =
    cs?.phase === 'night' &&
    !!cs?.channels?.find(c => c.channel === 'wolves')?.canPost;

  const mustAct =
    (cs?.phase === 'night' && !wolfNight) ||
    // Triggers phase (Hunter / Hunter Wolf death-shot): the picker IS the
    // screen body, not a modal — with the chat expanded it's clipped behind the
    // chat, so the shooter can't reach it and the 10s window auto-SKIPS the
    // shot. Collapse like night so the actor sees their picker (and everyone
    // else sees the on-screen shot announcement; chat also keeps a record).
    cs?.phase === 'triggers' ||
    cs?.voteActive === true ||
    // Lobby is dense (seats / build / start) — keep chat collapsed by default;
    // players expand the bar to banter while waiting.
    cs?.phase === 'lobby';
  const prevMustAct = useRef(false);
  useEffect(() => {
    if (mustAct && !prevMustAct.current) setExpanded(false);
    prevMustAct.current = mustAct;
  }, [mustAct]);

  // Auto-OPEN when the chat is where the action is and it's NOT an act-now
  // moment: vote results, accusation/defense/prevote, morning, a pause (break
  // room), or the wolves' night discussion. So after a vote the result shows
  // without reopening.
  const shouldOpen =
    !!cs &&
    ((cs.chatDominant && !cs.voteActive && cs.phase !== 'night') ||
      cs.paused === true ||
      wolfNight === true ||
      // Game over → pop the chat open so the WIN banner is proudly shown.
      cs.phase === 'ended');
  const prevShouldOpen = useRef(false);
  useEffect(() => {
    if (shouldOpen && !prevShouldOpen.current) setExpanded(true);
    prevShouldOpen.current = shouldOpen;
  }, [shouldOpen]);

  // On RESUME (pause → unpause) during an act-now moment — notably the live
  // vote — re-collapse so the action UI (LIVES/DIES) that the break-room pause
  // expanded over is reachable again. Edge-triggered on the unpause only.
  const prevPaused = useRef(false);
  useEffect(() => {
    const paused = cs?.paused === true;
    if (!paused && prevPaused.current && mustAct) setExpanded(false);
    prevPaused.current = paused;
  }, [cs?.paused, mustAct]);

  // Pop the chat open at the start of each day so the dawn report (now posted
  // with no morning pause) is front-and-center. Edge-triggered on ENTERING the
  // day phase, so it won't fight a manual collapse later in the same day, and
  // it skips the case where you reconnect already mid-day (no prior phase).
  const prevPhase = useRef<string | undefined>(undefined);
  useEffect(() => {
    const phase = cs?.phase;
    if (phase === 'day' && prevPhase.current && prevPhase.current !== 'day') {
      setExpanded(true);
    }
    prevPhase.current = phase;
  }, [cs?.phase]);

  // Android back button: if the chat is open, close it instead of prompting to
  // leave the game. Registered by this (parent) layout, so it runs before the
  // screen's leave handler and only consumes the press when chat is expanded.
  useEffect(() => {
    if (mode !== 'remote') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (expanded) {
        setExpanded(false);
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [mode, expanded]);

  if (mode !== 'remote' || !deviceClientId) return <>{children}</>;

  // Fixed slice of the screen kept for the game's top header when chat is
  // expanded. Sized to reveal the whole header block — DAY N / mode subtitle,
  // and the LEAVE / ROOM-code / BUILD stack (its lowest element, the BUILD
  // icon, bottoms out around insets.top + ~104) — while still sitting above the
  // background DayClockBar (~insets.top + 114), which the opaque chat overlay
  // covers. One number to tune if it clips the header / shows the old timer.
  const headerPeek = insets.top + 108;

  return (
    <View
      className="flex-1 bg-wolf-bg"
      onLayout={e => setAvailH(e.nativeEvent.layout.height)}
    >
      {/* The game screen always lays out at FULL height — never squished into
          the peek. Clipping a flex:1 screen down to a thin slice reflowed it
          (the header collapsed and the DayClockBar rode up over LEAVE/ROOM)
          and Android wouldn't reliably clip the overflow away either. Instead,
          when expanded, the OPAQUE chat is overlaid on top of everything below
          the header peek — so only the game's top header shows through, with no
          clipping involved. */}
      <View style={{ flex: 1 }}>{children}</View>
      {/* Chat: an in-flow bar at the bottom when collapsed; an absolute overlay
          covering from the header peek down when expanded. ChatPane stays
          mounted across the toggle (only its container's position changes) so
          its scroll/read state isn't reset. */}
      <View
        style={
          expanded
            ? {
                position: 'absolute',
                left: 0,
                right: 0,
                top: headerPeek,
                bottom: 0,
              }
            : undefined
        }
      >
        <ChatPane
          gameId={gameId}
          deviceClientId={deviceClientId}
          expanded={expanded}
          onToggleExpanded={() => setExpanded(e => !e)}
          keyboardHandledPx={keyboardHandledPx}
        />
      </View>
    </View>
  );
}
