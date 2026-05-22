import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  SafeAreaView,
  ScrollView,
  ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { StackNavigationProp } from '@react-navigation/stack';
import { useMutation, useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import type { RootStackParamList } from '../navigation/types';
import { useDeviceId } from '../hooks/useDeviceId';
import { SeatingCircle } from '../components/SeatingCircle';
import { showAlert } from '../components/ThemedAlert';
import { TRIGGER_DWELL_MS } from '../../convex/triggers';

type Nav = StackNavigationProp<RootStackParamList, 'Triggers'>;
type Route = RouteProp<RootStackParamList, 'Triggers'>;

export default function TriggersScreen() {
  const navigation = useNavigation<Nav>();
  const { params } = useRoute<Route>();
  const deviceClientId = useDeviceId();
  const insets = useSafeAreaInsets();

  const view = useQuery(
    api.triggers.triggerView,
    deviceClientId
      ? { gameId: params.gameId as Id<'games'>, deviceClientId }
      : 'skip',
  );

  // Phase-driven nav. When the trigger queue empties for a night-context
  // path (followUp 'morning' / 'day'), finalizeTriggerPhase changes the
  // phase and we route the player onward.
  useEffect(() => {
    if (!view) return;
    const phase = view.game.phase;
    if (phase === 'morning') {
      navigation.replace('Morning', { gameId: params.gameId });
    } else if (phase === 'day') {
      navigation.replace('Day', { gameId: params.gameId });
    } else if (phase === 'night') {
      navigation.replace('Night', { gameId: params.gameId });
    } else if (phase === 'ended') {
      navigation.replace('EndGame', { gameId: params.gameId });
    }
  }, [view?.game.phase, navigation, params.gameId]);

  if (!deviceClientId || view === undefined) {
    return (
      <SafeAreaView className="flex-1 bg-wolf-bg items-center justify-center">
        <ActivityIndicator color="#D4A017" />
      </SafeAreaView>
    );
  }
  if (view === null) {
    return (
      <SafeAreaView className="flex-1 bg-wolf-bg items-center justify-center px-8">
        <Text className="text-wolf-text text-lg text-center">
          This game no longer exists.
        </Text>
      </SafeAreaView>
    );
  }

  const { head, me } = view;
  const announcement = view.game.announcement;
  const announcementActive =
    announcement != null && Date.now() < announcement.endsAt;

  // Active announcement overrides every other view — host AND actor see the
  // same lines for the duration so the village can read the result before
  // the next trigger fires.
  if (announcementActive && announcement) {
    return <AnnouncementView lines={announcement.lines} />;
  }

  // Queue empty but still in 'triggers' phase: brief gap while finalize
  // transitions us elsewhere. Show a neutral "Resolving..." rather than a
  // blank screen.
  if (!head) {
    return <ResolvingView label="RESOLVING NIGHT…" />;
  }

  // Caller is the trigger actor. Show their private prompt.
  if (head.isMe) {
    if (head.role === 'Hunter' || head.role === 'Hunter Wolf') {
      return (
        <HunterPickerView
          gameId={view.game._id}
          deviceClientId={deviceClientId}
          deadline={view.game.triggerEndsAt}
          targetables={view.targetables}
          totalSeats={view.game.playerCount}
          myId={me._id}
          insetBottom={insets.bottom}
        />
      );
    }
    // Shouldn't reach here but render the resolving view defensively.
    return <ResolvingView label="RESOLVING NIGHT…" />;
  }

  // Caller is NOT the actor. We deliberately do NOT show the head's
  // name because naming the actor would leak who's holding a trigger
  // role.
  return <ResolvingView label="MORNING UNFOLDS…" />;
}

// ───── Sub-views ────────────────────────────────────────────────────────────

function ResolvingView({
  label,
  sublabel,
}: {
  label: string;
  sublabel?: string;
}) {
  return (
    <SafeAreaView className="flex-1 bg-wolf-bg items-center justify-center px-8">
      <ActivityIndicator color="#D4A017" />
      <Text className="text-wolf-muted text-xs tracking-widest mt-6 text-center">
        {label}
      </Text>
      {sublabel ? (
        <Text className="text-wolf-text text-sm text-center mt-2">{sublabel}</Text>
      ) : null}
    </SafeAreaView>
  );
}

function AnnouncementView({ lines }: { lines: readonly string[] }) {
  return (
    <SafeAreaView className="flex-1 bg-wolf-bg items-center justify-center px-6">
      <View style={{ gap: 18 }}>
        {lines.map((line, i) => (
          <Text
            key={i}
            className="text-wolf-text text-2xl font-bold tracking-widest text-center"
          >
            {line}
          </Text>
        ))}
      </View>
    </SafeAreaView>
  );
}

function Countdown({ deadline }: { deadline: number | null }) {
  // Tick state forces re-renders; `Date.now()` is read inline so a query update
  // arriving between ticks doesn't compute remaining against a stale `now`
  // (which would `Math.ceil` up to duration+1 for a frame and look like the
  // timer ticked upward before counting down).
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick(n => (n + 1) % 1_000_000), 200);
    return () => clearInterval(t);
  }, []);
  if (deadline === null) return null;
  // Clamp the visible remaining to the configured dwell so client/server clock
  // skew can't push `Math.ceil` one tick above the duration for the first
  // frame after the deadline arrives (which presented as a brief upward tick).
  const remainingMs = Math.max(
    0,
    Math.min(TRIGGER_DWELL_MS, deadline - Date.now()),
  );
  const remaining = Math.ceil(remainingMs / 1000);
  return (
    <Text
      className="text-wolf-accent text-7xl font-extrabold"
      style={{ fontVariant: ['tabular-nums'] }}
    >
      {remaining}
    </Text>
  );
}

