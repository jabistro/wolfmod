/**
 * Roles supported by the v1 multi-device moderator.
 * Order here is reference only — actual role assignment is randomized at game start.
 *
 * Names match entries in `src/data/roles.ts` so the existing role catalog
 * (images, values, etc.) is reused.
 */
export const V1_ROLES = [
  // Village
  'Villager',
  'Seer',
  'Witch',
  'Bodyguard',
  'Hunter',
  'Huntress',
  'Mentalist',
  'Paranormal Investigator',
  'Tough Guy',
  'Diseased',
  'Revealer',
  'Mad Destroyer',
  // Wolf
  'Werewolf',
  'Wolf Man',
  'Hunter Wolf',
  // Solo / wolf-aligned
  'Minion',
  'Reviler',
] as const;

export type V1Role = (typeof V1_ROLES)[number];

export function isV1Role(name: string): name is V1Role {
  return (V1_ROLES as readonly string[]).includes(name);
}

/**
 * Roles that wake with the wolves at night and see each other (with their
 * specific roles) during the role-reveal setup. v2 will add Alpha Wolf and
 * Wolf Cub here. The Minion knows who's on this list but is not on it.
 */
export const WOLF_TEAM_ROLES = ['Werewolf', 'Wolf Man', 'Hunter Wolf'] as const;

export function isWolfTeam(role: string): boolean {
  return (WOLF_TEAM_ROLES as readonly string[]).includes(role);
}

export const TEAM_VILLAGE = 'village' as const;
export const TEAM_WOLF = 'wolf' as const;
export const TEAM_SOLO = 'solo' as const;
export type Team = typeof TEAM_VILLAGE | typeof TEAM_WOLF | typeof TEAM_SOLO;

const VILLAGE_ROLES = new Set<string>([
  'Villager',
  'Seer',
  'Witch',
  'Bodyguard',
  'Hunter',
  'Huntress',
  'Mentalist',
  'Paranormal Investigator',
  'Tough Guy',
  'Diseased',
  'Revealer',
  'Mad Destroyer',
]);
const SOLO_ROLES = new Set<string>(['Reviler']);

export function teamForRole(role: string): Team {
  if (isWolfTeam(role) || role === 'Minion') return TEAM_WOLF;
  if (SOLO_ROLES.has(role)) return TEAM_SOLO;
  if (VILLAGE_ROLES.has(role)) return TEAM_VILLAGE;
  return TEAM_VILLAGE;
}

/**
 * Roles the Seer reads as 'villager' even though they're on the wolf team.
 */
const SEER_BLIND_ROLES = new Set<string>(['Wolf Man']);

export function seerSees(targetRole: string): 'wolf' | 'villager' {
  if (SEER_BLIND_ROLES.has(targetRole)) return 'villager';
  return isWolfTeam(targetRole) ? 'wolf' : 'villager';
}
