/**
 * Night step model. Steps used to run sequentially (NIGHT_STEPS in order),
 * but the engine now runs many of them in parallel: each step has a
 * declarative *gate* that must be satisfied before its picker activates.
 *
 * NIGHT_STEPS is still the canonical list — used for:
 *   - resolution ordering at dawn (BG → witch save → lep move → wolf kill → …)
 *   - ghost-log render order (spectators read steps top-to-bottom)
 *
 * Gates determine activation order:
 *   none           — activate at night start
 *   wolves         — activate when 'wolves' has completed
 *   nightmare_wolf — activate when 'nightmare_wolf' has completed
 *   all_others     — activate when every other in-game step has completed
 *                    (used by reveal-only end-of-night steps)
 *
 * The gate for the info / picker roles (seer, pi, mentalist, bg, huntress,
 * revealer, reviler) is dynamic: if Nightmare Wolf is in the game, they
 * gate on `nightmare_wolf`; if not, they're free (`none`) and race wolves
 * to fully parallelize the night.
 */
export const NIGHT_STEPS = [
  // Reveals deferred Doppelganger conversions (target died in the prior
  // day/morning phase). Reveal-only, no actor — activates immediately so
  // a wolf-converted Doppelganger sees their reveal at the start of the
  // night they wake with the pack.
  'doppelganger_dawn',
  'wolves',
  'nightmare_wolf',
  // Warlock decides independently of the wolves' pick — listed near the
  // wolves so ghost-log readers see the cancel-and-replace alongside the
  // kill it overrides. Resolution at dawn applies warlock cancel first,
  // then leprechaun, then everything else keys off the effective target.
  'warlock',
  // The Chupacabra hunts independently of the wolves' pick (picks blind,
  // like the Warlock) — listed near the wolves so ghost-log readers see its
  // kill alongside theirs. Lethal only against a wolf while any wolf lives;
  // once the pack is gone, lethal against anyone.
  'chupacabra',
  'seer',
  'pi',
  'mentalist',
  'witch',
  'leprechaun',
  'bodyguard',
  'huntress',
  'revealer',
  'reviler',
  'cursed_conversion',
  // Alpha Wolf conversion. On a conversion night the wolves' first pick is a
  // CONVERT, not a kill; this end-of-night step evaluates whether it lands
  // (not Bodyguard-protected, not Warlock-cancelled, target survives other
  // sources) and shows the converted player their private "you are a wolf"
  // reveal. Mirrors cursed_conversion's last-step timing. No-op on normal
  // nights (dwell 0). Runs after cursed_conversion so a Cursed convert-target
  // is handled by the Cursed path and skipped here.
  'alpha_conversion',
  // Reveals same-night Doppelganger conversions (target dies tonight).
  // Runs last, mirroring Cursed's end-of-night reveal timing.
  'doppelganger_dusk',
] as const;
export type NightStep = (typeof NIGHT_STEPS)[number];

export function isNightStep(s: string | undefined): s is NightStep {
  return s !== undefined && (NIGHT_STEPS as readonly string[]).includes(s);
}

export function nightStepLabel(step: NightStep): string {
  switch (step) {
    case 'wolves':
      return 'The wolves are awake';
    case 'nightmare_wolf':
      return 'The nightmare wolf stalks alone';
    case 'seer':
      return 'The seer is awake';
    case 'pi':
      return 'The PI is awake';
    case 'mentalist':
      return 'The mentalist is awake';
    case 'witch':
      return 'The witch is awake';
    case 'leprechaun':
      return 'The leprechaun is awake';
    case 'warlock':
      return 'The warlock is awake';
    case 'chupacabra':
      return 'The chupacabra hunts';
    case 'bodyguard':
      return 'The bodyguard is awake';
    case 'huntress':
      return 'The huntress is awake';
    case 'revealer':
      return 'The revealer is awake';
    case 'reviler':
      return 'The reviler is awake';
    case 'cursed_conversion':
    case 'alpha_conversion':
    case 'doppelganger_dawn':
    case 'doppelganger_dusk':
      // Deliberately neutral so the wake-order header doesn't telegraph that
      // a conversion might be in progress. Actual conversion events appear
      // in the ghost log when they fire.
      return 'The village awaits dawn';
  }
}

