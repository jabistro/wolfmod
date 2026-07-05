import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  SafeAreaView,
  ScrollView,
  Animated,
  Easing,
  ActivityIndicator,
  Modal,
  Pressable,
} from 'react-native';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { StackNavigationProp } from '@react-navigation/stack';
import { useMutation, useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import type { RootStackParamList } from '../navigation/types';
import { useDeviceId } from '../hooks/useDeviceId';
import {
  SeatingCircle,
  type SeatingPlayer,
  type SeatNomTap,
} from '../components/SeatingCircle';
import { showAlert } from '../components/ThemedAlert';
import { InGameLeaveButton } from '../components/InGameLeaveButton';
import { PhaseScreen } from '../components/PhaseScreen';
import { themedFont } from '../theme/fonts';
import { useGameLeaveHandler } from '../hooks/useGameLeaveHandler';
import { HostMissingBanner } from '../components/HostMissingBanner';
import { MasonRevealModal } from '../components/MasonRevealModal';
import { isWolfTeam } from '../data/v1Roles';
import { getRoleDescription } from '../data/roleDescriptions';
import {
  SCENE_TEXT_SHADOW,
  RING_SIZE,
  useRingAnchorStyle,
} from '../theme/hud';
import { useTheme } from '../contexts/ThemeContext';
import { getTableArt } from '../data/tableArt';

type Nav = StackNavigationProp<RootStackParamList, 'Night'>;
type Route = RouteProp<RootStackParamList, 'Night'>;

type Targetable = {
  _id: Id<'players'>;
  name: string;
  seatPosition?: number;
};

export default function NightScreen() {
  const navigation = useNavigation<Nav>();
  const { params } = useRoute<Route>();
  const deviceClientId = useDeviceId();

  const view = useQuery(
    api.night.nightView,
    deviceClientId
      ? { gameId: params.gameId as Id<'games'>, deviceClientId }
      : 'skip',
  );

  const submitMasonAck = useMutation(api.night.submitMasonAck);
  const [ackingMason, setAckingMason] = useState(false);

  // Local clock used to surface the host's "skip ahead" override without
  // needing a server roundtrip — the server returns `skipEligibleAt` and the
  // client checks it against wall-clock time on a 1s tick.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  // Sasquatch conversion overlay: when the server signals a fresh flip via
  // `sasquatchReveal`, render the modal for 5 s (matches the engine's
  // REVEAL_WINDOW_MS) and then let the wolves picker take focus. The server
  // clears the pending flag when the wolves step advances, so the modal won't
  // replay on subsequent nights.
  const sasquatchRevealNow = view?.sasquatchReveal === true;
  const [sasquatchOverlayOpen, setSasquatchOverlayOpen] = useState(false);
  useEffect(() => {
    if (!sasquatchRevealNow) return;
    setSasquatchOverlayOpen(true);
    const timer = setTimeout(() => setSasquatchOverlayOpen(false), 5000);
    return () => clearTimeout(timer);
  }, [sasquatchRevealNow]);

  // Drunk sober-up overlay: the start of N3, the Drunk learns the hidden role
  // they were all along. Same 5 s one-shot as the Sasquatch flip; the server
  // clears the pending flag at morning so it won't replay.
  const drunkRevealNow = !!view?.drunkReveal;
  const [drunkOverlayOpen, setDrunkOverlayOpen] = useState(false);
  useEffect(() => {
    if (!drunkRevealNow) return;
    setDrunkOverlayOpen(true);
    const timer = setTimeout(() => setDrunkOverlayOpen(false), 5000);
    return () => clearTimeout(timer);
  }, [drunkRevealNow]);

  // Phase-driven nav: when night ends → morning, route everyone forward.
  useEffect(() => {
    if (!view) return;
    const phase = view.game.phase;
    if (phase === 'morning') {
      navigation.replace('Morning', { gameId: params.gameId });
    } else if (phase === 'day') {
      navigation.replace('Day', { gameId: params.gameId });
    } else if (phase === 'triggers') {
      navigation.replace('Triggers', { gameId: params.gameId });
    } else if (phase === 'ended') {
      navigation.replace('EndGame', { gameId: params.gameId });
    }
  }, [view?.game.phase, navigation, params.gameId]);

  const { confirmLeave } = useGameLeaveHandler({
    gameId: params.gameId as Id<'games'>,
    deviceClientId,
    isHost: view?.me.isHost,
  });

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

  const {
    game,
    me,
    isMyStep,
    stepLabel,
    myActivePickerStep,
    myDecisionEndsAt,
    wolfState,
    sasquatchReveal,
    drunkReveal,
    seerHistory,
    piState,
    mentalistState,
    witchState,
    leprechaunState,
    warlockState,
    chupacabraState,
    bgState,
    huntressState,
    revealerState,
    revilerState,
    cursedConversionState,
    alphaConversionState,
    doppelgangerRevealState,
    masonRevealState,
    nightmareWolfState,
    nightmaredBlocking,
    targetables,
    nightLog,
  } = view;

  async function handleMasonAck() {
    if (!deviceClientId) return;
    setAckingMason(true);
    try {
      await submitMasonAck({ gameId: params.gameId as Id<'games'>, callerDeviceClientId: deviceClientId });
    } catch (e) {
      showAlert('Error', e instanceof Error ? e.message : String(e));
    } finally {
      setAckingMason(false);
    }
  }

  // Defensive: if phase has already moved on, the effect above will navigate.
  if (game.phase !== 'night') {
    return (
      <SafeAreaView className="flex-1 bg-wolf-bg items-center justify-center">
        <ActivityIndicator color="#D4A017" />
      </SafeAreaView>
    );
  }

  const isGhost = !me.alive;
  const activeStepNames: string[] = game.activeSteps.map(e => e.step);

  // With parallel waves, the picker tree gates on `myActivePickerStep`. The
  // server picks the single step whose picker this caller should see right
  // now (at most one, since one player can only fill one role-step). Other
  // active steps are running concurrently on other phones, but this user's
  // view shows only their own picker.
  const pickerTree = (
    <>
      {myActivePickerStep === 'wolves' && wolfState && (
        wolfState.blocked ? (
          <WolvesBlockedView wolves={wolfState.wolves} isGhost={isGhost} />
        ) : (
          <WolvesPicker
            gameId={game._id}
            deviceClientId={deviceClientId}
            alivePlayers={view.alivePlayers}
            targetables={targetables}
            totalSeats={game.playerCount}
            meId={me._id}
            meSeatPosition={me.seatPosition}
            wolves={wolfState.wolves}
            requiredKills={wolfState.requiredKills}
            killsSoFar={wolfState.killsSoFar}
            pendingKill={wolfState.pendingKill}
            pickerEndsAt={wolfState.pickerEndsAt}
            convertActive={wolfState.convertActive}
            isGhost={isGhost}
          />
        )
      )}

      {myActivePickerStep === 'seer' && seerHistory != null && (
        <SeerPicker
          gameId={game._id}
          deviceClientId={deviceClientId}
          alivePlayers={view.alivePlayers}
          targetables={targetables}
          totalSeats={game.playerCount}
          meId={me._id}
          meSeatPosition={me.seatPosition}
          history={seerHistory}
          nightNumber={game.nightNumber}
          isGhost={isGhost}
        />
      )}

      {myActivePickerStep === 'pi' && piState && (
        <PIPicker
          gameId={game._id}
          deviceClientId={deviceClientId}
          alivePlayers={view.alivePlayers}
          targetables={targetables}
          totalSeats={game.playerCount}
          meId={me._id}
          meSeatPosition={me.seatPosition}
          piState={piState}
          isGhost={isGhost}
        />
      )}

      {myActivePickerStep === 'mentalist' && mentalistState && (
        <MentalistPicker
          gameId={game._id}
          deviceClientId={deviceClientId}
          alivePlayers={view.alivePlayers}
          targetables={targetables}
          totalSeats={game.playerCount}
          meId={me._id}
          meSeatPosition={me.seatPosition}
          mentalistState={mentalistState}
          nightNumber={game.nightNumber}
          isGhost={isGhost}
        />
      )}

      {myActivePickerStep === 'witch' && witchState && (
        <WitchPicker
          gameId={game._id}
          deviceClientId={deviceClientId}
          alivePlayers={view.alivePlayers}
          targetables={targetables}
          totalSeats={game.playerCount}
          meId={me._id}
          meSeatPosition={me.seatPosition}
          witchState={witchState}
          isGhost={isGhost}
        />
      )}

      {myActivePickerStep === 'leprechaun' && leprechaunState && (
        <LeprechaunPicker
          gameId={game._id}
          deviceClientId={deviceClientId}
          leprechaunState={leprechaunState}
          isGhost={isGhost}
        />
      )}

      {myActivePickerStep === 'warlock' && warlockState && (
        <WarlockPicker
          gameId={game._id}
          deviceClientId={deviceClientId}
          alivePlayers={view.alivePlayers}
          targetables={targetables}
          totalSeats={game.playerCount}
          warlockState={warlockState}
          meId={me._id}
          meSeatPosition={me.seatPosition}
          isGhost={isGhost}
        />
      )}

      {myActivePickerStep === 'chupacabra' && chupacabraState && (
        <ChupacabraPicker
          gameId={game._id}
          deviceClientId={deviceClientId}
          alivePlayers={view.alivePlayers}
          targetables={targetables}
          totalSeats={game.playerCount}
          chupacabraState={chupacabraState}
          meId={me._id}
          meSeatPosition={me.seatPosition}
          isGhost={isGhost}
        />
      )}

      {myActivePickerStep === 'bodyguard' && bgState && (
        <BodyguardPicker
          gameId={game._id}
          deviceClientId={deviceClientId}
          alivePlayers={view.alivePlayers}
          targetables={targetables}
          totalSeats={game.playerCount}
          bgState={bgState}
          meId={me._id}
          meSeatPosition={me.seatPosition}
          isGhost={isGhost}
        />
      )}

      {myActivePickerStep === 'huntress' && huntressState && (
        <HuntressPicker
          gameId={game._id}
          deviceClientId={deviceClientId}
          alivePlayers={view.alivePlayers}
          targetables={targetables}
          totalSeats={game.playerCount}
          huntressState={huntressState}
          meId={me._id}
          meSeatPosition={me.seatPosition}
          isGhost={isGhost}
        />
      )}

      {myActivePickerStep === 'revealer' && revealerState && (
        <RevealerPicker
          gameId={game._id}
          deviceClientId={deviceClientId}
          alivePlayers={view.alivePlayers}
          targetables={targetables}
          totalSeats={game.playerCount}
          revealerState={revealerState}
          meId={me._id}
          meSeatPosition={me.seatPosition}
          isGhost={isGhost}
        />
      )}

      {myActivePickerStep === 'reviler' && revilerState && (
        <RevilerPicker
          gameId={game._id}
          deviceClientId={deviceClientId}
          alivePlayers={view.alivePlayers}
          targetables={targetables}
          totalSeats={game.playerCount}
          revilerState={revilerState}
          meId={me._id}
          meSeatPosition={me.seatPosition}
          isGhost={isGhost}
        />
      )}

      {activeStepNames.includes('cursed_conversion') && cursedConversionState && (
        <CursedRevealView
          isMine={cursedConversionState.isMine}
          convertedNames={cursedConversionState.convertedNames}
        />
      )}

      {activeStepNames.includes('alpha_conversion') && alphaConversionState && (
        <AlphaConversionView
          isMine={alphaConversionState.isMine}
          convertedName={alphaConversionState.convertedName}
        />
      )}

      {(activeStepNames.includes('doppelganger_dawn') ||
        activeStepNames.includes('doppelganger_dusk')) &&
        doppelgangerRevealState && (
          <DoppelgangerRevealView
            isMine={doppelgangerRevealState.isMine}
            fromRole={doppelgangerRevealState.fromRole}
            toRole={doppelgangerRevealState.toRole}
            conversions={doppelgangerRevealState.conversions}
          />
        )}

      {myActivePickerStep === 'nightmare_wolf' && nightmareWolfState && (
        <NightmareWolfPicker
          gameId={game._id}
          deviceClientId={deviceClientId}
          alivePlayers={view.alivePlayers}
          targetables={targetables}
          totalSeats={game.playerCount}
          nightmareState={nightmareWolfState}
          meId={me._id}
          meSeatPosition={me.seatPosition}
          isGhost={isGhost}
        />
      )}

    </>
  );

  return (
    <PhaseScreen phase="night">
      <InGameLeaveButton onPress={confirmLeave} />
      <View
        style={{
          position: 'absolute',
          right: 12,
          top: 40,
          alignItems: 'flex-end',
          zIndex: 10,
        }}
      >
        <Text
          style={{
            color: '#8A8590',
            fontSize: 10,
            fontWeight: '700',
            letterSpacing: 2,
          }}
        >
          ROOM
        </Text>
        <Text
          style={{
            color: '#D4A017',
            fontSize: 16,
            fontWeight: '800',
            letterSpacing: 3,
            marginTop: 5,
          }}
        >
          {game.roomCode}
        </Text>
      </View>
      <NightHeader
        nightNumber={game.nightNumber}
        stepLabel={me.alive ? null : stepLabel}
        dead={!me.alive}
        role={me.alive ? me.role : undefined}
      />

      {view.hostMissing && (
        <HostMissingBanner
          gameId={game._id}
          deviceClientId={deviceClientId}
        />
      )}

      {me.alive ? (
        nightmaredBlocking ? (
          <NightmareBlockedView />
        ) : (
          <>
            {myDecisionEndsAt != null && (
              <NightDecisionCountdown endsAt={myDecisionEndsAt} />
            )}
            {pickerTree}
            {!isMyStep &&
              !cursedConversionState &&
              !alphaConversionState &&
              !doppelgangerRevealState && <WaitingView />}
          </>
        )
      ) : activeStepNames.length === 0 ? (
        <View className="flex-1 items-center justify-center px-8">
          <Text className="text-wolf-text text-sm text-center">
            You are out of the game. The night unfolds without you.
          </Text>
        </View>
      ) : (
        <NightLogView entries={nightLog ?? []} />
      )}

      <SasquatchRevealOverlay
        visible={sasquatchOverlayOpen && sasquatchReveal === true}
        wolves={wolfState?.wolves ?? []}
      />

      <DrunkRevealOverlay
        visible={drunkOverlayOpen && !!drunkReveal}
        toRole={drunkReveal?.toRole ?? ''}
        wolves={drunkReveal?.wolves ?? []}
      />

      <MasonRevealModal
        state={masonRevealState ?? null}
        onAck={handleMasonAck}
        submitting={ackingMason}
      />

    </PhaseScreen>
  );
}

// ───── Ghost night log ─────────────────────────────────────────────────────
//
// The full ghost-spectator view during a live night. Renders one card per
// recorded nightAction in wake-order — wolves → nightmare wolf → seer → …
// → reviler — plus muted "no one to act tonight" system entries for
// in-game steps with no eligible actor (all role-players dead / spent /
// nightmared). Updates reactively as the engine writes rows; auto-scrolls
// to the newest entry so the latest action stays in view without manual
// scrolling. Replaces the per-role picker mirroring that the ghost UX
// used to do — since we can't see mid-tap decisions anyway, the resolved
// info is what matters. See [[wolfmod-ghost-spectator]] for the design
// rationale.

function NightLogView({
  entries,
}: {
  entries: ReadonlyArray<{
    id: string;
    roleLabel: string;
    actorName: string | null;
    statusLabel: string;
    statusColor: string;
    kind: 'action' | 'system';
  }>;
}) {
  const scrollRef = useRef<ScrollView>(null);
  useEffect(() => {
    // Land on the newest entry whenever the log grows. Latest action is the
    // one a returning spectator cares about most.
    const t = setTimeout(() => {
      scrollRef.current?.scrollToEnd({ animated: true });
    }, 50);
    return () => clearTimeout(t);
  }, [entries.length]);

  if (entries.length === 0) {
    return (
      <View className="flex-1 items-center justify-center px-8">
        <ActivityIndicator color="#D4A017" />
        <Text
          className="text-wolf-text text-sm italic text-center mt-6"
          style={{ alignSelf: 'stretch' }}
        >
          The night is just beginning…
        </Text>
      </View>
    );
  }

  return (
    <ScrollView
      ref={scrollRef}
      className="flex-1"
      contentContainerStyle={{
        paddingHorizontal: 16,
        paddingTop: 8,
        paddingBottom: 24,
      }}
    >
      {entries.map(e => (
        <View
          key={e.id}
          className="bg-wolf-card rounded-xl px-4 py-3 mb-2"
        >
          <Text className="text-wolf-muted text-[10px] font-bold tracking-widest">
            {e.roleLabel.toUpperCase()}
          </Text>
          {e.actorName ? (
            <Text className="text-wolf-text text-sm font-extrabold tracking-wide mt-0.5">
              {e.actorName.toUpperCase()}
            </Text>
          ) : null}
          <Text
            className={`text-sm mt-0.5 ${e.kind === 'system' ? 'italic' : 'font-semibold'}`}
            style={{ color: e.statusColor }}
          >
            {e.statusLabel}
          </Text>
        </View>
      ))}
    </ScrollView>
  );
}

// ───── Header ───────────────────────────────────────────────────────────────

function NightHeader({
  nightNumber,
  stepLabel,
  dead,
  role,
}: {
  nightNumber: number;
  stepLabel: string | null;
  dead?: boolean;
  /** The local (living) player's own role — a persistent reminder of who they
   *  are, shown big + white under the NIGHT N line. Omitted for spectators. */
  role?: string;
}) {
  return (
    <View className="px-4 pt-10 pb-3 items-center">
      <Text
        className="text-wolf-muted text-lg font-bold tracking-widest"
        style={SCENE_TEXT_SHADOW}
      >
        NIGHT {nightNumber}
      </Text>
      {dead && (
        <Text className="text-wolf-red text-xs font-bold tracking-widest mt-0.5">
          SPECTATING
        </Text>
      )}
      {role ? (
        <Text
          className="text-wolf-text font-extrabold tracking-widest mt-1 text-center"
          style={{ fontSize: 22, ...SCENE_TEXT_SHADOW }}
        >
          {role.toUpperCase()}
        </Text>
      ) : null}
      {stepLabel ? (
        <Text
          className="text-wolf-text text-base font-bold tracking-widest mt-1 text-center"
          style={SCENE_TEXT_SHADOW}
        >
          {stepLabel.toUpperCase()}
        </Text>
      ) : null}
    </View>
  );
}

// ───── Shared confirmation overlay ─────────────────────────────────────────
//
// A dim backdrop with a content-hugging card for the night pickers' "Are you
// sure?" step. The card sizes to its children (it does NOT stretch to the
// screen), so the dark surface only frames the actual prompt + buttons rather
// than blacking out the whole screen. Each picker passes its own body (label /
// name / subtitle) as children; this owns the card chrome and the NO/YES row.

function ConfirmOverlay({
  children,
  onCancel,
  onConfirm,
  submitting,
  confirmLabel = 'YES',
  cancelLabel = 'NO',
  confirmTone = 'accent',
}: {
  children: React.ReactNode;
  onCancel: () => void;
  onConfirm: () => void;
  submitting?: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 'accent' = gold YES (default); 'danger' = red YES for lethal actions. */
  confirmTone?: 'accent' | 'danger';
}) {
  const danger = confirmTone === 'danger';
  return (
    <View
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
        backgroundColor: 'transparent',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <View
        className="bg-wolf-surface rounded-3xl"
        style={{
          alignItems: 'center',
          alignSelf: 'center',
          maxWidth: 360,
          paddingTop: 26,
          paddingBottom: 22,
          paddingHorizontal: 26,
          borderWidth: 1,
          borderColor: '#2C2C3A',
        }}
      >
        {children}
        <View className="flex-row" style={{ gap: 14, marginTop: 24 }}>
          <TouchableOpacity
            onPress={onCancel}
            disabled={submitting}
            className="bg-wolf-card rounded-xl py-4 px-10"
            style={{ borderWidth: 1, borderColor: '#3A3A48' }}
          >
            <Text className="text-wolf-text text-base font-extrabold tracking-widest">
              {cancelLabel}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={onConfirm}
            disabled={submitting}
            style={{ opacity: submitting ? 0.4 : 1 }}
            className={`rounded-xl py-4 px-10 ${danger ? 'bg-wolf-red' : 'bg-wolf-accent'}`}
          >
            {submitting ? (
              <ActivityIndicator color={danger ? '#F0EDE8' : '#0F0F14'} />
            ) : (
              <Text
                className={`text-base font-extrabold tracking-widest ${danger ? 'text-wolf-text' : 'text-wolf-bg'}`}
              >
                {confirmLabel}
              </Text>
            )}
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

// Shared layout for every night picker. The ring is pinned to the SAME
// absolute screen anchor the day phase uses (ringAnchorStyle), so it occupies
// the exact same on-screen coordinates on every screen — day, night, and all
// pickers — with no jump. The ring is out of flow, so the info panels simply
// flow at the top and the controls at the bottom; neither affects where the
// ring sits. Panels are the picker's responsibility to keep compact (e.g. the
// wolves' collapsible pack) since anything tall will float over the ring's top.
function NightPickerLayout({
  children,
  ring,
  footer,
}: {
  /** Info panels — flow at the top, above the ring. */
  children?: React.ReactNode;
  /** Render-prop given the (fixed) circle size for the anchored ring. */
  ring: (circleSize: number) => React.ReactNode;
  /** Optional controls pinned at the bottom, below the ring. */
  footer?: React.ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const ringAnchor = useRingAnchorStyle();
  return (
    <View style={{ flex: 1 }}>
      {/* Ring pinned to the shared absolute anchor (corrected for the remote-
          chat bar). box-none lets taps reach the seats but not this wrapper. */}
      <View pointerEvents="box-none" style={ringAnchor}>
        {ring(RING_SIZE)}
      </View>
      {children != null && (
        <View style={{ paddingHorizontal: 24, paddingTop: 8 }}>{children}</View>
      )}
      {footer != null && (
        <View
          style={{
            marginTop: 'auto',
            paddingHorizontal: 24,
            // Sit just above the safe-area edge (no extra top padding) so the
            // buttons drop clear of the fixed, low-sitting ring above them.
            paddingBottom: Math.max(insets.bottom, 12),
          }}
        >
          {footer}
        </View>
      )}
    </View>
  );
}

// ───── Cursed conversion reveal ────────────────────────────────────────────
//
// Shown to the converted Cursed (and dead spectators) during the
// cursed_conversion night step. The body sentence has YOU / ARE / A / WOLF
// rendered in red so the four red words read top-to-bottom as the subliminal
// "you are a wolf". No OK button — the step dwells and auto-advances
// (reveal-no-ack rule), so a distracted player can't stall the table. Dead
// spectators see the reveal passively.

function CursedRevealView({
  isMine,
  convertedNames,
}: {
  isMine: boolean;
  convertedNames: string[];
}) {
  return (
    <View className="flex-1 px-6 pt-2 pb-8">
      <View className="flex-1 items-center justify-center">
        <Text className="text-wolf-text text-xs font-bold tracking-widest text-center mb-6">
          A CURSE TAKES HOLD
        </Text>
        <Text className="text-wolf-text text-3xl font-extrabold text-center leading-10 px-2">
          <Text className="text-wolf-red font-extrabold">YOU</Text>
          {' WERE TARGETED TONIGHT, BUT '}
          <Text className="text-wolf-red font-extrabold">ARE</Text>
          {' STILL ALIVE. '}
          <Text className="text-wolf-red font-extrabold">A</Text>
          {' CURSE CONVERTED YOU INTO A '}
          <Text className="text-wolf-red font-extrabold">WOLF</Text>
          {'.'}
        </Text>
        {!isMine && convertedNames.length > 0 && (
          <Text className="text-wolf-muted text-xs tracking-widest mt-6 text-center px-4">
            {convertedNames.join(', ').toUpperCase()} HAS BEEN CURSED
          </Text>
        )}
      </View>
    </View>
  );
}

// ───── Alpha Wolf conversion reveal ────────────────────────────────────────
//
// Shown during the alpha_conversion step to the converted player (alive
// caller, `isMine`) and to dead spectators (ghost mirror). No OK button —
// the step dwells and auto-advances (reveal-no-ack rule), so a distracted
// player can't stall the table. The converted player's role still reads as
// their original one this night (the flip lands at morning); they only learn
// their packmates when they wake with the wolves next night. Other living
// players see the generic WaitingView — they have no way to tell whether the
// wolves converted them tonight.

function AlphaConversionView({
  isMine,
  convertedName,
}: {
  isMine: boolean;
  convertedName: string;
}) {
  return (
    <View className="flex-1 px-6 pt-2 pb-8">
      <View className="flex-1 items-center justify-center">
        <Text className="text-wolf-muted text-xs font-bold tracking-widest text-center mb-6">
          A HOWL IN THE DARK
        </Text>
        {isMine ? (
          <>
            <Text className="text-wolf-text text-2xl font-extrabold text-center leading-8 px-2">
              {'THE PACK HAS CLAIMED '}
              <Text className="text-wolf-red">YOU</Text>
              {'. YOU ARE NOW A '}
              <Text className="text-wolf-red">WOLF</Text>
              {'.'}
            </Text>
            <Text className="text-wolf-text text-sm text-center mt-6 px-4">
              Tomorrow night you wake with the wolves and learn who they are.
            </Text>
          </>
        ) : (
          <Text className="text-wolf-muted text-xs tracking-widest text-center px-4">
            {convertedName.toUpperCase()} HAS BEEN TURNED INTO A WOLF
          </Text>
        )}
      </View>
    </View>
  );
}

// ───── Doppelganger reveal ─────────────────────────────────────────────────
//
// Shown during the dawn / dusk steps to the converted Doppelganger (alive
// caller) and to dead spectators (ghost mirror). The alive Doppelganger
// must tap OK to advance the step; ghosts see the same modal passively.
// Other living players see the generic WaitingView — only the converted
// player learns what role they've inherited.

function DoppelgangerRevealView({
  isMine,
  fromRole,
  toRole,
  conversions,
}: {
  isMine: boolean;
  fromRole?: string;
  toRole?: string;
  conversions: Array<{ name: string; toRole: string }>;
}) {
  return (
    <View className="flex-1 px-6 pt-2 pb-8 items-center justify-center">
      <Text className="text-wolf-muted text-xs font-bold tracking-widest text-center mb-6">
        A NEW FACE
      </Text>
      {isMine && toRole ? (
        <View
          className="bg-wolf-card rounded-2xl px-6 py-6"
          style={{ maxWidth: 360 }}
        >
          <Text className="text-wolf-text text-base leading-6 text-center">
            {'Your target has been eliminated. You were the '}
            <Text className="text-wolf-accent font-extrabold">
              {(fromRole ?? 'Doppelganger').toUpperCase()}
            </Text>
            {'. You are now the '}
            <Text className="text-wolf-accent font-extrabold">
              {toRole.toUpperCase()}
            </Text>
            {'.'}
          </Text>
          <Text className="text-wolf-text text-xs text-center mt-4">
            Your old powers fade. You start fresh with this role.
          </Text>
        </View>
      ) : (
        conversions.length > 0 && (
          <View
            className="bg-wolf-card rounded-2xl px-6 py-6"
            style={{ maxWidth: 360 }}
          >
            {conversions.map(c => (
              <Text
                key={c.name}
                className="text-wolf-text text-base leading-6 text-center"
              >
                <Text className="text-wolf-accent font-extrabold">
                  {c.name.toUpperCase()}
                </Text>
                {' is now the '}
                <Text className="text-wolf-accent font-extrabold">
                  {c.toRole.toUpperCase()}
                </Text>
                {'.'}
              </Text>
            ))}
          </View>
        )
      )}
    </View>
  );
}

// ───── Sasquatch conversion overlay ────────────────────────────────────────
//
// Rendered on the flipped Sasquatch's phone at the start of the wolves step,
// the night after a day with no lynch. Blocks the picker briefly so the player
// reads the role change before they're asked to vote with the pack. Server
// clears `pendingSasquatchReveal` when the wolves step advances; client also
// dismisses after the 5 s reading window so the picker is reachable even if
// the dwell drags on.

function SasquatchRevealOverlay({
  visible,
  wolves,
}: {
  visible: boolean;
  wolves: Array<{
    _id: Id<'players'>;
    name: string;
    role: string;
    isMe: boolean;
  }>;
}) {
  const otherWolves = wolves.filter(w => !w.isMe);
  return (
    <Modal visible={visible} transparent animationType="fade">
      <View className="flex-1 bg-wolf-bg items-center justify-center px-6">
        <Text className="text-wolf-muted text-xs font-bold tracking-widest text-center mb-6">
          A NEW PACK
        </Text>
        <View
          className="bg-wolf-card rounded-2xl px-6 py-6"
          style={{ maxWidth: 360 }}
        >
          <Text className="text-wolf-text text-base leading-6 text-center">
            {'The village let a day end without a lynch. You '}
            <Text className="text-wolf-red font-extrabold">JOIN</Text>
            {' the '}
            <Text className="text-wolf-red font-extrabold">WOLVES</Text>
            {' out of spite.'}
          </Text>
          {otherWolves.length > 0 && (
            <View className="mt-5">
              <Text className="text-wolf-muted text-xs font-bold tracking-widest text-center mb-2">
                YOUR PACK
              </Text>
              {otherWolves.map(w => (
                <Text
                  key={w._id}
                  className="text-wolf-accent text-base font-extrabold text-center"
                >
                  {w.name.toUpperCase()}
                </Text>
              ))}
            </View>
          )}
          <Text className="text-wolf-text text-xs text-center mt-5">
            You wake with the wolves now. Choose a victim together.
          </Text>
        </View>
      </View>
    </Modal>
  );
}

// ───── Drunk sober-up overlay ──────────────────────────────────────────────
//
// Rendered on the sobered Drunk's phone at the start of N3, when their hidden
// role takes over. Auto-dismisses after the 5 s reading window (no OK button —
// reveal-no-ack rule). When the hidden role is a wolf they wake with the pack
// THAT night, so the roster is shown; otherwise it announces the new role and
// its power so they can act tonight if it's a night role.

function DrunkRevealOverlay({
  visible,
  toRole,
  wolves,
}: {
  visible: boolean;
  toRole: string;
  wolves: Array<{ _id: Id<'players'>; name: string }>;
}) {
  const becameWolf = !!toRole && isWolfTeam(toRole);
  const description = getRoleDescription(toRole);
  return (
    <Modal visible={visible} transparent animationType="fade">
      <View className="flex-1 bg-wolf-bg items-center justify-center px-6">
        <Text className="text-wolf-muted text-xs font-bold tracking-widest text-center mb-6">
          THE ROOM STOPS SPINNING
        </Text>
        <View
          className="bg-wolf-card rounded-2xl px-6 py-6"
          style={{ maxWidth: 360 }}
        >
          <Text className="text-wolf-text text-base leading-6 text-center">
            {'You sober up and remember who you really are. You are the '}
            <Text
              className={becameWolf ? 'font-extrabold' : 'text-wolf-accent font-extrabold'}
              style={becameWolf ? { color: '#B03A2E' } : undefined}
            >
              {toRole.toUpperCase()}
            </Text>
            {'.'}
          </Text>
          {becameWolf ? (
            <>
              {wolves.length > 0 && (
                <View className="mt-5">
                  <Text className="text-wolf-muted text-xs font-bold tracking-widest text-center mb-2">
                    YOUR PACK
                  </Text>
                  {wolves.map(w => (
                    <Text
                      key={w._id}
                      className="text-wolf-accent text-base font-extrabold text-center"
                    >
                      {w.name.toUpperCase()}
                    </Text>
                  ))}
                </View>
              )}
              <Text className="text-wolf-text text-xs text-center mt-5">
                You wake with the wolves tonight. Choose a victim together.
              </Text>
            </>
          ) : (
            description && (
              <Text className="text-wolf-text text-sm text-center mt-4">
                {description}
              </Text>
            )
          )}
        </View>
      </View>
    </Modal>
  );
}

// ───── Wolves blocked view ─────────────────────────────────────────────────
//
// Shown ONLY to wolves on the night following a Diseased kill. Wolves need
// to know they can't act (so they don't sit confused waiting for a picker);
// the rest of the table hears nothing about it and has to figure out at
// morning why no one died. Step still dwells normally for cloaking.

function WolvesBlockedView({
  wolves,
  isGhost,
}: {
  wolves: Array<{
    _id: Id<'players'>;
    name: string;
    role: string;
    isMe: boolean;
  }>;
  isGhost?: boolean;
}) {
  return (
    <View className="flex-1 px-6 pt-2 pb-8">
      <View className="bg-wolf-card rounded-xl px-5 py-5 mb-5">
        <Text className="text-wolf-red text-base font-extrabold tracking-widest text-center mb-2">
          THE BLOOD WAS DISEASED
        </Text>
        <Text className="text-wolf-text text-sm text-center">
          The pack is sickened. There is no kill tonight.
        </Text>
      </View>

      <View className="bg-wolf-card rounded-xl px-4 py-3">
        <Text className="text-wolf-muted text-xs font-bold tracking-widest mb-2">
          {isGhost ? 'THE PACK' : 'YOUR PACK'}
        </Text>
        {wolves.map(w => (
          <View
            key={w._id}
            className="flex-row items-center justify-between py-1"
          >
            <Text className="text-wolf-text text-sm">
              {w.isMe ? 'You' : w.name}{' '}
              <Text className="text-wolf-muted text-xs">({w.role})</Text>
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

// ───── Wolves picker ────────────────────────────────────────────────────────

// How long the RNG bouncing-highlight animation runs before the red-fill
// kicks in on the final target. Paired with WOLF_KILL_RNG_DWELL_MS on the
// server (5 s total): ~2 s here + ~3 s for the fill.
const RNG_BOUNCE_MS = 2000;
const RNG_BOUNCE_STEP_MS = 130;

function WolvesPicker({
  gameId,
  deviceClientId,
  alivePlayers,
  targetables,
  totalSeats,
  meId,
  meSeatPosition,
  wolves,
  requiredKills,
  killsSoFar,
  pendingKill,
  pickerEndsAt,
  convertActive,
  isGhost,
}: {
  gameId: Id<'games'>;
  deviceClientId: string;
  alivePlayers: SeatingPlayer[];
  targetables: Targetable[];
  totalSeats: number;
  meId: Id<'players'>;
  meSeatPosition?: number;
  wolves: Array<{
    _id: Id<'players'>;
    name: string;
    role: string;
    isMe: boolean;
    currentVote?: Id<'players'>;
  }>;
  requiredKills: number;
  killsSoFar: Array<{ targetId: Id<'players'>; targetName: string }>;
  pendingKill: {
    targetPlayerId: Id<'players'>;
    dwellEndsAt: number;
    kind: 'consensus' | 'rng';
    candidatePlayerIds: Id<'players'>[];
  } | null;
  pickerEndsAt: number | null;
  convertActive: boolean;
  isGhost?: boolean;
}) {
  const submitVote = useMutation(api.night.submitWolfVote);
  const [submitting, setSubmitting] = useState(false);

  const myVote = wolves.find(w => w.isMe)?.currentVote;
  const consensus =
    wolves.length > 0 &&
    wolves.every(w => w.currentVote && w.currentVote === wolves[0].currentVote);
  const vengeance = requiredKills > 1;
  const allKillsLocked = killsSoFar.length >= requiredKills;
  const killNumber = killsSoFar.length + 1;
  // Alpha Wolf conversion night: the FIRST pick (no picks locked yet) converts
  // a villager into a wolf instead of killing. A Wolf Cub vengeance round 2 on
  // the same night reverts to a normal kill.
  const isConvertRound = convertActive && killsSoFar.length === 0;

  // RNG bounce — cycles a highlight through `candidatePlayerIds` for
  // RNG_BOUNCE_MS, then settles. The seating circle picks up the
  // pending-fill animation only after the bounce ends, so the dwellEndsAt
  // (5 s out for RNG) ends up split into ~2 s bounce + ~3 s fill.
  const isRngPick =
    pendingKill?.kind === 'rng' &&
    pendingKill.candidatePlayerIds.length > 1;
  const [bounceId, setBounceId] = useState<Id<'players'> | null>(null);
  const [bouncing, setBouncing] = useState(false);
  // Pack panel starts collapsed to a single row so it doesn't cover the ring;
  // the wolf can expand it (dropping over the ring) and collapse it back.
  const [packOpen, setPackOpen] = useState(false);
  // Keyed on dwellEndsAt so vengeance kill #2's RNG round (new pendingKill
  // with a new deadline) restarts the bounce cleanly.
  const bounceKey = isRngPick ? pendingKill!.dwellEndsAt : null;
  useEffect(() => {
    if (!isRngPick || !pendingKill || bounceKey == null) {
      setBouncing(false);
      setBounceId(null);
      return;
    }
    const candidates = pendingKill.candidatePlayerIds;
    const target = pendingKill.targetPlayerId;
    const totalSteps = Math.max(1, Math.floor(RNG_BOUNCE_MS / RNG_BOUNCE_STEP_MS));
    setBouncing(true);
    // Seed with a random candidate so the very first hop isn't always the
    // same array index — that was what made the prior bounce look like a
    // clockwise sweep through the seating circle.
    let currentIdx = Math.floor(Math.random() * candidates.length);
    setBounceId(candidates[currentIdx]);
    let stepCount = 1;
    const interval = setInterval(() => {
      stepCount++;
      if (stepCount >= totalSteps) {
        // Final hop locks onto the server's actual pick. The red fill
        // animation that follows takes over on this same seat, so the
        // transition stays visually anchored instead of darting off to
        // a seat the bounce never touched.
        setBounceId(target);
        return;
      }
      if (candidates.length === 1) return;
      // Reject same-as-previous so consecutive frames always show motion.
      let nextIdx = Math.floor(Math.random() * candidates.length);
      if (nextIdx === currentIdx) {
        nextIdx = (nextIdx + 1) % candidates.length;
      }
      currentIdx = nextIdx;
      setBounceId(candidates[currentIdx]);
    }, RNG_BOUNCE_STEP_MS);
    const timeout = setTimeout(() => {
      clearInterval(interval);
      setBouncing(false);
      setBounceId(null);
    }, RNG_BOUNCE_MS);
    return () => {
      clearInterval(interval);
      clearTimeout(timeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bounceKey]);

  // Per-seat tap labels mirroring the day-phase nomTaps UI: each wolf's
  // live vote shows their name under the target seat in red. When several
  // wolves agree, all names stack under the same seat. The server hides
  // these labels on the pending-kill seat (it plays the red-fill instead).
  const wolfTaps: SeatNomTap[] = wolves
    .filter(w => !!w.currentVote)
    .map(w => ({
      targetPlayerId: w.currentVote as unknown as string,
      nominatorName: w.name,
      isMe: w.isMe,
    }));
  // Hide already-locked-in victims from the picker for kill #2.
  const lockedIds = new Set<string>(
    killsSoFar.map(k => k.targetId as unknown as string),
  );
  // On the conversion round the pack can only turn a non-wolf into a wolf, so
  // packmates aren't selectable (matches the server guard in submitWolfVote).
  const wolfIds = new Set<string>(
    wolves.map(w => w._id as unknown as string),
  );
  const selectableForThisKill = new Set(
    targetables
      .map(t => t._id as unknown as string)
      .filter(id => !lockedIds.has(id))
      .filter(id => !isConvertRound || !wolfIds.has(id)),
  );

  async function handleVote(targetId: Id<'players'>) {
    if (submitting) return;
    setSubmitting(true);
    try {
      await submitVote({
        gameId,
        callerDeviceClientId: deviceClientId,
        targetPlayerId: targetId,
      });
    } catch (e) {
      showAlert('Could not vote', e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  // While the RNG bounce is running, the pending fill on the seating
  // circle is suppressed (we'll hand it `null` for targetId/dwellEndsAt
  // until the bounce settles, at which point ~3 s of dwell remain to
  // play the fill). The bouncing seat itself rides the existing
  // selectedId styling so it gets the red ring as the highlight hops.
  const showPendingFill = !!pendingKill && !bouncing;
  const seatSelectedId = bouncing
    ? bounceId ?? undefined
    : pendingKill
      ? undefined
      : myVote;
  // Wipe the per-wolf tap labels for the entire pendingKill window. They'd
  // otherwise leave static red rings on the tied candidates during a
  // bouncing RNG roll, drowning out the highlight as it hops — and on the
  // settle/fill phase they're just redundant with the red-fill animation.
  // Matches the day-phase rhythm where `wipeNomTapsForDay` clears taps
  // the moment a trial confirms.
  const seatTaps: SeatNomTap[] = pendingKill ? [] : wolfTaps;
  const showCountdown =
    !pendingKill && !allKillsLocked && pickerEndsAt != null;

  // Status line above the pack panel. The bounce phase gets its own
  // "rolling dice" message so wolves understand a random pick is in
  // progress; the post-bounce settle and consensus paths share the
  // generic "sealing" copy.
  const statusText = allKillsLocked
    ? 'Sealing the night…'
    : bouncing
      ? "Time's up — picking a target…"
      : pendingKill || consensus
        ? isConvertRound
          ? 'Consensus reached. Sealing the conversion…'
          : 'Consensus reached. Sealing the kill…'
        : isGhost
          ? 'The wolves are voting. They must agree.'
          : isConvertRound
            ? 'Tap a player to convert into a wolf. All wolves must agree.'
            : 'Tap a player to vote. All wolves must agree.';

  return (
    <View className="flex-1">
      <NightPickerLayout
        ring={circleSize => (
          <SeatingCircle
            size={circleSize}
            phase="night"
            totalSeats={totalSeats}
            players={alivePlayers}
            meId={meId}
            viewerSeatIndex={meSeatPosition}
            selectedId={seatSelectedId}
            selectedVariant="danger"
            selectableIds={selectableForThisKill}
            nomTaps={seatTaps}
            pendingTrialTargetId={
              showPendingFill ? pendingKill!.targetPlayerId : null
            }
            pendingTrialDwellEndsAt={
              showPendingFill ? pendingKill!.dwellEndsAt : null
            }
            onPress={
              !submitting && !consensus && !allKillsLocked && !pendingKill
                ? p => handleVote(p._id)
                : undefined
            }
          />
        )}
      >
        {convertActive ? (
          <View className="bg-wolf-card rounded-xl px-4 py-3 mb-3 border border-wolf-red">
            <Text className="text-wolf-red text-xs font-bold tracking-widest text-center">
              ALPHA WOLF — CONVERSION
            </Text>
            <Text className="text-wolf-text text-sm text-center mt-1">
              {vengeance
                ? allKillsLocked
                  ? 'CONVERSION + KILL LOCKED'
                  : isConvertRound
                    ? 'STEP 1 OF 2 — CONVERT'
                    : 'STEP 2 OF 2 — KILL'
                : isConvertRound
                  ? 'Turn a villager into a wolf — no one dies tonight'
                  : 'CONVERSION LOCKED'}
            </Text>
            {vengeance && (
              <Text className="text-wolf-muted text-xs text-center mt-2">
                Convert first, then a Wolf Cub vengeance kill.
              </Text>
            )}
            {killsSoFar.length > 0 && (
              <Text className="text-wolf-muted text-xs text-center mt-2">
                {isConvertRound ? 'Converting: ' : 'Converted: '}
                <Text className="text-wolf-red">
                  {killsSoFar.map(k => k.targetName).join(', ')}
                </Text>
              </Text>
            )}
          </View>
        ) : vengeance ? (
          <View className="bg-wolf-card rounded-xl px-4 py-3 mb-3 border border-wolf-red">
            <Text className="text-wolf-red text-xs font-bold tracking-widest text-center">
              WOLF CUB VENGEANCE
            </Text>
            <Text className="text-wolf-text text-sm text-center mt-1">
              {allKillsLocked
                ? `${requiredKills} KILLS LOCKED`
                : `KILL ${killNumber} OF ${requiredKills}`}
            </Text>
            {killsSoFar.length > 0 && (
              <Text className="text-wolf-muted text-xs text-center mt-2">
                {allKillsLocked ? 'Victims: ' : 'Already taken: '}
                <Text className="text-wolf-red">
                  {killsSoFar.map(k => k.targetName).join(', ')}
                </Text>
              </Text>
            )}
          </View>
        ) : null}

        <Text className="text-wolf-text text-base text-center mt-2 mb-3">
          {statusText}
        </Text>

        {/* Shot clock — kept in this top region (not the ring center) so it
            stays visible when the remote chat is expanded over the picker. */}
        {showCountdown && (
          <View
            className="flex-row items-center justify-center mb-4"
            style={{ gap: 10 }}
          >
            <Text className="text-wolf-muted text-xs font-bold tracking-widest">
              TIME LEFT
            </Text>
            <WolfShotClock endsAt={pickerEndsAt!} size={32} />
          </View>
        )}

        {/* Wolf-pack awareness panel — collapsible so it can fold to one row
            and leave the ring visible. */}
        <View className="bg-wolf-card rounded-xl px-4 py-3 mb-5">
          <TouchableOpacity
            onPress={() => setPackOpen(o => !o)}
            activeOpacity={0.7}
            className="flex-row items-center justify-between"
          >
            <Text className="text-wolf-muted text-xs font-bold tracking-widest">
              {isGhost ? 'THE PACK' : 'YOUR PACK'}
            </Text>
            <Text className="text-wolf-muted text-xs font-bold">
              {packOpen ? '▲' : '▼'}
            </Text>
          </TouchableOpacity>
          {packOpen && (
            <View className="mt-2">
              {wolves.map(w => {
                const targetName = w.currentVote
                  ? targetables.find(t => t._id === w.currentVote)?.name ?? '—'
                  : null;
                return (
                  <View
                    key={w._id}
                    className="flex-row items-center justify-between py-1"
                  >
                    <Text className="text-wolf-text text-sm">
                      {w.isMe ? 'You' : w.name}{' '}
                      <Text className="text-wolf-muted text-xs">({w.role})</Text>
                    </Text>
                    <Text
                      className={
                        targetName
                          ? 'text-wolf-red text-sm'
                          : 'text-wolf-muted text-sm'
                      }
                    >
                      {targetName ?? 'no vote'}
                    </Text>
                  </View>
                );
              })}
            </View>
          )}
        </View>
      </NightPickerLayout>
    </View>
  );
}

// Wolves' shot-clock countdown. >10 s: solid white. 1–10 s: red on even
// seconds (10, 8, 6, 4, 2) and white on odd seconds (9, 7, 5, 3, 1) — one
// swap per whole second, paced with the digit. 0 s: solid red (the server's
// `wolfPickerTimeoutTick` is firing right then; pendingKill lands on the next
// query tick and the clock disappears). Rendered in the top region (not the
// ring center) so it stays visible when the remote chat covers the picker.
function WolfShotClock({ endsAt, size = 56 }: { endsAt: number; size?: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 150);
    return () => clearInterval(id);
  }, []);
  const remainingSec = Math.max(0, Math.ceil((endsAt - now) / 1000));
  const isLow = remainingSec > 0 && remainingSec <= 10;
  const isDone = remainingSec === 0;
  const flashRed = isLow && remainingSec % 2 === 0;
  const color = isDone || flashRed ? '#B03A2E' : '#F0EDE8';
  return (
    <Text
      style={{
        color,
        fontSize: size,
        fontWeight: '800',
        fontVariant: ['tabular-nums'],
      }}
    >
      {remainingSec}
    </Text>
  );
}

// ───── Seer picker ──────────────────────────────────────────────────────────

function SeerPicker({
  gameId,
  deviceClientId,
  alivePlayers,
  targetables,
  totalSeats,
  meId,
  meSeatPosition,
  history,
  nightNumber,
  isGhost,
}: {
  gameId: Id<'games'>;
  deviceClientId: string;
  alivePlayers: SeatingPlayer[];
  targetables: Targetable[];
  totalSeats: number;
  meId: Id<'players'>;
  meSeatPosition?: number;
  history: Array<{
    nightNumber: number;
    targetName: string;
    team: 'wolf' | 'villager';
  }>;
  nightNumber: number;
  isGhost?: boolean;
}) {
  const alreadyChecked = history.some(h => h.nightNumber === nightNumber);
  const submitCheck = useMutation(api.night.submitSeerCheck);
  const [submitting, setSubmitting] = useState(false);
  const [pendingTarget, setPendingTarget] = useState<{
    id: Id<'players'>;
    name: string;
  } | null>(null);
  const [pendingResult, setPendingResult] = useState<{
    name: string;
    team: 'wolf' | 'villager';
  } | null>(null);
  const fadeAnim = useState(new Animated.Value(0))[0];

  useEffect(() => {
    if (pendingResult) {
      fadeAnim.setValue(0);
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 280,
        easing: Easing.out(Easing.ease),
        useNativeDriver: true,
      }).start();
    }
  }, [pendingResult, fadeAnim]);

  function handlePickTarget(targetId: Id<'players'>, name: string) {
    if (submitting || pendingTarget || pendingResult) return;
    setPendingTarget({ id: targetId, name });
  }

  async function handleConfirm() {
    if (!pendingTarget || submitting) return;
    setSubmitting(true);
    try {
      const result = await submitCheck({
        gameId,
        callerDeviceClientId: deviceClientId,
        targetPlayerId: pendingTarget.id,
      });
      setPendingResult({ name: pendingTarget.name, team: result.team });
      setPendingTarget(null);
    } catch (e) {
      showAlert('Could not check', e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  function handleCancel() {
    if (submitting) return;
    setPendingTarget(null);
  }

  // Once the player has checked, hide the picker — we hold here until the
  // step's dwell ends, which keeps the on-screen "the seer is awake" timing
  // uniform whether the seer is alive or dead.
  if (alreadyChecked && !pendingResult) {
    return (
      <View className="flex-1 px-6 pt-2 pb-8">
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color="#D4A017" />
          <Text className="text-wolf-text text-sm text-center mt-6 px-4">
            {isGhost ? "The Seer's check is in. Waiting for the night to settle…" : 'Your check is in. Waiting for the night to settle…'}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View className="flex-1">
      <NightPickerLayout
        ring={circleSize => (
          <SeatingCircle
            size={circleSize}
            phase="night"
            totalSeats={totalSeats}
            players={alivePlayers}
            meId={meId}
            viewerSeatIndex={meSeatPosition}
            selectableIds={
              new Set(targetables.map(t => t._id as unknown as string))
            }
            onPress={
              submitting || pendingTarget || pendingResult
                ? undefined
                : p => handlePickTarget(p._id, p.name)
            }
          />
        )}
      >
        <Text className="text-wolf-text text-base text-center mt-2 mb-4">
          {isGhost
            ? 'The Seer is investigating…'
            : 'Choose a player to investigate.'}
        </Text>
      </NightPickerLayout>

      {/* Confirmation overlay — guards against misclicks before the role
          information is given. Uses the same dark backdrop as the result
          overlay for visual consistency. */}
      {pendingTarget && !pendingResult && (
        <ConfirmOverlay
          onCancel={handleCancel}
          onConfirm={handleConfirm}
          submitting={submitting}
        >
          <Text className="text-wolf-muted text-xs font-bold tracking-widest mb-3">
            INVESTIGATE
          </Text>
          <Text className="text-wolf-text text-3xl font-extrabold text-center mb-2">
            {pendingTarget.name.toUpperCase()}
          </Text>
          <Text className="text-wolf-muted text-sm text-center">
            Are you sure?
          </Text>
        </ConfirmOverlay>
      )}

      {/* Result overlay — auto-dismisses when the step's reading-window dwell
          ends and the engine advances (unmounting this picker), so a player
          who forgets to dismiss can't stall the night. */}
      {pendingResult && (
        <Animated.View
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 0,
            bottom: 0,
            backgroundColor: 'transparent',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
            opacity: fadeAnim,
          }}
        >
          <View
            className="bg-wolf-surface rounded-3xl"
            style={{
              alignItems: 'center',
              alignSelf: 'center',
              maxWidth: 460,
              width: '100%',
              paddingTop: 40,
              paddingBottom: 34,
              paddingHorizontal: 32,
              borderWidth: 1,
              borderColor: '#2C2C3A',
            }}
          >
            <Text className="text-wolf-text text-3xl font-extrabold text-center">
              {pendingResult.name.toUpperCase()}
            </Text>
            <Text className="text-wolf-muted text-xl text-center my-2">
              IS A
            </Text>
            <View
              className="bg-wolf-card"
              style={{ height: 1, width: '75%', marginVertical: 26 }}
            />
            <Text
              className="text-4xl font-extrabold tracking-widest text-center"
              style={{ color: pendingResult.team === 'wolf' ? '#E0574B' : '#5BA0E5' }}
            >
              {pendingResult.team === 'wolf' ? 'WOLF' : 'VILLAGER'}
            </Text>
            <Text className="text-wolf-muted text-sm text-center mt-7">
              Take a moment to remember this…
            </Text>
          </View>
        </Animated.View>
      )}
    </View>
  );
}

// ───── Waiting view ─────────────────────────────────────────────────────────

// ───── PI picker ───────────────────────────────────────────────────────────

function PIPicker({
  gameId,
  deviceClientId,
  alivePlayers,
  targetables,
  totalSeats,
  meId,
  meSeatPosition,
  piState,
  isGhost,
}: {
  gameId: Id<'games'>;
  deviceClientId: string;
  alivePlayers: SeatingPlayer[];
  targetables: Targetable[];
  totalSeats: number;
  meId: Id<'players'>;
  meSeatPosition?: number;
  piState: {
    piUsed: boolean;
    hasActedThisNight: boolean;
    history: Array<{
      nightNumber: number;
      targetName: string;
      team: 'wolf' | 'village';
    }>;
  };
  isGhost?: boolean;
}) {
  const submitCheck = useMutation(api.night.submitPICheck);
  const submitSkip = useMutation(api.night.submitPISkip);

  const [submitting, setSubmitting] = useState(false);
  const [pendingTarget, setPendingTarget] = useState<{
    id: Id<'players'>;
    name: string;
  } | null>(null);
  const [pendingResult, setPendingResult] = useState<{
    name: string;
    team: 'wolf' | 'village';
  } | null>(null);
  const fadeAnim = useState(new Animated.Value(0))[0];

  useEffect(() => {
    if (pendingResult) {
      fadeAnim.setValue(0);
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 280,
        easing: Easing.out(Easing.ease),
        useNativeDriver: true,
      }).start();
    }
  }, [pendingResult, fadeAnim]);

  function handlePickTarget(targetId: Id<'players'>, name: string) {
    if (submitting || pendingTarget || pendingResult) return;
    setPendingTarget({ id: targetId, name });
  }

  async function handleConfirm() {
    if (!pendingTarget || submitting) return;
    setSubmitting(true);
    try {
      const result = await submitCheck({
        gameId,
        callerDeviceClientId: deviceClientId,
        targetPlayerId: pendingTarget.id,
      });
      setPendingResult({ name: pendingTarget.name, team: result.team });
      setPendingTarget(null);
    } catch (e) {
      showAlert('Could not investigate', e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  function handleCancel() {
    if (submitting) return;
    setPendingTarget(null);
  }

  async function handleSkip() {
    if (submitting) return;
    setSubmitting(true);
    try {
      await submitSkip({ gameId, callerDeviceClientId: deviceClientId });
    } catch (e) {
      showAlert('Error', e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  if (piState.hasActedThisNight && !pendingResult) {
    return (
      <View className="flex-1 px-6 pt-2 pb-8">
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color="#D4A017" />
          <Text className="text-wolf-text text-sm text-center mt-6 px-4">
            {piState.history.length > 0 &&
            piState.history[piState.history.length - 1]?.nightNumber !==
              undefined
              ? isGhost
                ? "The PI's check is in. Waiting for the night to settle…"
                : 'Your check is in. Waiting for the night to settle…'
              : 'Saved for later. Waiting for the night to settle…'}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View className="flex-1">
      <NightPickerLayout
        ring={circleSize => (
          <SeatingCircle
            size={circleSize}
            phase="night"
            totalSeats={totalSeats}
            players={alivePlayers}
            meId={meId}
            viewerSeatIndex={meSeatPosition}
            selectableIds={
              new Set(targetables.map(t => t._id as unknown as string))
            }
            onPress={
              submitting || pendingTarget || pendingResult
                ? undefined
                : p => handlePickTarget(p._id, p.name)
            }
          />
        )}
        footer={
          !isGhost ? (
            <TouchableOpacity
              onPress={handleSkip}
              disabled={submitting || !!pendingTarget || !!pendingResult}
              style={{
                opacity: submitting || pendingTarget || pendingResult ? 0.4 : 1,
              }}
              className="bg-wolf-card rounded-xl py-4 items-center"
            >
              <Text className="text-wolf-text text-base font-bold tracking-widest">
                SAVE FOR LATER
              </Text>
            </TouchableOpacity>
          ) : undefined
        }
      >
        <Text className="text-wolf-text text-base text-center mt-2 mb-2">
          {isGhost
            ? 'The PI is reading a player + their two neighbors as a group.'
            : 'One-time investigation. Pick a target to read them and their two neighbors as a group.'}
        </Text>

      </NightPickerLayout>

      {/* Confirmation overlay */}
      {pendingTarget && !pendingResult && (
        <ConfirmOverlay
          onCancel={handleCancel}
          onConfirm={handleConfirm}
          submitting={submitting}
        >
          <Text className="text-wolf-muted text-xs font-bold tracking-widest mb-3">
            INVESTIGATE
          </Text>
          <Text className="text-wolf-text text-3xl font-extrabold text-center mb-2">
            {pendingTarget.name.toUpperCase()}
          </Text>
          <Text className="text-wolf-muted text-sm text-center">
            Your only investigation. Are you sure?
          </Text>
        </ConfirmOverlay>
      )}

      {/* Result overlay — neutral card, auto-dismisses on the reading-window
          dwell (no OK button). */}
      {pendingResult && (
        <Animated.View
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 0,
            bottom: 0,
            backgroundColor: 'transparent',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
            opacity: fadeAnim,
          }}
        >
          <View
            className="bg-wolf-surface rounded-3xl"
            style={{
              alignItems: 'center',
              alignSelf: 'center',
              maxWidth: 460,
              width: '100%',
              paddingTop: 40,
              paddingBottom: 34,
              paddingHorizontal: 32,
              borderWidth: 1,
              borderColor: '#2C2C3A',
            }}
          >
            <Text className="text-wolf-text text-3xl font-extrabold text-center">
              {pendingResult.name.toUpperCase()}
            </Text>
            <Text className="text-wolf-muted text-xl text-center my-2">
              + NEIGHBORS
            </Text>
            <View
              className="bg-wolf-card"
              style={{ height: 1, width: '75%', marginVertical: 26 }}
            />
            <Text
              className="text-4xl font-extrabold tracking-widest text-center"
              style={{ color: pendingResult.team === 'wolf' ? '#E0574B' : '#5BA0E5' }}
            >
              {pendingResult.team === 'wolf' ? 'WOLF' : 'VILLAGE'}
            </Text>
            <Text className="text-wolf-muted text-sm text-center mt-7">
              Take a moment to remember this…
            </Text>
          </View>
        </Animated.View>
      )}
    </View>
  );
}

// ───── Mentalist picker ───────────────────────────────────────────────────

function MentalistPicker({
  gameId,
  deviceClientId,
  alivePlayers,
  targetables,
  totalSeats,
  meId,
  meSeatPosition,
  mentalistState,
  nightNumber,
  isGhost,
}: {
  gameId: Id<'games'>;
  deviceClientId: string;
  alivePlayers: SeatingPlayer[];
  targetables: Targetable[];
  totalSeats: number;
  meId: Id<'players'>;
  meSeatPosition?: number;
  mentalistState: {
    hasActedThisNight: boolean;
    noValidTargets: boolean;
    lockedTargets: Array<{ _id: Id<'players'>; name: string }>;
    history: Array<{
      nightNumber: number;
      firstName: string;
      secondName: string;
      sameTeam: 'same' | 'different';
    }>;
  };
  nightNumber: number;
  isGhost?: boolean;
}) {
  const submitCheck = useMutation(api.night.submitMentalistCheck);

  const [submitting, setSubmitting] = useState(false);
  const [picks, setPicks] = useState<Array<{ id: Id<'players'>; name: string }>>(
    [],
  );
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingResult, setPendingResult] = useState<{
    firstName: string;
    secondName: string;
    sameTeam: 'same' | 'different';
  } | null>(null);
  const fadeAnim = useState(new Animated.Value(0))[0];

  useEffect(() => {
    if (pendingResult) {
      fadeAnim.setValue(0);
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 280,
        easing: Easing.out(Easing.ease),
        useNativeDriver: true,
      }).start();
    }
  }, [pendingResult, fadeAnim]);

  const selectableSet = new Set(
    targetables.map(t => t._id as unknown as string),
  );
  const selectedSet = new Set(picks.map(p => p.id as unknown as string));

  function handleTap(player: SeatingPlayer) {
    if (submitting || confirmOpen || pendingResult) return;
    if (picks.find(p => p.id === player._id)) {
      // deselect
      setPicks(picks.filter(p => p.id !== player._id));
      return;
    }
    if (picks.length >= 2) return; // already two selected
    const next = [...picks, { id: player._id, name: player.name }];
    setPicks(next);
    // Second pick opens the confirmation immediately — no separate CONFIRM tap.
    if (next.length === 2) setConfirmOpen(true);
  }

  async function handleConfirm() {
    if (picks.length !== 2 || submitting) return;
    setSubmitting(true);
    try {
      const result = await submitCheck({
        gameId,
        callerDeviceClientId: deviceClientId,
        firstPlayerId: picks[0].id,
        secondPlayerId: picks[1].id,
      });
      setPendingResult({
        firstName: picks[0].name,
        secondName: picks[1].name,
        sameTeam: result.sameTeam,
      });
      setConfirmOpen(false);
      setPicks([]);
    } catch (e) {
      showAlert('Could not compare', e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  // Shorthanded — last night's two targets plus the alive pool leave fewer
  // than two legal picks. The engine auto-passes the step; we just explain
  // what's happening while the dwell runs.
  if (mentalistState.noValidTargets) {
    const lockedNames = mentalistState.lockedTargets.map(t => t.name);
    return (
      <View className="flex-1 px-6 pt-2 pb-8">
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color="#D4A017" />
          <Text className="text-wolf-text text-base text-center mt-6 px-4">
            Not enough new options tonight.
          </Text>
          <Text className="text-wolf-text text-sm text-center mt-3 px-6">
            {lockedNames.length > 0
              ? isGhost
                ? `Last night the Mentalist read ${lockedNames.join(' & ')}, and they can't be picked back-to-back.`
                : `Last night you read ${lockedNames.join(' & ')}, and they can't be picked back-to-back.`
              : isGhost
                ? 'The Mentalist needs at least two valid targets to read.'
                : 'You need at least two valid targets to read.'}
          </Text>
          <Text className="text-wolf-text text-xs text-center mt-4 px-6">
            Passing for the night…
          </Text>
        </View>
      </View>
    );
  }

  if (mentalistState.hasActedThisNight && !pendingResult) {
    const last = mentalistState.history[mentalistState.history.length - 1];
    return (
      <View className="flex-1 px-6 pt-2 pb-8">
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color="#D4A017" />
          <Text className="text-wolf-text text-sm text-center mt-6 px-4">
            {isGhost
              ? "The Mentalist's comparison is in. Waiting for the night to settle…"
              : 'Your comparison is in. Waiting for the night to settle…'}
          </Text>
        </View>
        {last && (
          <View className="bg-wolf-card rounded-xl px-4 py-3">
            <Text className="text-wolf-muted text-xs font-bold tracking-widest mb-2">
              TONIGHT'S READING
            </Text>
            <Text className="text-wolf-text text-sm">
              {last.firstName} & {last.secondName}
            </Text>
            <Text className="text-wolf-text text-sm font-bold mt-1">
              {last.sameTeam === 'same' ? 'SAME TEAM' : 'DIFFERENT TEAMS'}
            </Text>
          </View>
        )}
      </View>
    );
  }

  return (
    <View className="flex-1">
      <NightPickerLayout
        ring={circleSize => (
          <SeatingCircle
            size={circleSize}
            phase="night"
            totalSeats={totalSeats}
            players={alivePlayers}
            meId={meId}
            viewerSeatIndex={meSeatPosition}
            selectedIds={selectedSet}
            selectableIds={selectableSet}
            onPress={
              submitting || confirmOpen || pendingResult ? undefined : handleTap
            }
          />
        )}
      >
        <Text className="text-wolf-text text-base text-center mt-2 mb-2">
          {isGhost
            ? 'The Mentalist is comparing two players to see if they share a team.'
            : "Pick two players. You'll be told whether they share a team."}
        </Text>

        {mentalistState.lockedTargets.length > 0 && (
          <View className="bg-wolf-card rounded-xl px-4 py-3 mb-3">
            <Text className="text-wolf-text text-xs leading-5">
              Off-limits tonight (read them last night):{' '}
              <Text className="text-wolf-text font-bold">
                {mentalistState.lockedTargets.map(t => t.name).join(' & ')}
              </Text>
            </Text>
          </View>
        )}

      </NightPickerLayout>

      {/* Confirmation overlay */}
      {confirmOpen && (
        <ConfirmOverlay
          onCancel={() => {
            // Saying NO wipes the pair so the Mentalist can start fresh.
            setConfirmOpen(false);
            setPicks([]);
          }}
          onConfirm={handleConfirm}
          submitting={submitting}
        >
          <Text className="text-wolf-muted text-xs font-bold tracking-widest mb-3">
            COMPARE
          </Text>
          <Text className="text-wolf-text text-2xl font-extrabold text-center">
            {picks[0]?.name.toUpperCase()}
          </Text>
          <Text className="text-wolf-muted text-base text-center my-2">vs</Text>
          <Text className="text-wolf-text text-2xl font-extrabold text-center">
            {picks[1]?.name.toUpperCase()}
          </Text>
        </ConfirmOverlay>
      )}

      {/* Result overlay */}
      {pendingResult && (
        <Animated.View
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 0,
            bottom: 0,
            backgroundColor: 'transparent',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
            opacity: fadeAnim,
          }}
        >
          <View
            className="bg-wolf-surface rounded-3xl"
            style={{
              alignItems: 'center',
              alignSelf: 'center',
              maxWidth: 460,
              width: '100%',
              paddingTop: 40,
              paddingBottom: 34,
              paddingHorizontal: 32,
              borderWidth: 1,
              borderColor: '#2C2C3A',
            }}
          >
            <Text className="text-wolf-text text-3xl font-extrabold text-center">
              {pendingResult.firstName.toUpperCase()}
            </Text>
            <Text className="text-wolf-muted text-xl text-center my-2">&</Text>
            <Text className="text-wolf-text text-3xl font-extrabold text-center">
              {pendingResult.secondName.toUpperCase()}
            </Text>
            <View
              className="bg-wolf-card"
              style={{ height: 1, width: '75%', marginVertical: 26 }}
            />
            <Text className="text-wolf-text text-4xl font-extrabold tracking-widest text-center">
              {pendingResult.sameTeam === 'same'
                ? 'SAME TEAM'
                : 'DIFFERENT TEAMS'}
            </Text>
            <Text className="text-wolf-muted text-sm text-center mt-7">
              Take a moment to remember this…
            </Text>
          </View>
        </Animated.View>
      )}
    </View>
  );
}

// ───── Witch picker ────────────────────────────────────────────────────────

function WitchPicker({
  gameId,
  deviceClientId,
  alivePlayers,
  targetables,
  totalSeats,
  meId,
  meSeatPosition,
  witchState,
  isGhost,
}: {
  gameId: Id<'games'>;
  deviceClientId: string;
  alivePlayers: SeatingPlayer[];
  targetables: Targetable[];
  totalSeats: number;
  meId: Id<'players'>;
  meSeatPosition?: number;
  witchState: {
    saveUsed: boolean;
    poisonUsed: boolean;
    savedTonight: boolean;
    poisonedTonight: boolean;
    hasActedThisNight: boolean;
    tonightVictims: Array<{ _id: Id<'players'>; name: string }>;
    tonightSaveTarget: { _id: Id<'players'>; name: string } | null;
    tonightPoisonTarget: { _id: Id<'players'>; name: string } | null;
  };
  isGhost?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const submitSave = useMutation(api.night.submitWitchSave);
  const submitPoison = useMutation(api.night.submitWitchPoison);
  const submitDone = useMutation(api.night.submitWitchDone);

  const [submitting, setSubmitting] = useState(false);
  // When there are 2 victims, confirmSave holds the chosen one (witch must
  // pick which to save — no two-for-one). Null = closed; object = open with
  // that victim queued.
  const [confirmSave, setConfirmSave] = useState<{
    id: Id<'players'>;
    name: string;
  } | null>(null);
  const [savePickerOpen, setSavePickerOpen] = useState(false);
  const [poisonPickerOpen, setPoisonPickerOpen] = useState(false);
  const [confirmPoison, setConfirmPoison] = useState<{
    id: Id<'players'>;
    name: string;
  } | null>(null);

  async function handleSave() {
    if (!confirmSave) return;
    setSubmitting(true);
    try {
      await submitSave({
        gameId,
        callerDeviceClientId: deviceClientId,
        targetPlayerId: confirmSave.id,
      });
      setConfirmSave(null);
    } catch (e) {
      showAlert('Could not save', e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  async function handlePoison() {
    if (!confirmPoison) return;
    setSubmitting(true);
    try {
      await submitPoison({
        gameId,
        callerDeviceClientId: deviceClientId,
        targetPlayerId: confirmPoison.id,
      });
      setConfirmPoison(null);
      setPoisonPickerOpen(false);
    } catch (e) {
      showAlert('Could not poison', e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDone() {
    setSubmitting(true);
    try {
      await submitDone({ gameId, callerDeviceClientId: deviceClientId });
    } catch (e) {
      showAlert('Error', e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  if (witchState.hasActedThisNight) {
    return (
      <View className="flex-1 px-6 pt-2 pb-8">
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color="#D4A017" />
          <Text className="text-wolf-text text-sm text-center mt-6 px-4">
            {isGhost
              ? "The Witch's turn is over. Waiting for the night to settle…"
              : 'Your turn is over. Waiting for the night to settle…'}
          </Text>
          {witchState.tonightSaveTarget && (
            <Text className="text-wolf-text text-sm text-center mt-4 px-4">
              <Text className="font-bold" style={{ color: '#5BA0E5' }}>
                SAVED:
              </Text>{' '}
              {witchState.tonightSaveTarget.name}
            </Text>
          )}
          {witchState.tonightPoisonTarget && (
            <Text className="text-wolf-text text-sm text-center mt-4 px-4">
              <Text className="text-wolf-red font-bold">POISONED:</Text>{' '}
              {witchState.tonightPoisonTarget.name}
            </Text>
          )}
        </View>
      </View>
    );
  }

  const victims = witchState.tonightVictims;
  const canSave =
    !witchState.saveUsed && !witchState.savedTonight && victims.length > 0;
  const canPoison = !witchState.poisonUsed && !witchState.poisonedTonight;
  // Single-victim path: tap "USE SAVE POTION" goes straight to the
  // confirmation modal with that victim queued. Multi-victim (vengeance):
  // tap opens a picker so the witch chooses one (no two-for-one).
  function openSaveFlow() {
    if (victims.length === 1) {
      setConfirmSave({ id: victims[0]._id, name: victims[0].name });
    } else if (victims.length > 1) {
      setSavePickerOpen(true);
    }
  }

  return (
    <View className="flex-1">
      <ScrollView contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: 16 }}>
        <View className="bg-wolf-card rounded-xl px-4 py-3 mt-2 mb-4">
          <Text className="text-wolf-muted text-xs font-bold tracking-widest mb-1">
            {victims.length > 1 ? "TONIGHT'S VICTIMS" : "TONIGHT'S VICTIM"}
          </Text>
          {witchState.saveUsed ? (
            <Text className="text-wolf-muted text-sm italic">
              {isGhost
                ? "The wolves' victim is hidden — the Witch's save potion is spent."
                : "You can no longer see the wolves' victim — your save potion is spent."}
            </Text>
          ) : victims.length > 0 ? (
            <View style={{ gap: 4 }}>
              {victims.map(v => (
                <Text
                  key={v._id}
                  className="text-wolf-text text-2xl font-bold tracking-widest"
                >
                  {v.name.toUpperCase()}
                </Text>
              ))}
              {victims.length > 1 && (
                <Text className="text-wolf-muted text-xs mt-1">
                  Your save potion can only spare one.
                </Text>
              )}
            </View>
          ) : (
            <Text className="text-wolf-muted text-sm italic">
              No victim tonight.
            </Text>
          )}
        </View>

        <Text className="text-wolf-muted text-xs font-bold tracking-widest mb-2">
          POTIONS
        </Text>
        <View style={{ gap: 10 }}>
          <TouchableOpacity
            onPress={openSaveFlow}
            disabled={!canSave || submitting}
            activeOpacity={0.75}
            className="bg-wolf-card rounded-xl px-4 py-4"
            style={{
              borderWidth: 1,
              borderColor: canSave ? '#5BA0E5' : '#2A2A38',
              opacity: canSave ? 1 : 0.4,
            }}
          >
            <Text
              className="text-base font-bold tracking-widest"
              style={{ color: canSave ? '#5BA0E5' : '#5A5560' }}
            >
              {witchState.savedTonight
                ? 'SAVE CAST'
                : witchState.saveUsed
                  ? 'SAVE POTION USED'
                  : 'USE SAVE POTION'}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={() => setPoisonPickerOpen(true)}
            disabled={!canPoison || submitting}
            activeOpacity={0.75}
            className="bg-wolf-card rounded-xl px-4 py-4"
            style={{
              borderWidth: 1,
              borderColor: canPoison ? '#B03A2E' : '#2A2A38',
              opacity: canPoison ? 1 : 0.4,
            }}
          >
            <Text
              className="text-base font-bold tracking-widest"
              style={{ color: canPoison ? '#E07070' : '#5A5560' }}
            >
              {witchState.poisonedTonight
                ? 'POISON CAST'
                : witchState.poisonUsed
                  ? 'POISON POTION USED'
                  : 'USE POISON'}
            </Text>
            {witchState.tonightPoisonTarget && (
              <Text className="text-wolf-text text-sm mt-1">
                → {witchState.tonightPoisonTarget.name}
              </Text>
            )}
          </TouchableOpacity>
        </View>
      </ScrollView>

      {!isGhost && (
        <View
          className="px-6"
          style={{ paddingBottom: Math.max(insets.bottom, 12) + 12 }}
        >
          <TouchableOpacity
            onPress={handleDone}
            disabled={submitting}
            style={{ opacity: submitting ? 0.4 : 1 }}
            className="bg-wolf-accent rounded-xl py-5 items-center"
          >
            {submitting ? (
              <ActivityIndicator color="#0F0F14" />
            ) : (
              <Text className="text-wolf-bg text-lg font-extrabold tracking-widest">
                I'M DONE
              </Text>
            )}
          </TouchableOpacity>
        </View>
      )}

      {/* Save victim picker (vengeance night — choose which to save) */}
      <Modal
        visible={savePickerOpen && !confirmSave}
        transparent
        animationType="fade"
        onRequestClose={() => setSavePickerOpen(false)}
      >
        <Pressable
          onPress={() => setSavePickerOpen(false)}
          style={{
            flex: 1,
            backgroundColor: 'rgba(0,0,0,0.85)',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
          }}
        >
          <Pressable
            onPress={e => e.stopPropagation()}
            className="bg-wolf-surface rounded-2xl w-full p-6"
          >
            <Text className="text-wolf-text text-lg font-bold mb-1 text-center">
              Save which victim?
            </Text>
            <Text className="text-wolf-muted text-xs text-center mb-4">
              Your potion can only spare one.
            </Text>
            <View style={{ gap: 10 }}>
              {victims.map(v => (
                <TouchableOpacity
                  key={v._id}
                  onPress={() => {
                    setConfirmSave({ id: v._id, name: v.name });
                    setSavePickerOpen(false);
                  }}
                  className="bg-wolf-card rounded-xl py-4 items-center"
                  style={{ borderWidth: 1, borderColor: '#5BA0E5' }}
                >
                  <Text className="text-wolf-text text-lg font-bold tracking-widest">
                    {v.name.toUpperCase()}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
            <TouchableOpacity onPress={() => setSavePickerOpen(false)} className="mt-3 py-2">
              <Text className="text-wolf-muted text-center">Cancel</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Save confirmation */}
      {confirmSave && (
        <ConfirmOverlay
          onCancel={() => setConfirmSave(null)}
          onConfirm={handleSave}
          submitting={submitting}
        >
          <Text className="text-wolf-muted text-xs font-bold tracking-widest mb-3">
            SAVE
          </Text>
          <Text className="text-wolf-text text-3xl font-extrabold text-center mb-2">
            {confirmSave.name.toUpperCase()}
          </Text>
          <Text className="text-wolf-muted text-sm text-center">
            This is your only save potion.
          </Text>
        </ConfirmOverlay>
      )}

      {/* Poison picker */}
      <Modal
        visible={poisonPickerOpen && !confirmPoison}
        transparent
        animationType="fade"
        onRequestClose={() => setPoisonPickerOpen(false)}
      >
        <Pressable
          onPress={() => setPoisonPickerOpen(false)}
          style={{
            flex: 1,
            backgroundColor: 'rgba(0,0,0,0.85)',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
          }}
        >
          <Pressable
            onPress={e => e.stopPropagation()}
            className="bg-wolf-surface rounded-2xl w-full p-6"
            style={{ maxHeight: '80%' }}
          >
            <Text className="text-wolf-text text-lg font-bold mb-3 text-center">
              Poison
            </Text>
            <View style={{ alignItems: 'center', paddingVertical: 8 }}>
              <SeatingCircle
                phase="night"
                totalSeats={totalSeats}
                players={alivePlayers}
                meId={meId}
                viewerSeatIndex={meSeatPosition}
                selectableIds={
                  new Set(targetables.map(t => t._id as unknown as string))
                }
                onPress={p => setConfirmPoison({ id: p._id, name: p.name })}
                size={280}
              />
            </View>
            <TouchableOpacity onPress={() => setPoisonPickerOpen(false)} className="mt-3 py-2">
              <Text className="text-wolf-muted text-center">Cancel</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Poison confirmation */}
      {confirmPoison && (
        <ConfirmOverlay
          onCancel={() => setConfirmPoison(null)}
          onConfirm={handlePoison}
          submitting={submitting}
          confirmTone="danger"
        >
          <Text className="text-wolf-muted text-xs font-bold tracking-widest mb-3">
            POISON
          </Text>
          <Text className="text-wolf-text text-3xl font-extrabold text-center mb-2">
            {confirmPoison.name.toUpperCase()}
          </Text>
          <Text className="text-wolf-muted text-sm text-center">
            This is your only poison potion.
          </Text>
        </ConfirmOverlay>
      )}
    </View>
  );
}

// ───── Leprechaun picker ───────────────────────────────────────────────────

function LeprechaunPicker({
  gameId,
  deviceClientId,
  leprechaunState,
  isGhost,
}: {
  gameId: Id<'games'>;
  deviceClientId: string;
  leprechaunState: {
    blocked: boolean;
    hasActedThisNight: boolean;
    wolfTarget: { _id: Id<'players'>; name: string } | null;
    leftNeighbor: { _id: Id<'players'>; name: string } | null;
    rightNeighbor: { _id: Id<'players'>; name: string } | null;
    canMoveOff: boolean;
    tonightRedirect: {
      direction: 'L' | 'R' | 'leave';
      originalTargetName: string | null;
      newTargetName: string | null;
      blocked: boolean;
    } | null;
  };
  isGhost?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const submitMove = useMutation(api.night.submitLeprechaunMove);
  const [submitting, setSubmitting] = useState(false);
  const [selection, setSelection] = useState<'target' | 'L' | 'R'>('target');
  const [confirmOpen, setConfirmOpen] = useState(false);

  async function submit(direction: 'L' | 'R' | 'leave') {
    setSubmitting(true);
    try {
      await submitMove({
        gameId,
        callerDeviceClientId: deviceClientId,
        direction,
      });
      setConfirmOpen(false);
    } catch (e) {
      showAlert('Could not move', e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  // Post-action: locked waiting view.
  if (leprechaunState.hasActedThisNight) {
    const r = leprechaunState.tonightRedirect;
    return (
      <View className="flex-1 px-6 pt-2 pb-8">
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color="#D4A017" />
          {r?.blocked ? (
            <Text className="text-wolf-text text-sm text-center mt-6 px-4">
              {isGhost
                ? 'The Leprechaun has acknowledged the silent night. Waiting…'
                : 'Acknowledged. Waiting for the night to settle…'}
            </Text>
          ) : r?.direction === 'leave' ? (
            <Text className="text-wolf-text text-sm text-center mt-6 px-4">
              {isGhost
                ? `The Leprechaun left the kill on ${r?.originalTargetName ?? '—'}. Waiting…`
                : `Left the kill on ${r?.originalTargetName ?? '—'}. Waiting…`}
            </Text>
          ) : (
            <View className="mt-6 items-center px-4">
              <Text className="text-wolf-text text-xs tracking-widest font-bold mb-2">
                KILL MOVED
              </Text>
              <Text className="text-wolf-text text-base text-center">
                <Text className="font-bold">
                  {r?.originalTargetName ?? '—'}
                </Text>
                {' → '}
                <Text className="font-bold">
                  {r?.newTargetName ?? '—'}
                </Text>
              </Text>
              <Text className="text-wolf-text text-xs text-center mt-3 italic">
                {isGhost
                  ? 'Waiting for the night to settle…'
                  : 'Your move has been made. Waiting for the night to settle…'}
              </Text>
            </View>
          )}
        </View>
      </View>
    );
  }

  // Diseased-blocked night: ACKNOWLEDGE only.
  if (leprechaunState.blocked) {
    return (
      <View className="flex-1 px-6 pt-2 pb-8">
        <View className="flex-1 items-center justify-center">
          <View className="bg-wolf-card rounded-xl px-6 py-6 mb-8 w-full">
            <Text className="text-wolf-muted text-xs font-bold tracking-widest mb-3 text-center">
              TONIGHT'S VICTIM
            </Text>
            <Text className="text-wolf-text text-2xl font-bold tracking-widest text-center">
              NO KILL
            </Text>
            <Text className="text-wolf-text text-sm text-center mt-3 italic">
              The wolves had no kill tonight.
            </Text>
          </View>
          {!isGhost && (
            <TouchableOpacity
              onPress={() => submit('leave')}
              disabled={submitting}
              activeOpacity={0.8}
              className="bg-wolf-accent rounded-xl px-8 py-4"
              style={{ opacity: submitting ? 0.5 : 1 }}
            >
              {submitting ? (
                <ActivityIndicator color="#0F0F14" />
              ) : (
                <Text className="text-wolf-bg text-base font-extrabold tracking-widest">
                  ACKNOWLEDGE
                </Text>
              )}
            </TouchableOpacity>
          )}
        </View>
      </View>
    );
  }

  // Normal pre-action picker.
  const target = leprechaunState.wolfTarget;
  const left = leprechaunState.leftNeighbor;
  const right = leprechaunState.rightNeighbor;
  const canMove = leprechaunState.canMoveOff;

  const targetName = target?.name ?? '—';
  const selectedName =
    selection === 'L'
      ? (left?.name ?? '—')
      : selection === 'R'
        ? (right?.name ?? '—')
        : targetName;

  const handleOK = () => {
    if (isGhost) return;
    if (!canMove) {
      void submit('leave');
      return;
    }
    setConfirmOpen(true);
  };

  const confirmedSubmit = () => {
    if (selection === 'target') void submit('leave');
    else void submit(selection);
  };

  return (
    <View className="flex-1">
      <View className="flex-1 px-6 pt-2">
        <Text className="text-wolf-text text-base text-center leading-6 mt-2">
          {canMove ? (
            <>
              Tonight's kill is on{' '}
              <Text className="font-bold">{targetName}</Text>. You may leave the
              kill or move it to a neighbor.
            </>
          ) : (
            <>
              Tonight's kill is on{' '}
              <Text className="font-bold">{targetName}</Text>. You've already
              moved a kill off <Text className="font-bold">{targetName}</Text>{' '}
              before — you must leave the kill where it is.
            </>
          )}
        </Text>

        <View
          className="flex-row items-center justify-center mt-10"
          style={{ gap: 14 }}
        >
          <LeprechaunCircle
            label="LEFT"
            name={left?.name ?? null}
            selected={selection === 'L'}
            disabled={!canMove || !left || submitting}
            onPress={() => left && canMove && setSelection('L')}
          />
          <LeprechaunCircle
            label="TARGET"
            name={target?.name ?? null}
            selected={selection === 'target'}
            disabled={submitting}
            onPress={() => setSelection('target')}
          />
          <LeprechaunCircle
            label="RIGHT"
            name={right?.name ?? null}
            selected={selection === 'R'}
            disabled={!canMove || !right || submitting}
            onPress={() => right && canMove && setSelection('R')}
          />
        </View>
      </View>

      {!isGhost && (
        <View
          className="px-6"
          style={{ paddingBottom: Math.max(insets.bottom, 12) + 12 }}
        >
          <TouchableOpacity
            onPress={handleOK}
            disabled={submitting}
            activeOpacity={0.8}
            style={{ opacity: submitting ? 0.4 : 1 }}
            className="bg-wolf-accent rounded-xl py-5 items-center"
          >
            {submitting ? (
              <ActivityIndicator color="#0F0F14" />
            ) : (
              <Text
                className="text-wolf-bg text-lg font-extrabold tracking-widest"
                style={{ paddingHorizontal: 2 }}
              >
                OK
              </Text>
            )}
          </TouchableOpacity>
        </View>
      )}

      {/* Confirmation overlay — only when the move is actually a choice. */}
      {confirmOpen && (
        <ConfirmOverlay
          onCancel={() => setConfirmOpen(false)}
          onConfirm={confirmedSubmit}
          submitting={submitting}
        >
          <Text className="text-wolf-muted text-xs font-bold tracking-widest mb-3">
            {selection === 'target' ? 'LEAVE KILL' : 'MOVE KILL'}
          </Text>
          <Text className="text-wolf-text text-2xl font-extrabold text-center">
            {selection === 'target'
              ? `Leave the kill on ${selectedName}?`
              : `Move the kill to ${selectedName}?`}
          </Text>
          {selection !== 'target' && (
            <Text className="text-wolf-muted text-sm text-center mt-3">
              You won't be able to move a kill off {targetName} again later.
            </Text>
          )}
        </ConfirmOverlay>
      )}
    </View>
  );
}

function LeprechaunCircle({
  label,
  name,
  selected,
  disabled,
  onPress,
}: {
  label: string;
  name: string | null;
  selected: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const { theme } = useTheme();
  const avatarNight = getTableArt(theme).avatarNight;
  const present = !!name;
  const size = 88;
  const borderColor = selected ? '#F0EDE8' : '#3A3A48';
  return (
    <View style={{ alignItems: 'center', width: 96 }}>
      <TouchableOpacity
        onPress={onPress}
        disabled={disabled || !present}
        activeOpacity={0.7}
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          borderWidth: selected ? 2 : 1,
          borderColor,
          overflow: 'hidden',
          backgroundColor: '#22222F',
          opacity: disabled || !present ? 0.4 : 1,
        }}
      >
        {present ? (
          <>
            {/* Seat-style night avatar fills the circle, matching the ring. */}
            <Image
              source={avatarNight}
              style={{ width: '100%', height: '100%' }}
              contentFit="cover"
              cachePolicy="memory-disk"
            />
            {selected ? (
              <View
                pointerEvents="none"
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  backgroundColor: 'rgba(240, 237, 232, 0.16)',
                }}
              />
            ) : null}
            {/* Name banner along the bottom, same as the seating ring. */}
            <View
              pointerEvents="none"
              style={{
                position: 'absolute',
                bottom: 0,
                left: 0,
                right: 0,
                backgroundColor: 'rgba(10, 10, 14, 0.62)',
                paddingVertical: 2,
                paddingHorizontal: 2,
                alignItems: 'center',
              }}
            >
              <Text
                style={{
                  color: '#F0EDE8',
                  fontSize: 11,
                  fontWeight: selected ? '700' : '600',
                  textAlign: 'center',
                }}
                numberOfLines={1}
              >
                {name}
              </Text>
            </View>
          </>
        ) : (
          <View
            style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}
          >
            <Text className="text-wolf-muted" style={{ fontSize: 13 }}>
              —
            </Text>
          </View>
        )}
      </TouchableOpacity>
      <Text className="text-wolf-text text-[10px] font-bold tracking-widest mt-2">
        {label}
      </Text>
    </View>
  );
}

// ───── Bodyguard picker ────────────────────────────────────────────────────

function BodyguardPicker({
  gameId,
  deviceClientId,
  alivePlayers,
  targetables,
  totalSeats,
  bgState,
  meId,
  meSeatPosition,
  isGhost,
}: {
  gameId: Id<'games'>;
  deviceClientId: string;
  alivePlayers: SeatingPlayer[];
  targetables: Targetable[];
  totalSeats: number;
  bgState: {
    selfProtectUsed: boolean;
    lastProtectedPlayerId: Id<'players'> | null;
    lastProtectedName: string | null;
    hasActedThisNight: boolean;
    tonightProtected: { _id: Id<'players'>; name: string } | null;
  };
  meId: Id<'players'>;
  meSeatPosition?: number;
  isGhost?: boolean;
}) {
  const submitProtect = useMutation(api.night.submitBGProtect);
  const [submitting, setSubmitting] = useState(false);
  const [pendingTarget, setPendingTarget] = useState<{
    id: Id<'players'>;
    name: string;
  } | null>(null);

  function handlePickTarget(targetId: Id<'players'>, name: string) {
    if (submitting || pendingTarget || bgState.hasActedThisNight) return;
    setPendingTarget({ id: targetId, name });
  }

  async function handleConfirm() {
    if (!pendingTarget || submitting) return;
    setSubmitting(true);
    try {
      await submitProtect({
        gameId,
        callerDeviceClientId: deviceClientId,
        targetPlayerId: pendingTarget.id,
      });
      setPendingTarget(null);
    } catch (e) {
      showAlert(
        'Could not protect',
        e instanceof Error ? e.message : String(e),
      );
    } finally {
      setSubmitting(false);
    }
  }

  function handleCancel() {
    if (submitting) return;
    setPendingTarget(null);
  }

  // After acting, hold the screen until the dwell ends — same cloaking
  // pattern as SeerPicker.
  if (bgState.hasActedThisNight) {
    return (
      <View className="flex-1 px-6 pt-2 pb-8">
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color="#D4A017" />
          <Text
            className="text-wolf-text text-sm text-center mt-6 px-4"
            style={SCENE_TEXT_SHADOW}
          >
            {isGhost
              ? "The Bodyguard's protection is in. Waiting for the night to settle…"
              : 'Your protection is in. Waiting for the night to settle…'}
          </Text>
          {bgState.tonightProtected && (
            <View className="bg-wolf-card rounded-xl px-5 py-3 mt-5 flex-row items-center">
              <Text
                style={{ color: '#5BA0E5' }}
                className="text-xs font-bold tracking-widest"
              >
                PROTECTED
              </Text>
              <Text className="text-wolf-text text-base font-bold ml-3">
                {bgState.tonightProtected.name}
              </Text>
            </View>
          )}
        </View>
      </View>
    );
  }

  return (
    <View className="flex-1">
      <NightPickerLayout
        ring={circleSize => (
          <SeatingCircle
            size={circleSize}
            phase="night"
            totalSeats={totalSeats}
            players={alivePlayers}
            meId={meId}
            viewerSeatIndex={meSeatPosition}
            selectableIds={
              new Set(targetables.map(t => t._id as unknown as string))
            }
            onPress={
              submitting || pendingTarget
                ? undefined
                : p => handlePickTarget(p._id, p.name)
            }
          />
        )}
      >
        <Text className="text-wolf-text text-base text-center mt-2 mb-2">
          {isGhost
            ? 'The Bodyguard is choosing who to protect tonight.'
            : 'Choose a player to protect tonight.'}
        </Text>
        <View className="bg-wolf-card rounded-xl px-4 py-3 mb-4">
          <Text className="text-wolf-muted text-xs leading-5">
            {bgState.lastProtectedName
              ? isGhost
                ? `Last night: ${bgState.lastProtectedName}. Cannot pick the same player two nights in a row.\n`
                : `Last night: ${bgState.lastProtectedName}. You cannot pick the same player two nights in a row.\n`
              : ''}
            {bgState.selfProtectUsed
              ? isGhost
                ? "The Bodyguard's one self-protect has already been used."
                : 'Your one self-protect has already been used.'
              : isGhost
                ? 'The Bodyguard may protect themselves once per game.'
                : 'You may protect yourself once per game.'}
          </Text>
        </View>
      </NightPickerLayout>

      {pendingTarget && (
        <ConfirmOverlay
          onCancel={handleCancel}
          onConfirm={handleConfirm}
          submitting={submitting}
        >
          <Text className="text-wolf-muted text-xs font-bold tracking-widest mb-3">
            PROTECT
          </Text>
          <Text className="text-wolf-text text-3xl font-extrabold text-center mb-2">
            {pendingTarget.name.toUpperCase()}
          </Text>
          <Text className="text-wolf-muted text-sm text-center">
            Are you sure?
          </Text>
        </ConfirmOverlay>
      )}
    </View>
  );
}

// ───── Huntress picker ─────────────────────────────────────────────────────
//
// One-time night shot. Pick a target and confirm, or pass to save the shot.
// No instant result modal — hits and misses surface together at morning per
// the no-night-announcements house rule.

function HuntressPicker({
  gameId,
  deviceClientId,
  alivePlayers,
  targetables,
  totalSeats,
  huntressState,
  meId,
  meSeatPosition,
  isGhost,
}: {
  gameId: Id<'games'>;
  deviceClientId: string;
  alivePlayers: SeatingPlayer[];
  targetables: Targetable[];
  totalSeats: number;
  huntressState: {
    huntressUsed: boolean;
    hasActedThisNight: boolean;
    tonightShot: { _id: Id<'players'>; name: string } | null;
    tonightSkipped: boolean;
  };
  meId: Id<'players'>;
  meSeatPosition?: number;
  isGhost?: boolean;
}) {
  const submitShot = useMutation(api.night.submitHuntressShot);
  const submitSkip = useMutation(api.night.submitHuntressSkip);
  const [submitting, setSubmitting] = useState(false);
  const [pendingTarget, setPendingTarget] = useState<{
    id: Id<'players'>;
    name: string;
  } | null>(null);

  function handlePickTarget(targetId: Id<'players'>, name: string) {
    if (submitting || pendingTarget) return;
    setPendingTarget({ id: targetId, name });
  }

  async function handleConfirm() {
    if (!pendingTarget || submitting) return;
    setSubmitting(true);
    try {
      await submitShot({
        gameId,
        callerDeviceClientId: deviceClientId,
        targetPlayerId: pendingTarget.id,
      });
      setPendingTarget(null);
    } catch (e) {
      showAlert('Could not shoot', e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  function handleCancel() {
    if (submitting) return;
    setPendingTarget(null);
  }

  async function handleSkip() {
    if (submitting) return;
    setSubmitting(true);
    try {
      await submitSkip({ gameId, callerDeviceClientId: deviceClientId });
    } catch (e) {
      showAlert('Error', e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  if (huntressState.hasActedThisNight) {
    return (
      <View className="flex-1 px-6 pt-2 pb-8">
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color="#D4A017" />
          <Text className="text-wolf-text text-sm text-center mt-6 px-4">
            Waiting for the night to settle…
          </Text>
          {huntressState.tonightShot ? (
            <Text className="text-wolf-text text-sm text-center mt-4 px-4">
              <Text style={{ color: '#E07070' }} className="font-bold">
                SHOT:
              </Text>{' '}
              {huntressState.tonightShot.name}
            </Text>
          ) : huntressState.tonightSkipped ? (
            <Text className="text-wolf-text text-sm text-center mt-4 px-4 italic">
              Saved the shot for later.
            </Text>
          ) : null}
        </View>
      </View>
    );
  }

  return (
    <View className="flex-1">
      <NightPickerLayout
        ring={circleSize => (
          <SeatingCircle
            size={circleSize}
            phase="night"
            totalSeats={totalSeats}
            players={alivePlayers}
            meId={meId}
            viewerSeatIndex={meSeatPosition}
            selectableIds={
              new Set(targetables.map(t => t._id as unknown as string))
            }
            onPress={
              submitting || pendingTarget
                ? undefined
                : p => handlePickTarget(p._id, p.name)
            }
          />
        )}
        footer={
          !isGhost ? (
            <TouchableOpacity
              onPress={handleSkip}
              disabled={submitting || !!pendingTarget}
              style={{ opacity: submitting || pendingTarget ? 0.4 : 1 }}
              className="bg-wolf-card rounded-xl py-4 items-center"
            >
              <Text className="text-wolf-text text-base font-bold tracking-widest">
                SAVE FOR LATER
              </Text>
            </TouchableOpacity>
          ) : undefined
        }
      >
        <Text className="text-wolf-text text-base text-center mt-2 mb-2">
          {isGhost
            ? 'The Huntress is deciding whether to take her one shot.'
            : 'One-time shot. Pick a target to shoot, or save it for later.'}
        </Text>
      </NightPickerLayout>

      {pendingTarget && (
        <ConfirmOverlay
          onCancel={handleCancel}
          onConfirm={handleConfirm}
          submitting={submitting}
        >
          <Text className="text-wolf-muted text-xs font-bold tracking-widest mb-3">
            SHOOT
          </Text>
          <Text className="text-wolf-text text-3xl font-extrabold text-center mb-2">
            {pendingTarget.name.toUpperCase()}
          </Text>
          <Text className="text-wolf-muted text-sm text-center">
            Your only shot. Are you sure?
          </Text>
        </ConfirmOverlay>
      )}
    </View>
  );
}

// ───── Warlock picker ──────────────────────────────────────────────────────
//
// One-time per game. Each night until used, the Warlock is asked whether to
// cancel the wolves' kill and select a NEW target — they do NOT see the
// wolves' chosen victim. Pick any alive player (self / wolves allowed) or
// pass to keep the power. Submitting a kill spends the power permanently.

function WarlockPicker({
  gameId,
  deviceClientId,
  alivePlayers,
  targetables,
  totalSeats,
  warlockState,
  meId,
  meSeatPosition,
  isGhost,
}: {
  gameId: Id<'games'>;
  deviceClientId: string;
  alivePlayers: SeatingPlayer[];
  targetables: Targetable[];
  totalSeats: number;
  warlockState: {
    spent: boolean;
    hasActedThisNight: boolean;
    tonightTarget: { _id: Id<'players'>; name: string } | null;
    tonightSkipped: boolean;
  };
  meId: Id<'players'>;
  meSeatPosition?: number;
  isGhost?: boolean;
}) {
  const submitKill = useMutation(api.night.submitWarlockKill);
  const submitPass = useMutation(api.night.submitWarlockPass);
  const [submitting, setSubmitting] = useState(false);
  const [pendingTarget, setPendingTarget] = useState<{
    id: Id<'players'>;
    name: string;
  } | null>(null);

  function handlePickTarget(targetId: Id<'players'>, name: string) {
    if (submitting || pendingTarget) return;
    setPendingTarget({ id: targetId, name });
  }

  async function handleConfirm() {
    if (!pendingTarget || submitting) return;
    setSubmitting(true);
    try {
      await submitKill({
        gameId,
        callerDeviceClientId: deviceClientId,
        targetPlayerId: pendingTarget.id,
      });
      setPendingTarget(null);
    } catch (e) {
      showAlert(
        'Could not use power',
        e instanceof Error ? e.message : String(e),
      );
    } finally {
      setSubmitting(false);
    }
  }

  function handleCancel() {
    if (submitting) return;
    setPendingTarget(null);
  }

  async function handleSkip() {
    if (submitting) return;
    setSubmitting(true);
    try {
      await submitPass({ gameId, callerDeviceClientId: deviceClientId });
    } catch (e) {
      showAlert('Error', e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  if (warlockState.hasActedThisNight) {
    return (
      <View className="flex-1 px-6 pt-2 pb-8">
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color="#D4A017" />
          <Text className="text-wolf-text text-sm text-center mt-6 px-4">
            Waiting for the night to settle…
          </Text>
          {warlockState.tonightTarget ? (
            <Text className="text-wolf-text text-sm text-center mt-4 px-4">
              <Text style={{ color: '#E07070' }} className="font-bold">
                TARGETED:
              </Text>{' '}
              {warlockState.tonightTarget.name}
            </Text>
          ) : warlockState.tonightSkipped ? (
            <Text className="text-wolf-text text-sm text-center mt-4 px-4 italic">
              Saved the power for later.
            </Text>
          ) : null}
        </View>
      </View>
    );
  }

  return (
    <View className="flex-1">
      <NightPickerLayout
        ring={circleSize => (
          <SeatingCircle
            size={circleSize}
            phase="night"
            totalSeats={totalSeats}
            players={alivePlayers}
            meId={meId}
            viewerSeatIndex={meSeatPosition}
            selectableIds={
              new Set(targetables.map(t => t._id as unknown as string))
            }
            onPress={
              submitting || pendingTarget
                ? undefined
                : p => handlePickTarget(p._id, p.name)
            }
          />
        )}
        footer={
          !isGhost ? (
            <TouchableOpacity
              onPress={handleSkip}
              disabled={submitting || !!pendingTarget}
              style={{ opacity: submitting || pendingTarget ? 0.4 : 1 }}
              className="bg-wolf-card rounded-xl py-4 items-center"
            >
              <Text className="text-wolf-text text-base font-bold tracking-widest">
                SAVE FOR LATER
              </Text>
            </TouchableOpacity>
          ) : undefined
        }
      >
        <Text className="text-wolf-text text-base text-center mt-2 mb-2">
          {isGhost
            ? 'The Warlock is deciding whether to redirect tonight’s kill.'
            : 'Redirect the wolves’ kill onto any player, or pass.'}
        </Text>
      </NightPickerLayout>

      {pendingTarget && (
        <ConfirmOverlay
          onCancel={handleCancel}
          onConfirm={handleConfirm}
          submitting={submitting}
        >
          <Text className="text-wolf-muted text-xs font-bold tracking-widest mb-3">
            REDIRECT KILL ONTO
          </Text>
          <Text className="text-wolf-text text-3xl font-extrabold text-center mb-2">
            {pendingTarget.name.toUpperCase()}
          </Text>
          <Text className="text-wolf-muted text-sm text-center px-4">
            Tonight's wolf kill will land on them instead. Your power will
            be considered used for the rest of the game.
          </Text>
        </ConfirmOverlay>
      )}
    </View>
  );
}

// ───── Chupacabra picker ────────────────────────────────────────────────────
//
// Solo hunter. Picks one prey EVERY night (no skip). While any wolf lives the
// hunt only kills a wolf; once the pack is gone, any prey dies. The player gets
// no view of the wolves' target and no private confirmation — they infer the
// result from the public dawn report. Confirm copy names the conditional
// effect per the picker-confirmation + informative-confirm rules.

function ChupacabraPicker({
  gameId,
  deviceClientId,
  alivePlayers,
  targetables,
  totalSeats,
  chupacabraState,
  meId,
  meSeatPosition,
  isGhost,
}: {
  gameId: Id<'games'>;
  deviceClientId: string;
  alivePlayers: SeatingPlayer[];
  targetables: Targetable[];
  totalSeats: number;
  chupacabraState: {
    hasActedThisNight: boolean;
    tonightTarget: { _id: Id<'players'>; name: string } | null;
  };
  meId: Id<'players'>;
  meSeatPosition?: number;
  isGhost?: boolean;
}) {
  const submitKill = useMutation(api.night.submitChupacabraKill);
  const [submitting, setSubmitting] = useState(false);
  const [pendingTarget, setPendingTarget] = useState<{
    id: Id<'players'>;
    name: string;
  } | null>(null);

  function handlePickTarget(targetId: Id<'players'>, name: string) {
    if (submitting || pendingTarget) return;
    setPendingTarget({ id: targetId, name });
  }

  async function handleConfirm() {
    if (!pendingTarget || submitting) return;
    setSubmitting(true);
    try {
      await submitKill({
        gameId,
        callerDeviceClientId: deviceClientId,
        targetPlayerId: pendingTarget.id,
      });
      setPendingTarget(null);
    } catch (e) {
      showAlert('Could not hunt', e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  function handleCancel() {
    if (submitting) return;
    setPendingTarget(null);
  }

  if (chupacabraState.hasActedThisNight) {
    return (
      <View className="flex-1 px-6 pt-2 pb-8">
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color="#D4A017" />
          <Text className="text-wolf-text text-sm text-center mt-6 px-4">
            Waiting for the night to settle…
          </Text>
          {chupacabraState.tonightTarget ? (
            <Text className="text-wolf-text text-sm text-center mt-4 px-4">
              <Text style={{ color: '#E07070' }} className="font-bold">
                HUNTED:
              </Text>{' '}
              {chupacabraState.tonightTarget.name}
            </Text>
          ) : null}
        </View>
      </View>
    );
  }

  return (
    <View className="flex-1">
      <NightPickerLayout
        ring={circleSize => (
          <SeatingCircle
            size={circleSize}
            phase="night"
            totalSeats={totalSeats}
            players={alivePlayers}
            meId={meId}
            viewerSeatIndex={meSeatPosition}
            selectableIds={
              new Set(targetables.map(t => t._id as unknown as string))
            }
            onPress={
              submitting || pendingTarget
                ? undefined
                : p => handlePickTarget(p._id, p.name)
            }
          />
        )}
      >
        <Text className="text-wolf-text text-base text-center mt-2 mb-2">
          {isGhost
            ? 'The Chupacabra is choosing tonight’s prey.'
            : 'Choose tonight’s prey. While wolves prowl, only a wolf falls — once the pack is gone, any prey dies.'}
        </Text>
      </NightPickerLayout>

      {pendingTarget && (
        <ConfirmOverlay
          onCancel={handleCancel}
          onConfirm={handleConfirm}
          submitting={submitting}
        >
          <Text className="text-wolf-muted text-xs font-bold tracking-widest mb-3">
            HUNT
          </Text>
          <Text className="text-wolf-text text-3xl font-extrabold text-center mb-2">
            {pendingTarget.name.toUpperCase()}
          </Text>
          <Text className="text-wolf-muted text-sm text-center px-4">
            If they’re a wolf — or the pack is already gone — they die by dawn.
            Otherwise the hunt draws no blood tonight.
          </Text>
        </ConfirmOverlay>
      )}
    </View>
  );
}

// ───── Revealer picker ─────────────────────────────────────────────────────
//
// Optional every night. Die-on-miss: if the target isn't a wolf, the
// Revealer dies and the target lives. UI emphasises this risk in the
// confirm copy so the player can back out before locking in.

function RevealerPicker({
  gameId,
  deviceClientId,
  alivePlayers,
  targetables,
  totalSeats,
  revealerState,
  meId,
  meSeatPosition,
  isGhost,
}: {
  gameId: Id<'games'>;
  deviceClientId: string;
  alivePlayers: SeatingPlayer[];
  targetables: Targetable[];
  totalSeats: number;
  revealerState: {
    hasActedThisNight: boolean;
    tonightShot: { _id: Id<'players'>; name: string } | null;
    tonightSkipped: boolean;
  };
  meId: Id<'players'>;
  meSeatPosition?: number;
  isGhost?: boolean;
}) {
  const submitShot = useMutation(api.night.submitRevealerShot);
  const submitSkip = useMutation(api.night.submitRevealerSkip);
  const [submitting, setSubmitting] = useState(false);
  const [pendingTarget, setPendingTarget] = useState<{
    id: Id<'players'>;
    name: string;
  } | null>(null);

  function handlePickTarget(targetId: Id<'players'>, name: string) {
    if (submitting || pendingTarget) return;
    setPendingTarget({ id: targetId, name });
  }

  async function handleConfirm() {
    if (!pendingTarget || submitting) return;
    setSubmitting(true);
    try {
      await submitShot({
        gameId,
        callerDeviceClientId: deviceClientId,
        targetPlayerId: pendingTarget.id,
      });
      setPendingTarget(null);
    } catch (e) {
      showAlert('Could not shoot', e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  function handleCancel() {
    if (submitting) return;
    setPendingTarget(null);
  }

  async function handleSkip() {
    if (submitting) return;
    setSubmitting(true);
    try {
      await submitSkip({ gameId, callerDeviceClientId: deviceClientId });
    } catch (e) {
      showAlert('Error', e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  if (revealerState.hasActedThisNight) {
    return (
      <View className="flex-1 px-6 pt-2 pb-8">
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color="#D4A017" />
          <Text className="text-wolf-text text-sm text-center mt-6 px-4">
            Waiting for the night to settle…
          </Text>
          {revealerState.tonightShot ? (
            <Text className="text-wolf-text text-sm text-center mt-4 px-4">
              <Text style={{ color: '#D4A017' }} className="font-bold">
                REVEALED:
              </Text>{' '}
              {revealerState.tonightShot.name}
            </Text>
          ) : revealerState.tonightSkipped ? (
            <Text className="text-wolf-text text-sm text-center mt-4 px-4 italic">
              Passed tonight.
            </Text>
          ) : null}
        </View>
      </View>
    );
  }

  return (
    <View className="flex-1">
      <NightPickerLayout
        ring={circleSize => (
          <SeatingCircle
            size={circleSize}
            phase="night"
            totalSeats={totalSeats}
            players={alivePlayers}
            meId={meId}
            viewerSeatIndex={meSeatPosition}
            selectableIds={
              new Set(targetables.map(t => t._id as unknown as string))
            }
            onPress={
              submitting || pendingTarget
                ? undefined
                : p => handlePickTarget(p._id, p.name)
            }
          />
        )}
        footer={
          !isGhost ? (
            <TouchableOpacity
              onPress={handleSkip}
              disabled={submitting || !!pendingTarget}
              style={{ opacity: submitting || pendingTarget ? 0.4 : 1 }}
              className="bg-wolf-card rounded-xl py-4 items-center"
            >
              <Text className="text-wolf-text text-base font-bold tracking-widest">
                PASS TONIGHT
              </Text>
            </TouchableOpacity>
          ) : undefined
        }
      >
        <Text className="text-wolf-text text-base text-center mt-2 mb-2">
          {isGhost
            ? "The Revealer is choosing whether to reveal a wolf. They die if they miss."
            : "Pick a wolf to reveal them. If they aren't a wolf, you die instead."}
        </Text>
      </NightPickerLayout>

      {pendingTarget && (
        <ConfirmOverlay
          onCancel={handleCancel}
          onConfirm={handleConfirm}
          submitting={submitting}
        >
          <Text className="text-wolf-muted text-xs font-bold tracking-widest mb-3">
            REVEAL
          </Text>
          <Text className="text-wolf-text text-3xl font-extrabold text-center mb-2">
            {pendingTarget.name.toUpperCase()}
          </Text>
          <Text className="text-wolf-muted text-sm text-center px-4">
            If they aren't a wolf, you die. Are you sure?
          </Text>
        </ConfirmOverlay>
      )}
    </View>
  );
}

// ───── Reviler picker ──────────────────────────────────────────────────────
//
// Solo antagonist. Optional every night. Die-on-miss when target isn't a
// "special villager" (any village-team role besides plain Villager). UI
// copy stays narrative — server enforces the actual hit rule.

function RevilerPicker({
  gameId,
  deviceClientId,
  alivePlayers,
  targetables,
  totalSeats,
  revilerState,
  meId,
  meSeatPosition,
  isGhost,
}: {
  gameId: Id<'games'>;
  deviceClientId: string;
  alivePlayers: SeatingPlayer[];
  targetables: Targetable[];
  totalSeats: number;
  revilerState: {
    hasActedThisNight: boolean;
    tonightShot: { _id: Id<'players'>; name: string } | null;
    tonightSkipped: boolean;
  };
  meId: Id<'players'>;
  meSeatPosition?: number;
  isGhost?: boolean;
}) {
  const submitShot = useMutation(api.night.submitRevilerShot);
  const submitSkip = useMutation(api.night.submitRevilerSkip);
  const [submitting, setSubmitting] = useState(false);
  const [pendingTarget, setPendingTarget] = useState<{
    id: Id<'players'>;
    name: string;
  } | null>(null);

  function handlePickTarget(targetId: Id<'players'>, name: string) {
    if (submitting || pendingTarget) return;
    setPendingTarget({ id: targetId, name });
  }

  async function handleConfirm() {
    if (!pendingTarget || submitting) return;
    setSubmitting(true);
    try {
      await submitShot({
        gameId,
        callerDeviceClientId: deviceClientId,
        targetPlayerId: pendingTarget.id,
      });
      setPendingTarget(null);
    } catch (e) {
      showAlert('Could not shoot', e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  function handleCancel() {
    if (submitting) return;
    setPendingTarget(null);
  }

  async function handleSkip() {
    if (submitting) return;
    setSubmitting(true);
    try {
      await submitSkip({ gameId, callerDeviceClientId: deviceClientId });
    } catch (e) {
      showAlert('Error', e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  if (revilerState.hasActedThisNight) {
    return (
      <View className="flex-1 px-6 pt-2 pb-8">
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color="#D4A017" />
          <Text className="text-wolf-text text-sm text-center mt-6 px-4">
            Waiting for the night to settle…
          </Text>
          {revilerState.tonightShot ? (
            <Text className="text-wolf-text text-sm text-center mt-4 px-4">
              <Text style={{ color: '#B03A2E' }} className="font-bold">
                REVILED:
              </Text>{' '}
              {revilerState.tonightShot.name}
            </Text>
          ) : revilerState.tonightSkipped ? (
            <Text className="text-wolf-text text-sm text-center mt-4 px-4 italic">
              Passed tonight.
            </Text>
          ) : null}
        </View>
      </View>
    );
  }

  return (
    <View className="flex-1">
      <NightPickerLayout
        ring={circleSize => (
          <SeatingCircle
            size={circleSize}
            phase="night"
            totalSeats={totalSeats}
            players={alivePlayers}
            meId={meId}
            viewerSeatIndex={meSeatPosition}
            selectableIds={
              new Set(targetables.map(t => t._id as unknown as string))
            }
            onPress={
              submitting || pendingTarget
                ? undefined
                : p => handlePickTarget(p._id, p.name)
            }
          />
        )}
        footer={
          !isGhost ? (
            <TouchableOpacity
              onPress={handleSkip}
              disabled={submitting || !!pendingTarget}
              style={{ opacity: submitting || pendingTarget ? 0.4 : 1 }}
              className="bg-wolf-card rounded-xl py-4 items-center"
            >
              <Text className="text-wolf-text text-base font-bold tracking-widest">
                PASS TONIGHT
              </Text>
            </TouchableOpacity>
          ) : undefined
        }
      >
        <Text className="text-wolf-text text-base text-center mt-2 mb-2">
          {isGhost
            ? "The Reviler is choosing whether to revile a special villager. They die if they miss."
            : "Pick a special villager to revile them. If they aren't one, you die instead."}
        </Text>
      </NightPickerLayout>

      {pendingTarget && (
        <ConfirmOverlay
          onCancel={handleCancel}
          onConfirm={handleConfirm}
          submitting={submitting}
        >
          <Text className="text-wolf-muted text-xs font-bold tracking-widest mb-3">
            REVILE
          </Text>
          <Text className="text-wolf-text text-3xl font-extrabold text-center mb-2">
            {pendingTarget.name.toUpperCase()}
          </Text>
          <Text className="text-wolf-muted text-sm text-center px-4">
            If they aren't a special villager, you die. Are you sure?
          </Text>
        </ConfirmOverlay>
      )}
    </View>
  );
}

// ───── Nightmare Wolf picker ───────────────────────────────────────────────
//
// Wakes alone after the pack chooses a kill. Two charges per game total —
// each puts a non-wolf player to sleep, blocking their night ability for the
// current night. Same-target restriction is enforced both server-side and by
// excluding prior targets from `targetables`. Skip preserves both charges.

function NightmareWolfPicker({
  gameId,
  deviceClientId,
  alivePlayers,
  targetables,
  totalSeats,
  nightmareState,
  meId,
  meSeatPosition,
  isGhost,
}: {
  gameId: Id<'games'>;
  deviceClientId: string;
  alivePlayers: SeatingPlayer[];
  targetables: Targetable[];
  totalSeats: number;
  nightmareState: {
    charges: number;
    prevTargets: Array<{ _id: Id<'players'>; name: string }>;
    hasActedThisNight: boolean;
    tonightTarget: { _id: Id<'players'>; name: string } | null;
    tonightSkipped: boolean;
  };
  meId: Id<'players'>;
  meSeatPosition?: number;
  isGhost?: boolean;
}) {
  const submitPut = useMutation(api.night.submitNightmarePut);
  const submitSkip = useMutation(api.night.submitNightmareSkip);
  const [submitting, setSubmitting] = useState(false);
  const [pendingTarget, setPendingTarget] = useState<{
    id: Id<'players'>;
    name: string;
  } | null>(null);

  function handlePickTarget(targetId: Id<'players'>, name: string) {
    if (submitting || pendingTarget) return;
    setPendingTarget({ id: targetId, name });
  }

  async function handleConfirm() {
    if (!pendingTarget || submitting) return;
    setSubmitting(true);
    try {
      await submitPut({
        gameId,
        callerDeviceClientId: deviceClientId,
        targetPlayerId: pendingTarget.id,
      });
      setPendingTarget(null);
    } catch (e) {
      showAlert('Could not act', e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  function handleCancel() {
    if (submitting) return;
    setPendingTarget(null);
  }

  async function handleSkip() {
    if (submitting) return;
    setSubmitting(true);
    try {
      await submitSkip({ gameId, callerDeviceClientId: deviceClientId });
    } catch (e) {
      showAlert('Error', e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  if (nightmareState.hasActedThisNight) {
    return (
      <View className="flex-1 px-6 pt-2 pb-8">
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color="#D4A017" />
          <Text className="text-wolf-text text-sm text-center mt-6 px-4">
            Waiting for the night to settle…
          </Text>
          {nightmareState.tonightTarget ? (
            <Text className="text-wolf-text text-sm text-center mt-4 px-4">
              <Text style={{ color: '#7B52A8' }} className="font-bold">
                PUT TO SLEEP:
              </Text>{' '}
              {nightmareState.tonightTarget.name}
            </Text>
          ) : nightmareState.tonightSkipped ? (
            <Text
              style={{ color: '#B68AD9' }}
              className="text-sm text-center mt-4 px-4 italic"
            >
              Nightmares saved.
            </Text>
          ) : null}
        </View>
      </View>
    );
  }

  const chargesLabel =
    nightmareState.charges === 2
      ? '2 NIGHTMARES LEFT'
      : nightmareState.charges === 1
        ? '1 NIGHTMARE LEFT'
        : 'NIGHTMARES SPENT';

  return (
    <View className="flex-1">
      <NightPickerLayout
        ring={circleSize => (
          <SeatingCircle
            size={circleSize}
            phase="night"
            totalSeats={totalSeats}
            players={alivePlayers}
            meId={meId}
            viewerSeatIndex={meSeatPosition}
            selectableIds={
              new Set(targetables.map(t => t._id as unknown as string))
            }
            onPress={
              submitting || pendingTarget
                ? undefined
                : p => handlePickTarget(p._id, p.name)
            }
          />
        )}
        footer={
          !isGhost ? (
            <TouchableOpacity
              onPress={handleSkip}
              disabled={submitting || !!pendingTarget}
              style={{ opacity: submitting || pendingTarget ? 0.4 : 1 }}
              className="bg-wolf-card rounded-xl py-4 items-center"
            >
              <Text className="text-wolf-text text-base font-bold tracking-widest">
                SAVE FOR LATER
              </Text>
            </TouchableOpacity>
          ) : undefined
        }
      >
        <Text
          style={{ color: '#B68AD9' }}
          className="text-base text-center mt-2 mb-1"
        >
          {isGhost
            ? 'The Nightmare Wolf is choosing whom to put to sleep.'
            : "Pick a villager to put to sleep. They won't be able to use their night power if they have one."}
        </Text>
        <Text className="text-wolf-muted text-xs tracking-widest text-center mb-2">
          {chargesLabel}
        </Text>
        {nightmareState.prevTargets.length > 0 && (
          <Text className="text-wolf-muted text-xs text-center mb-2 italic">
            Already nightmared:{' '}
            {nightmareState.prevTargets.map(t => t.name).join(', ')}
          </Text>
        )}
      </NightPickerLayout>

      {pendingTarget && (
        <ConfirmOverlay
          onCancel={handleCancel}
          onConfirm={handleConfirm}
          submitting={submitting}
        >
          <Text className="text-wolf-muted text-xs font-bold tracking-widest mb-3">
            PUT TO SLEEP
          </Text>
          <Text className="text-wolf-text text-3xl font-extrabold text-center mb-2">
            {pendingTarget.name.toUpperCase()}
          </Text>
          <Text className="text-wolf-muted text-sm text-center px-4">
            They cannot use their night power tonight. You only have two of
            these, ever.
          </Text>
        </ConfirmOverlay>
      )}
    </View>
  );
}

// ───── Nightmare-blocked overlay ───────────────────────────────────────────
//
// Replaces the WaitingView for a living picker-role actor when they've been
// nightmared this night. Renders only while the would-be active step is
// running (server-side `nightmaredBlocking` flag), so it doesn't surface for
// other steps in the same night.

function NightmareBlockedView() {
  return (
    <View className="flex-1 items-center justify-center px-8">
      <Text
        style={{ color: '#7B52A8' }}
        className="text-base font-bold tracking-widest mb-4"
      >
        NIGHTMARE
      </Text>
      <Text className="text-wolf-text text-3xl font-extrabold text-center mb-4">
        YOU'VE BEEN PUT{'\n'}TO SLEEP
      </Text>
      <Text className="text-wolf-text text-sm text-center px-4">
        You're unable to wake in time to use your power.
      </Text>
    </View>
  );
}

const NIGHT_WHISPERS = [
  'WHO WILL COME FOR YOU IN THE NIGHT?',
  'THE VILLAGE SLEEPS. SOMETHING DOES NOT.',
  'TRUST NO ONE.',
  'LISTEN… CAN YOU HEAR THE FOOTSTEPS?',
  'BY MORNING, ONE LESS HEART WILL BEAT.',
  'THE MOON KEEPS ITS SECRETS.',
  'WHO WHISPERS YOUR NAME?',
  'NOT EVERY FRIEND IS A FRIEND.',
  'EYES CLOSED. EARS OPEN.',
  'YOUR FATE IS DECIDED IN THE DARK.',
  'SOMETHING HOWLS BEYOND THE TREELINE.',
  'THE WOLVES ARE DREAMING OF YOU.',
  "DON'T PEEK. IT WILL BE WORSE IF YOU DO.",
  'EVERY SHADOW HIDES A SECRET.',
];

// Visible NIGHT ACTIONS decision countdown shown above the active picker, so
// the acting player knows their clock. White > 10s; flashes red/white per
// second in the final 10s; lands on red at 0 (then the engine auto-resolves).
function NightDecisionCountdown({ endsAt }: { endsAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);
  const sec = Math.max(0, Math.ceil((endsAt - now) / 1000));
  const low = sec <= 10;
  const color =
    sec === 0 || (low && sec % 2 === 0) ? '#B03A2E' : '#F0EDE8';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return (
    <View className="items-center" style={{ marginTop: 2, marginBottom: 4 }}>
      <Text
        className="text-wolf-muted text-[11px] font-bold tracking-widest"
        style={SCENE_TEXT_SHADOW}
      >
        TIME TO DECIDE
      </Text>
      <Text
        style={{
          color,
          fontSize: 44,
          fontWeight: '800',
          fontVariant: ['tabular-nums'],
          lineHeight: 50,
          ...SCENE_TEXT_SHADOW,
        }}
      >
        {m}:{String(s).padStart(2, '0')}
      </Text>
    </View>
  );
}

function WaitingView() {
  const [lineIndex, setLineIndex] = useState(() =>
    Math.floor(Math.random() * NIGHT_WHISPERS.length),
  );
  const fade = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const tick = () => {
      Animated.timing(fade, {
        toValue: 0,
        duration: 900,
        useNativeDriver: true,
      }).start(() => {
        setLineIndex((i) => (i + 1) % NIGHT_WHISPERS.length);
        Animated.timing(fade, {
          toValue: 1,
          duration: 900,
          useNativeDriver: true,
        }).start();
      });
    };
    const id = setInterval(tick, 6000);
    return () => clearInterval(id);
  }, [fade]);

  // Themed (and 16bit-scaled) font for the whisper; derive a generous
  // lineHeight from the resolved size so wrapped whispers don't bunch up.
  const whisperFont = themedFont(undefined, 16);

  return (
    <View className="flex-1 pb-8">
      <View className="flex-1 items-center justify-center">
        <Animated.Text
          // Styled inline (not className): the global font patch makes
          // Animated.Text wrap the themed Text, which NativeWind no longer maps
          // className onto — so color/align/spacing must be set directly here.
          style={{
            opacity: fade,
            color: '#F0EDE8', // wolf-text
            textAlign: 'center',
            letterSpacing: 2,
            marginBottom: 24,
            paddingHorizontal: 32,
            ...whisperFont,
            lineHeight: (whisperFont.fontSize ?? 16) * 1.6,
            ...SCENE_TEXT_SHADOW,
          }}
        >
          {NIGHT_WHISPERS[lineIndex]}
        </Animated.Text>
      </View>

    </View>
  );
}
