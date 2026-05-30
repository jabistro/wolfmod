/**
 * Night-step sequence the engine walks each night, in order. Steps that have
 * no eligible actors in the current game are auto-skipped.
 *
 * Phase 3a only implements 'wolves' and 'seer'; later phases extend this list
 * as more roles come online.
 */
export const NIGHT_STEPS = [
  // Reveals deferred Doppelganger conversions (target died in the prior
  // day/morning phase). Runs first so a wolf-converted Doppelganger wakes
  // with the pack this same night.
  'doppelganger_dawn',
  'wolves',
  'nightmare_wolf',
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
  // Reveals same-night Doppelganger conversions (target dies tonight).
  // Runs last, mirroring Cursed's end-of-night reveal timing.
  'doppelganger_dusk',
] as const;
export type NightStep = (typeof NIGHT_STEPS)[number];

export function isNightStep(s: string | undefined): s is NightStep {
  return s !== undefined && (NIGHT_STEPS as readonly string[]).includes(s);
}

export function nextNightStep(current: NightStep | undefined): NightStep | null {
  if (current === undefined) return NIGHT_STEPS[0] ?? null;
  const idx = NIGHT_STEPS.indexOf(current);
  if (idx < 0 || idx >= NIGHT_STEPS.length - 1) return null;
  return NIGHT_STEPS[idx + 1];
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
    case 'bodyguard':
      return 'The bodyguard is awake';
    case 'huntress':
      return 'The huntress is awake';
    case 'revealer':
      return 'The revealer is awake';
    case 'reviler':
      return 'The reviler is awake';
    case 'cursed_conversion':
      return 'The cursed stirs in the night';
    case 'doppelganger_dawn':
    case 'doppelganger_dusk':
      return 'The doppelganger wears a new face';
  }
}
