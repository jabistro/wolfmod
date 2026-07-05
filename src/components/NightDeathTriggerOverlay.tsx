import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, Modal } from 'react-native';
import { useMutation, useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import { SeatingCircle } from './SeatingCircle';
import { showAlert } from './ThemedAlert';
import { SCENE_TEXT_SHADOW } from '../theme/hud';

// Shared overlay for a night-death Hunter / Hunter Wolf shot. The decision
// window now opens the instant morning hits and can carry into the day if the
// host pre-empts with BEGIN DAY, so this same overlay is mounted on BOTH the
// Morning and Day screens. It self-gates off `triggerView`:
//   - active public announcement (a shot just landed) → full-screen reveal for
//     EVERYONE, interrupting whatever screen they're on;
//   - I'm the trigger actor → the private TAKE A SHOT picker;
//   - otherwise → nothing (the underlying morning/day screen shows through).
//
// `onlyFollowUpDay` lets the Day screen render this only for the night-death
// flow (`triggersFollowUp === 'day'`) so it never collides with the separate
// lynch-cascade overlay (`triggersFollowUp === 'night'`).
export function NightDeathTriggerOverlay({
  gameId,
  deviceClientId,
  onlyFollowUpDay,
}: {
  gameId: Id<'games'>;
  deviceClientId: string;
  onlyFollowUpDay?: boolean;
}) {
  const view = useQuery(api.triggers.triggerView, { gameId, deviceClientId });
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);

  if (!view) return null;
  if (onlyFollowUpDay && view.game.triggersFollowUp !== 'day') return null;

  const ann = view.game.announcement;
  if (ann && now < ann.endsAt) {
    return <ShotAnnouncementOverlay lines={ann.lines} />;
  }

  const head = view.head;
  if (
    head?.isMe &&
    (head.role === 'Hunter' || head.role === 'Hunter Wolf')
  ) {
    return (
      <HunterShotModal
        gameId={gameId}
        deviceClientId={deviceClientId}
        deadline={view.game.triggerEndsAt}
        targetables={view.targetables}
        totalSeats={view.game.playerCount}
        myId={view.me._id}
        mySeatPosition={view.me.seatPosition}
      />
    );
  }
  return null;
}

// Full-screen "X HAS SHOT Y" reveal shown to every player, over a dark scrim so
// it reads as an interruption of the morning/day beneath it.
function ShotAnnouncementOverlay({ lines }: { lines: readonly string[] }) {
  return (
    <Modal visible transparent animationType="fade">
      <View
        style={{
          flex: 1,
          backgroundColor: 'rgba(15, 15, 20, 0.92)',
          alignItems: 'center',
          justifyContent: 'center',
          paddingHorizontal: 24,
        }}
      >
        <View
          style={{
            alignSelf: 'stretch',
            maxWidth: 460,
            gap: 18,
            paddingVertical: 30,
            paddingHorizontal: 26,
            borderRadius: 22,
            backgroundColor: 'rgba(26, 26, 36, 0.96)',
            borderWidth: 1,
            borderColor: 'rgba(212, 160, 23, 0.45)',
          }}
        >
          {lines.map((line, i) => (
            <Text
              key={i}
              className="text-wolf-text text-2xl font-bold tracking-widest text-center"
              style={SCENE_TEXT_SHADOW}
            >
              {line}
            </Text>
          ))}
        </View>
      </View>
    </Modal>
  );
}

function ShotCountdown({ deadline }: { deadline: number | null }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick(n => (n + 1) % 1_000_000), 250);
    return () => clearInterval(t);
  }, []);
  if (deadline === null) return null;
  const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
  return (
    <Text
      className="text-wolf-accent text-6xl font-extrabold"
      style={{ fontVariant: ['tabular-nums'] }}
    >
      {remaining}
    </Text>
  );
}

function HunterShotModal({
  gameId,
  deviceClientId,
  deadline,
  targetables,
  totalSeats,
  myId,
  mySeatPosition,
}: {
  gameId: Id<'games'>;
  deviceClientId: string;
  deadline: number | null;
  targetables: Array<{ _id: Id<'players'>; name: string; seatPosition?: number }>;
  totalSeats: number;
  myId: Id<'players'>;
  mySeatPosition?: number;
}) {
  const submitShot = useMutation(api.triggers.submitHunterShot);
  const submitSkip = useMutation(api.triggers.submitHunterSkip);
  const [submitting, setSubmitting] = useState(false);

  async function shoot(targetId: Id<'players'>) {
    setSubmitting(true);
    try {
      await submitShot({
        gameId,
        callerDeviceClientId: deviceClientId,
        targetPlayerId: targetId,
      });
    } catch (e) {
      showAlert('Could not shoot', e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }
  async function pass() {
    setSubmitting(true);
    try {
      await submitSkip({ gameId, callerDeviceClientId: deviceClientId });
    } catch (e) {
      showAlert('Could not pass', e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal visible transparent animationType="fade">
      <View
        style={{
          flex: 1,
          backgroundColor: 'rgba(0,0,0,0.95)',
          alignItems: 'center',
          paddingTop: 64,
          paddingHorizontal: 16,
        }}
      >
        <Text className="text-wolf-muted text-xs tracking-widest">
          YOU HAVE BEEN ELIMINATED
        </Text>
        <Text className="text-wolf-accent text-2xl font-extrabold tracking-widest mt-1 mb-3">
          TAKE A SHOT
        </Text>
        <ShotCountdown deadline={deadline} />
        <Text className="text-wolf-muted text-xs tracking-widest mt-1 mb-3">
          SECONDS
        </Text>
        <SeatingCircle
          phase="day"
          totalSeats={totalSeats}
          players={targetables}
          meId={myId}
          viewerSeatIndex={mySeatPosition}
          onPress={p => !submitting && shoot(p._id)}
        />
        <Text className="text-wolf-muted text-xs text-center mt-4 max-w-xs">
          Tap a player to shoot them, or pass below.
        </Text>
        <View style={{ marginTop: 24, width: '100%' }}>
          <TouchableOpacity
            onPress={pass}
            disabled={submitting}
            style={{ opacity: submitting ? 0.4 : 1 }}
            className="bg-wolf-card rounded-xl py-4 items-center"
          >
            <Text className="text-wolf-text text-base font-extrabold tracking-widest">
              HOLD FIRE
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}
