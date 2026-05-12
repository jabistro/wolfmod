/**
 * Night-step sequence the engine walks each night, in order. Steps that have
 * no eligible actors in the current game are auto-skipped.
 *
 * Phase 3a only implements 'wolves' and 'seer'; later phases extend this list
 * as more roles come online.
 */
export const NIGHT_STEPS = [
  'wolves',
  'seer',
  'pi',
  'mentalist',
  'witch',
  'bodyguard',
  'huntress',
  'revealer',
  'reviler',
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
    case 'seer':
      return 'The seer is awake';
    case 'pi':
      return 'The PI is awake';
    case 'mentalist':
      return 'The mentalist is awake';
    case 'witch':
      return 'The witch is awake';
    case 'bodyguard':
      return 'The bodyguard is awake';
    case 'huntress':
      return 'The huntress is awake';
    case 'revealer':
      return 'The revealer is awake';
    case 'reviler':
      return 'The reviler is awake';
  }
}