// ───── Gate model ───────────────────────────────────────────────────────────

export type GateKind = 'none' | 'wolves' | 'nightmare_wolf' | 'all_others';

/**
 * Returns the gate for `step` given whether Nightmare Wolf is in the role
 * list. Pure helper — no DB lookups, no role-presence checks beyond NW.
 *
 *   - wolves / doppelganger_dawn         : 'none'  (race from t=0)
 *   - nightmare_wolf                     : 'wolves' (reads wolves' work and
 *                                          is the gate for everyone else)
 *   - witch / leprechaun                 : 'nightmare_wolf' if NW present
 *                                          (NW could put them to sleep),
 *                                          else 'wolves' (need wolf target)
 *   - info + picker roles                : 'nightmare_wolf' if NW present
 *                                          (same: NW could silence them),
 *                                          else 'none' (race wolves)
 *   - cursed_conversion / doppelganger_dusk : 'all_others' (run last —
 *                                          predict victims, fire reveals)
 *
 * Rule of thumb: with NW in the game, every non-wolves picker waits until
 * NW has locked in its silence; without NW, only roles that need wolves'
 * kill target (witch + lep) wait on wolves, and the rest race.
 */
export function gateFor(step: NightStep, hasNightmareWolf: boolean): GateKind {
  switch (step) {
    case 'doppelganger_dawn':
    case 'wolves':
      return 'none';
    case 'nightmare_wolf':
      return 'wolves';
    case 'witch':
    case 'leprechaun':
      return hasNightmareWolf ? 'nightmare_wolf' : 'wolves';
    case 'warlock':
    case 'chupacabra':
    case 'seer':
    case 'pi':
    case 'mentalist':
    case 'bodyguard':
    case 'huntress':
    case 'revealer':
    case 'reviler':
      return hasNightmareWolf ? 'nightmare_wolf' : 'none';
    case 'cursed_conversion':
    case 'alpha_conversion':
    case 'doppelganger_dusk':
      return 'all_others';
  }
}

/**
 * True when `step`'s gate is satisfied — i.e., the step is now eligible to
 * activate. Caller passes the set of already-completed steps; "in-game"
 * filtering is the caller's responsibility (a step whose role isn't in the
 * game is treated as pre-completed for gate purposes).
 *
 * `inGameSteps` is the subset of NIGHT_STEPS whose role(s) are actually in
 * the role list — used by the 'all_others' gate to know what "everything
 * else" means tonight.
 */
export function gateSatisfied(
  step: NightStep,
  hasNightmareWolf: boolean,
  completedSteps: ReadonlySet<NightStep>,
  inGameSteps: ReadonlySet<NightStep>,
): boolean {
  const gate = gateFor(step, hasNightmareWolf);
  switch (gate) {
    case 'none':
      return true;
    case 'wolves':
      // If wolves aren't in the game at all (degenerate), treat as satisfied.
      return !inGameSteps.has('wolves') || completedSteps.has('wolves');
    case 'nightmare_wolf':
      return (
        !inGameSteps.has('nightmare_wolf') ||
        completedSteps.has('nightmare_wolf')
      );
    case 'all_others': {
      for (const s of inGameSteps) {
        if (s === step) continue;
        // 'all_others' steps wait on each other too — but since they share
        // the same gate, they activate together once every non-all_others
        // step is done. Don't require completion of other all_others steps.
        if (gateFor(s, hasNightmareWolf) === 'all_others') continue;
        if (!completedSteps.has(s)) return false;
      }
      return true;
    }
  }
}