function HunterPickerView({
  gameId,
  deviceClientId,
  deadline,
  targetables,
  totalSeats,
  myId,
  insetBottom,
}: {
  gameId: Id<'games'>;
  deviceClientId: string;
  deadline: number | null;
  targetables: Array<{
    _id: Id<'players'>;
    name: string;
    seatPosition?: number;
  }>;
  totalSeats: number;
  myId: Id<'players'>;
  insetBottom: number;
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
  async function skip() {
    setSubmitting(true);
    try {
      await submitSkip({ gameId, callerDeviceClientId: deviceClientId });
    } catch (e) {
      showAlert('Could not pass', e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  const seating = targetables.map(t => ({
    _id: t._id,
    name: t.name,
    seatPosition: t.seatPosition,
  }));

  return (
    <SafeAreaView className="flex-1 bg-wolf-bg">
      <View className="px-4 pt-10 pb-3 items-center">
        <Text className="text-wolf-muted text-xs tracking-widest">
          YOU HAVE BEEN ELIMINATED
        </Text>
        <Text className="text-wolf-accent text-2xl font-extrabold tracking-widest mt-1">
          TAKE A SHOT
        </Text>
      </View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, alignItems: 'center' }}>
        <View className="my-2">
          <Countdown deadline={deadline} />
        </View>
        <Text className="text-wolf-muted text-xs tracking-widest mb-3">
          SECONDS
        </Text>
        <SeatingCircle
          totalSeats={totalSeats}
          players={seating}
          meId={myId}
          onPress={p => !submitting && shoot(p._id)}
        />
        <Text className="text-wolf-muted text-xs text-center mt-4 max-w-xs">
          Tap a player to shoot them, or pass below.
        </Text>
      </ScrollView>
      <View
        style={{
          paddingHorizontal: 24,
          paddingBottom: Math.max(insetBottom, 16) + 16,
        }}
      >
        <TouchableOpacity
          onPress={skip}
          disabled={submitting}
          style={{ opacity: submitting ? 0.4 : 1 }}
          className="bg-wolf-card rounded-xl py-4 items-center"
        >
          <Text className="text-wolf-text text-base font-extrabold tracking-widest">
            HOLD FIRE
          </Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

