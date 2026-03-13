import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Pressable,
  Modal,
  Image,
  StyleSheet,
  useWindowDimensions,
} from 'react-native';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { StackNavigationProp } from '@react-navigation/stack';
import * as ScreenOrientation from 'expo-screen-orientation';
import { Audio } from 'expo-av';
import type { RootStackParamList } from '../navigation/types';

type Phase = 'day' | 'night' | 'trial';
type TrialSubPhase = 'accusation' | 'defense' | 'vote';
type TimerState = 'stopped' | 'running' | 'ended';

type ClockRoute = RouteProp<RootStackParamList, 'Clock'>;
type ClockNav = StackNavigationProp<RootStackParamList, 'Clock'>;

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

export default function ClockScreen() {
  const navigation = useNavigation<ClockNav>();
  const route = useRoute<ClockRoute>();
  const { dayDuration, accusationDuration, defenseDuration, nominations: initNoms } = route.params;

  // Active settings — start as route params but update when user saves from modal
  const activeDayDuration = useRef(dayDuration);
  const activeAccusationDuration = useRef(accusationDuration);
  const activeDefenseDuration = useRef(defenseDuration);
  const activeNominations = useRef(initNoms);

  // Orientation
  useEffect(() => {
    ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE);
    return () => {
      ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
    };
  }, []);

  // Sounds
  const bellRef = useRef<Audio.Sound | null>(null);
  const gavelRef = useRef<Audio.Sound | null>(null);

  useEffect(() => {
    let bell: Audio.Sound;
    let gavel: Audio.Sound;
    (async () => {
      try {
        ({ sound: bell } = await Audio.Sound.createAsync(
          require('../../assets/sounds/church_bell.mp3')
        ));
        bellRef.current = bell;
      } catch (_) {}
      try {
        ({ sound: gavel } = await Audio.Sound.createAsync(
          require('../../assets/sounds/gavel.mp3')
        ));
        gavelRef.current = gavel;
      } catch (_) {}
    })();
    return () => {
      bellRef.current?.unloadAsync();
      gavelRef.current?.unloadAsync();
    };
  }, []);

  async function playBell() {
    try { await bellRef.current?.replayAsync(); } catch (_) {}
  }
  async function playGavel() {
    try { await gavelRef.current?.replayAsync(); } catch (_) {}
  }

  // Cycle state
  const [dayNumber, setDayNumber] = useState(1);
  const [phase, setPhase] = useState<Phase>('day');

  // Day timer
  const [daySecondsLeft, setDaySecondsLeft] = useState(dayDuration);
  const [dayRunning, setDayRunning] = useState(false);
  const [dayExpired, setDayExpired] = useState(false);
  const [flashOn, setFlashOn] = useState(false);

  // Nominations
  const [nomsLeft, setNomsLeft] = useState(initNoms);

  // Trial
  const [trialSubPhase, setTrialSubPhase] = useState<TrialSubPhase>('accusation');
  const [accusationState, setAccusationState] = useState<TimerState>('stopped');
  const [defenseState, setDefenseState] = useState<TimerState>('stopped');
  const [accusationSecondsLeft, setAccusationSecondsLeft] = useState(accusationDuration);
  const [defenseSecondsLeft, setDefenseSecondsLeft] = useState(defenseDuration);
  const nomsAtTrialStart = useRef(0);

  // Tutorial modal
  const [tutorialVisible, setTutorialVisible] = useState(true);
  const [tutorialPage, setTutorialPage] = useState(0);

  const TUTORIAL_PAGES = [
    {
      title: 'Welcome to ModClock',
      lines: [
        'ModClock helps you moderate each phase of the game.',
        '',
        'Top-left — current phase (Day 1, Night 2, etc.)',
        'Top-right — ⚙ settings cog to adjust timers mid-game',
        'Center — the active timer or phase display',
        'Bottom-left — nominations remaining',
        'Bottom-right — action buttons (ON TRIAL / NEXT NIGHT / ⌂)',
      ],
    },
    {
      title: 'Day Phase',
      lines: [
        'The large center timer counts down the length of the day.',
        '',
        'TAP anywhere on the screen to start or pause the timer.',
        '',
        'When 10 seconds remain, the timer flashes gold as a warning.',
        '',
        'When time runs out, the timer turns red and a bell rings.',
        'The day is over — time to call a vote or end the phase.',
      ],
    },
    {
      title: 'Nominations & Trials',
      lines: [
        'NOMS = X (bottom-left) shows how many nominations are left.',
        '',
        'Tap ON TRIAL to put a player on trial. Each trial uses one nomination.',
        '',
        'ON TRIAL is disabled when nominations reach 0 or the day has expired.',
        '',
        'During a trial, TIME REMAINING (top-right) shows the length of day clock.',
        'Tap END TRIAL to return to the day phase — this also uses one nomination.',
      ],
    },
    {
      title: 'Trial Flow',
      lines: [
        'Each trial has three sub-phases:',
        '',
        '1. ACCUSATION — tap START ACCUSATION to begin the accuser\'s timer.',
        '   Tap END ACCUSATION at any time (or after expiry) to advance.',
        '2. DEFENSE — tap START DEFENSE to begin the accused\'s timer.',
        '   Tap END DEFENSE at any time (or after expiry) to advance.',
        '3. TIME TO VOTE — shown after defense ends.',
        '   Tap END TRIAL once the vote is complete.',
        '',
        'TAP the center to pause/resume. ↺ resets the timer to its full duration.',
      ],
    },
    {
      title: 'Night Phase & Settings',
      lines: [
        'Tap NEXT NIGHT to end the day and enter the night phase.',
        'Resolve night actions during this time.',
        '',
        'Tap NEXT DAY to begin a new day with fresh timers and nominations.',
        '',
        '⚙ (top-right) opens settings to adjust timer lengths and nomination',
        'count at any point. Changes take effect immediately and reset the clock.',
        '',
        '⌂ (bottom-right) returns to the home screen at any time.',
      ],
    },
  ];

  // Settings modal
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [tempDay, setTempDay] = useState(dayDuration);
  const [tempAccusation, setTempAccusation] = useState(accusationDuration);
  const [tempDefense, setTempDefense] = useState(defenseDuration);
  const [tempNoms, setTempNoms] = useState(initNoms);

  function openSettings() {
    // Pause any running timers
    setDayRunning(false);
    setAccusationState(s => s === 'running' ? 'stopped' : s);
    setDefenseState(s => s === 'running' ? 'stopped' : s);
    setTempDay(activeDayDuration.current);
    setTempAccusation(activeAccusationDuration.current);
    setTempDefense(activeDefenseDuration.current);
    setTempNoms(activeNominations.current);
    setSettingsVisible(true);
  }

  function saveSettings() {
    activeDayDuration.current = tempDay;
    activeAccusationDuration.current = tempAccusation;
    activeDefenseDuration.current = tempDefense;
    activeNominations.current = tempNoms;
    clearAllIntervals();
    setDaySecondsLeft(tempDay);
    setDayRunning(false);
    setDayExpired(false);
    setFlashOn(false);
    setAccusationSecondsLeft(tempAccusation);
    setDefenseSecondsLeft(tempDefense);
    setNomsLeft(tempNoms);
    setPhase('day');
    setTrialSubPhase('accusation');
    setAccusationState('stopped');
    setDefenseState('stopped');
    setSettingsVisible(false);
  }

  // Interval refs
  const dayIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const accusationIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const defenseIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function clearAllIntervals() {
    if (dayIntervalRef.current) clearInterval(dayIntervalRef.current);
    if (accusationIntervalRef.current) clearInterval(accusationIntervalRef.current);
    if (defenseIntervalRef.current) clearInterval(defenseIntervalRef.current);
  }

  // Day timer effect
  useEffect(() => {
    if (!dayRunning || phase !== 'day') {
      if (dayIntervalRef.current) clearInterval(dayIntervalRef.current);
      return;
    }
    dayIntervalRef.current = setInterval(() => {
      setDaySecondsLeft(prev => {
        if (prev <= 1) {
          clearInterval(dayIntervalRef.current!);
          setDayRunning(false);
          setDayExpired(true);
          playBell();
          return 0;
        }
        const next = prev - 1;
        if (next <= 10) setFlashOn(f => !f);
        return next;
      });
    }, 1000);
    return () => { if (dayIntervalRef.current) clearInterval(dayIntervalRef.current); };
  }, [dayRunning, phase]);

  // Accusation timer effect
  useEffect(() => {
    if (accusationState !== 'running') {
      if (accusationIntervalRef.current) clearInterval(accusationIntervalRef.current);
      return;
    }
    accusationIntervalRef.current = setInterval(() => {
      setAccusationSecondsLeft(prev => {
        if (prev <= 1) {
          clearInterval(accusationIntervalRef.current!);
          setAccusationState('ended');
          playGavel();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => { if (accusationIntervalRef.current) clearInterval(accusationIntervalRef.current); };
  }, [accusationState]);


  // Defense timer effect
  useEffect(() => {
    if (defenseState !== 'running') {
      if (defenseIntervalRef.current) clearInterval(defenseIntervalRef.current);
      return;
    }
    defenseIntervalRef.current = setInterval(() => {
      setDefenseSecondsLeft(prev => {
        if (prev <= 1) {
          clearInterval(defenseIntervalRef.current!);
          setDefenseState('ended');
          playGavel();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => { if (defenseIntervalRef.current) clearInterval(defenseIntervalRef.current); };
  }, [defenseState]);

  // Phase transitions
  function startTrial() {
    nomsAtTrialStart.current = nomsLeft;
    setDayRunning(false);
    setTrialSubPhase('accusation');
    setAccusationState('stopped');
    setAccusationSecondsLeft(activeAccusationDuration.current);
    setDefenseSecondsLeft(activeDefenseDuration.current);
    setDefenseState('stopped');
    setPhase('trial');
  }

  function endTrial() {
    if (accusationIntervalRef.current) clearInterval(accusationIntervalRef.current);
    if (defenseIntervalRef.current) clearInterval(defenseIntervalRef.current);
    setAccusationState('stopped');
    setDefenseState('stopped');
    setNomsLeft(n => n - 1);
    setPhase('day');
  }

  function goToNight() {
    clearAllIntervals();
    setDayRunning(false);
    setPhase('night');
  }

  function goToNextDay() {
    setDayNumber(n => n + 1);
    setDaySecondsLeft(activeDayDuration.current);
    setNomsLeft(activeNominations.current);
    setDayRunning(false);
    setDayExpired(false);
    setFlashOn(false);
    setPhase('day');
  }

  function handleCenterTap() {
    if (phase === 'day') {
      if (dayExpired) return;
      setDayRunning(r => !r);
    } else if (phase === 'trial') {
      if (trialSubPhase === 'accusation') {
        if (accusationState === 'ended') return;
        setAccusationState(s => s === 'running' ? 'stopped' : 'running');
      } else if (trialSubPhase === 'defense') {
        if (defenseState === 'ended') return;
        setDefenseState(s => s === 'running' ? 'stopped' : 'running');
      }
    }
  }

  function resetAccusation() {
    setAccusationState('stopped');
    setAccusationSecondsLeft(activeAccusationDuration.current);
  }

  function resetDefense() {
    setDefenseState('stopped');
    setDefenseSecondsLeft(activeDefenseDuration.current);
  }

  // Colors
  function dayTimerColor(): string {
    if (dayExpired) return '#B03A2E';
    if (daySecondsLeft <= 10) return flashOn ? '#D4A017' : '#F0EDE8';
    return '#F0EDE8';
  }

  const endTrialDisabled =
    phase === 'trial' && trialSubPhase === 'vote' && nomsAtTrialStart.current === 1;

  const onTrialDisabled =
    phase === 'day' && (dayExpired || nomsLeft <= 0);

  // Derived label for phase indicator
  const phaseLabel = phase === 'night'
    ? `Night ${dayNumber}`
    : `Day ${dayNumber}`;

  // Center content
  function renderCenter() {
    if (phase === 'night') {
      return (
        <View style={styles.nightCenter}>
          <Image
            source={require('../../assets/images/wolfmod_logo.png')}
            style={styles.logo}
            resizeMode="contain"
          />
          <Text style={styles.nightLabel}>PERFORM NIGHT ACTIONS</Text>
        </View>
      );
    }

    if (phase === 'trial') {
      if (trialSubPhase === 'vote') {
        return <Text style={styles.voteText}>TIME TO VOTE</Text>;
      }
      const isAccusation = trialSubPhase === 'accusation';
      const secs = isAccusation ? accusationSecondsLeft : defenseSecondsLeft;
      const timerState = isAccusation ? accusationState : defenseState;
      const expired = secs === 0;
      return (
        <View style={styles.trialCenter}>
          {timerState === 'running' && (
            <Text style={styles.tapHint}>TAP TO PAUSE</Text>
          )}
          {timerState === 'stopped' && secs < (isAccusation ? accusationDuration : defenseDuration) && (
            <Text style={styles.tapHint}>TAP TO START</Text>
          )}
          <Text style={[styles.mainTimer, { color: expired ? '#B03A2E' : '#F0EDE8' }]}>
            {formatTime(secs)}
          </Text>
        </View>
      );
    }

    // Day phase
    return (
      <View style={styles.dayCenter}>
        <Text style={styles.tapHint}>{dayRunning ? 'TAP TO PAUSE' : 'TAP TO START'}</Text>
        <Text style={[styles.mainTimer, { color: dayTimerColor() }]}>
          {formatTime(daySecondsLeft)}
        </Text>
      </View>
    );
  }

  // Trial control buttons (shown in bottom bar during trial)
  function renderTrialControls() {
    if (phase !== 'trial') return null;
    const isAccusation = trialSubPhase === 'accusation';
    const isDefense = trialSubPhase === 'defense';

    if (trialSubPhase === 'vote') return null;

    const timerState = isAccusation ? accusationState : defenseState;
    const startLabel = isAccusation ? 'START ACCUSATION' : 'START DEFENSE';
    const endLabel = isAccusation ? 'END ACCUSATION' : 'END DEFENSE';
    const resetFn = isAccusation ? resetAccusation : resetDefense;

    const handleTrialTimerPress = () => {
      if (timerState === 'stopped') {
        // START
        if (isAccusation) setAccusationState('running');
        else setDefenseState('running');
      } else {
        // END (running or ended) — advance to next phase
        if (isAccusation) {
          setTrialSubPhase('defense');
          setAccusationState('stopped');
          setDefenseState('stopped');
          setDefenseSecondsLeft(activeDefenseDuration.current);
        } else {
          setTrialSubPhase('vote');
        }
      }
    };

    return (
      <View style={styles.trialControls}>
        <TouchableOpacity
          style={styles.iconBtn}
          onPress={resetFn}
        >
          <Text style={styles.iconBtnText}>↺</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.controlBtn} onPress={handleTrialTimerPress}>
          <Text style={styles.controlBtnText}>
            {timerState === 'stopped' ? startLabel : timerState === 'running' ? endLabel : endLabel}
          </Text>
        </TouchableOpacity>
      </View>
    );
  }

  const { width: W, height: H } = useWindowDimensions();

  return (
    <Pressable style={styles.container} onPress={handleCenterTap}>

      {/* Top-left: phase label */}
      <Text style={styles.phaseLabel}>{phaseLabel}</Text>

      {/* Top-right: time remaining during trial */}
      {phase === 'trial' && (
        <Text style={styles.timeRemaining}>
          TIME REMAINING = {formatTime(daySecondsLeft)}
        </Text>
      )}

      {/* Top-right: settings cog */}
      <TouchableOpacity style={styles.cogBtn} onPress={openSettings}>
        <Text style={styles.cogText}>⚙</Text>
      </TouchableOpacity>

      {/* Settings Modal */}
      <Modal
        visible={settingsVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setSettingsVisible(false)}
      >
        <Pressable style={styles.modalOverlay} onPress={() => setSettingsVisible(false)}>
          <Pressable style={styles.modalBox} onPress={e => e.stopPropagation()}>
            {/* Header */}
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Clock Settings</Text>
              <View style={styles.modalHeaderRight}>
                <TouchableOpacity onPress={() => { setSettingsVisible(false); setTutorialPage(0); setTutorialVisible(true); }}>
                  <Text style={styles.modalTutorialBtn}>?</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => setSettingsVisible(false)}>
                  <Text style={styles.modalClose}>✕</Text>
                </TouchableOpacity>
              </View>
            </View>

            {/* Steppers */}
            {[
              { label: 'LENGTH OF DAY', value: tempDay, set: setTempDay, step: 30, min: 30, isTime: true },
              { label: 'ACCUSATION',    value: tempAccusation, set: setTempAccusation, step: 10, min: 10, isTime: true },
              { label: 'DEFENSE',       value: tempDefense, set: setTempDefense, step: 10, min: 10, isTime: true },
              { label: 'NOMINATIONS',   value: tempNoms, set: setTempNoms, step: 1, min: 1, isTime: false },
            ].map(({ label, value, set, step, min, isTime }) => (
              <View key={label} style={styles.modalRow}>
                <Text style={styles.modalRowLabel}>{label}</Text>
                <View style={styles.modalStepper}>
                  <TouchableOpacity
                    style={[styles.modalStepBtn, value <= min && styles.stepBtnDisabled]}
                    onPress={() => set((v: number) => Math.max(min, v - step))}
                    disabled={value <= min}
                  >
                    <Text style={styles.modalStepBtnText}>−</Text>
                  </TouchableOpacity>
                  <Text style={styles.modalStepValue}>
                    {isTime ? formatTime(value) : String(value)}
                  </Text>
                  <TouchableOpacity
                    style={styles.modalStepBtn}
                    onPress={() => set((v: number) => v + step)}
                  >
                    <Text style={styles.modalStepBtnText}>+</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ))}

            {/* Footer buttons */}
            <View style={styles.modalFooter}>
              <TouchableOpacity style={styles.modalCancelBtn} onPress={() => setSettingsVisible(false)}>
                <Text style={styles.modalCancelText}>CANCEL</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.modalSaveBtn} onPress={saveSettings}>
                <Text style={styles.modalSaveText}>SAVE</Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Tutorial Modal */}
      <Modal
        visible={tutorialVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setTutorialVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.tutorialBox}>
            {/* Header */}
            <Text style={styles.tutorialTitle}>{TUTORIAL_PAGES[tutorialPage].title}</Text>

            {/* Content */}
            <View style={styles.tutorialContent}>
              {TUTORIAL_PAGES[tutorialPage].lines.map((line, i) => (
                <Text
                  key={i}
                  style={line === '' ? styles.tutorialSpacer : styles.tutorialLine}
                >
                  {line}
                </Text>
              ))}
            </View>

            {/* Pagination dots */}
            <View style={styles.tutorialDots}>
              {TUTORIAL_PAGES.map((_, i) => (
                <View
                  key={i}
                  style={[styles.tutorialDot, i === tutorialPage && styles.tutorialDotActive]}
                />
              ))}
            </View>

            {/* Footer */}
            <View style={styles.tutorialFooter}>
              <TouchableOpacity
                style={styles.tutorialSkipBtn}
                onPress={() => { setTutorialVisible(false); setTutorialPage(0); }}
              >
                <Text style={styles.tutorialSkipText}>SKIP</Text>
              </TouchableOpacity>
              <View style={styles.tutorialNavBtns}>
                {tutorialPage > 0 && (
                  <TouchableOpacity
                    style={styles.tutorialNavBtn}
                    onPress={() => setTutorialPage(p => p - 1)}
                  >
                    <Text style={styles.tutorialNavText}>‹ BACK</Text>
                  </TouchableOpacity>
                )}
                {tutorialPage < TUTORIAL_PAGES.length - 1 ? (
                  <TouchableOpacity
                    style={[styles.tutorialNavBtn, styles.tutorialNextBtn]}
                    onPress={() => setTutorialPage(p => p + 1)}
                  >
                    <Text style={styles.tutorialNextText}>NEXT ›</Text>
                  </TouchableOpacity>
                ) : (
                  <TouchableOpacity
                    style={[styles.tutorialNavBtn, styles.tutorialNextBtn]}
                    onPress={() => { setTutorialVisible(false); setTutorialPage(0); }}
                  >
                    <Text style={styles.tutorialNextText}>GOT IT</Text>
                  </TouchableOpacity>
                )}
              </View>
            </View>
          </View>
        </View>
      </Modal>

      {/* Center content */}
      <View style={styles.center}>
        {renderCenter()}
      </View>

      {/* Bottom bar */}
      <View style={styles.bottomBar}>
        {/* Bottom-left: noms */}
        {phase !== 'night' && (
          <Text style={styles.nomsText}>NOMS = {nomsLeft}</Text>
        )}
        {phase === 'night' && <View style={styles.bottomLeft} />}

        {/* Bottom-center: trial controls */}
        <View style={styles.bottomCenter}>
          {renderTrialControls()}
        </View>

        {/* Bottom-right: action buttons */}
        <View style={styles.bottomRight}>
          {phase !== 'night' && (
            <TouchableOpacity
              style={[styles.actionBtn, onTrialDisabled && styles.btnDisabled]}
              onPress={phase === 'trial' ? endTrial : startTrial}
              disabled={onTrialDisabled || endTrialDisabled}
            >
              <Text style={[styles.actionBtnText, (onTrialDisabled || endTrialDisabled) && styles.btnDisabledText]}>
                {phase === 'trial' ? 'END TRIAL' : 'ON TRIAL'}
              </Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={styles.actionBtn}
            onPress={phase === 'night' ? goToNextDay : goToNight}
          >
            <Text style={styles.actionBtnText}>
              {phase === 'night' ? 'NEXT DAY' : 'NEXT NIGHT'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.actionBtn}
            onPress={() => navigation.popToTop()}
          >
            <Text style={styles.actionBtnText}>⌂</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0F0F14',
  },
  phaseLabel: {
    position: 'absolute',
    top: 32,
    left: 60,
    color: '#F0EDE8',
    fontSize: 36,
    fontWeight: '700',
  },
  timeRemaining: {
    position: 'absolute',
    top: 32,
    right: 130,
    color: '#8A8590',
    fontSize: 36,
    fontWeight: '600',
  },
  cogBtn: {
    position: 'absolute',
    top: 38,
    right: 80,
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cogText: {
    color: '#8A8590',
    fontSize: 24,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.75)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalBox: {
    backgroundColor: '#1A1A24',
    borderRadius: 16,
    padding: 16,
    width: 420,
    gap: 8,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 2,
  },
  modalTitle: {
    color: '#F0EDE8',
    fontSize: 16,
    fontWeight: '700',
  },
  modalHeaderRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  modalTutorialBtn: {
    color: '#D4A017',
    fontSize: 16,
    fontWeight: '700',
    paddingHorizontal: 4,
  },
  modalClose: {
    color: '#8A8590',
    fontSize: 16,
    paddingHorizontal: 4,
  },
  modalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  modalRowLabel: {
    color: '#8A8590',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.5,
    flex: 1,
  },
  modalStepper: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  modalStepBtn: {
    width: 32,
    height: 32,
    backgroundColor: '#22222F',
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepBtnDisabled: {
    opacity: 0.3,
  },
  modalStepBtnText: {
    color: '#F0EDE8',
    fontSize: 20,
    lineHeight: 22,
  },
  modalStepValue: {
    color: '#F0EDE8',
    fontSize: 22,
    fontWeight: '600',
    minWidth: 72,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },
  modalFooter: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 4,
  },
  modalCancelBtn: {
    flex: 1,
    backgroundColor: '#22222F',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  modalCancelText: {
    color: '#8A8590',
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 1,
  },
  modalSaveBtn: {
    flex: 1,
    backgroundColor: '#D4A017',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  modalSaveText: {
    color: '#0F0F14',
    fontSize: 14,
    fontWeight: '800',
    letterSpacing: 1,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dayCenter: {
    alignItems: 'center',
    gap: 8,
  },
  trialCenter: {
    alignItems: 'center',
    gap: 8,
  },
  tapHint: {
    color: '#8A8590',
    fontSize: 14,
    fontWeight: '600',
    letterSpacing: 1,
  },
  mainTimer: {
    fontSize: 160,
    fontWeight: '200',
    fontVariant: ['tabular-nums'],
    lineHeight: 170,
  },
  voteText: {
    color: '#D4A017',
    fontSize: 48,
    fontWeight: '700',
    letterSpacing: 2,
  },
  nightCenter: {
    alignItems: 'center',
    gap: 12,
  },
  logo: {
    width: 220,
    height: 220,
  },
  nightLabel: {
    color: '#8A8590',
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 2,
  },
  bottomBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 70,
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 60,
    paddingRight: 80,
    paddingBottom: 8,
  },
  bottomLeft: {
    flex: 1,
  },
  bottomCenter: {
    flex: 2,
    alignItems: 'flex-start',
    paddingLeft: 20,
  },
  bottomRight: {
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
  },
  nomsText: {
    flex: 1,
    color: '#F0EDE8',
    fontSize: 36,
    fontWeight: '600',
  },
  actionBtn: {
    backgroundColor: '#22222F',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: '#3A3A4A',
  },
  actionBtnText: {
    color: '#F0EDE8',
    fontSize: 13,
    fontWeight: '600',
  },
  btnDisabled: {
    opacity: 0.35,
  },
  btnDisabledText: {
    opacity: 0.4,
  },
  trialControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  controlBtn: {
    backgroundColor: '#1A1A24',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: '#D4A017',
  },
  controlBtnText: {
    color: '#D4A017',
    fontSize: 13,
    fontWeight: '700',
  },
  iconBtn: {
    width: 36,
    height: 36,
    backgroundColor: '#22222F',
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconBtnText: {
    color: '#F0EDE8',
    fontSize: 20,
    includeFontPadding: false,
    lineHeight: 22,
    marginBottom: 5,
  },
  tutorialBox: {
    backgroundColor: '#1A1A24',
    borderRadius: 16,
    padding: 24,
    width: 520,
    gap: 16,
  },
  tutorialTitle: {
    color: '#D4A017',
    fontSize: 18,
    fontWeight: '800',
    letterSpacing: 1,
    textAlign: 'center',
  },
  tutorialContent: {
    gap: 2,
  },
  tutorialLine: {
    color: '#F0EDE8',
    fontSize: 14,
    lineHeight: 22,
  },
  tutorialSpacer: {
    height: 6,
  },
  tutorialDots: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
  },
  tutorialDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: '#3A3A4A',
  },
  tutorialDotActive: {
    backgroundColor: '#D4A017',
  },
  tutorialFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  tutorialSkipBtn: {
    paddingVertical: 8,
    paddingHorizontal: 4,
  },
  tutorialSkipText: {
    color: '#8A8590',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 1,
  },
  tutorialNavBtns: {
    flexDirection: 'row',
    gap: 10,
  },
  tutorialNavBtn: {
    backgroundColor: '#22222F',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 18,
  },
  tutorialNavText: {
    color: '#F0EDE8',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 1,
  },
  tutorialNextBtn: {
    backgroundColor: '#D4A017',
  },
  tutorialNextText: {
    color: '#0F0F14',
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 1,
  },
});
