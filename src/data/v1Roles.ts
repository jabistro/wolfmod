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
  'Mad Bomber',
  'Leprechaun',
  'Warlock',
  'Lycan',
  'Mason',
  // Wolf
  'Werewolf',
  'Wolf Man',
  'Hunter Wolf',
  'Wolf Cub',
  'Nightmare Wolf',
  'Mama Wolf',
  'Alpha Wolf',
  // Solo / wolf-aligned
  'Minion',
  'Reviler',
  // Solo / convertible
  'Cursed',
  'Doppelganger',
  'Sasquatch',
  // Solo / third-party win condition
  'Chupacabra',
] as const;

export type V1Role = (typeof V1_ROLES)[number];

export function isV1Role(name: string): name is V1Role {
  return (V1_ROLES as readonly string[]).includes(name);
}

/**
 * Roles that wake with the wolves at night and see each other (with their
 * specific roles) during the role-reveal setup. The Minion knows who's on
 * this list but is not on it.
 */
export const WOLF_TEAM_ROLES = [
  'Werewolf',
  'Wolf Man',
  'Hunter Wolf',
  'Wolf Cub',
  'Nightmare Wolf',
  'Mama Wolf',
  'Alpha Wolf',
] as const;

export function isWolfTeam(role: string): boolean {
  return (WOLF_TEAM_ROLES as readonly string[]).includes(role);
}

/**
 * Roles that may only appear once in a build. Multiple Leprechauns would
 * create a "whose redirect fires first?" ambiguity; multiple Doppelgangers
 * would leak each other's identities at first-night seat selection.
 */
export const SINGLETON_ROLES = [
  'Leprechaun',
  'Doppelganger',
  // The Chupacabra is a unique solo win condition — two would create
  // competing "I win alone" states with no defined resolution.
  'Chupacabra',
] as const;
export function isSingletonRole(name: string): boolean {
  return (SINGLETON_ROLES as readonly string[]).includes(name);
}

/**
 * Role pairs that may NOT appear in the same build, with the why. The
 * Alpha Wolf's once-per-game conversion replaces a kill, so the morning
 * reads "no one died" — the village (and the Alpha) only learn whether it
 * landed when the target does or doesn't wake with the pack next night. The
 * Witch and the Leprechaun are the only roles shown the wolves' target at
 * night; on a conversion night they'd see who was converted (and could
 * trivially deduce the new wolf when no death follows), which breaks the
 * mystery the conversion depends on. So they're hard-excluded from any build
 * with an Alpha Wolf. The map is symmetric — look up either side.
 */
export const INCOMPATIBLE_ROLES: Record<string, readonly string[]> = {
  'Alpha Wolf': ['Witch', 'Leprechaun'],
  Witch: ['Alpha Wolf'],
  Leprechaun: ['Alpha Wolf'],
};

/**
 * Given a role and the set of role names already in the build, returns the
 * names of any in-build roles that conflict with it. Empty = no conflict.
 */
export function incompatibleRolesInBuild(
  role: string,
  presentRoles: ReadonlySet<string>,
): string[] {
  const conflicts = INCOMPATIBLE_ROLES[role];
  if (!conflicts) return [];
  return conflicts.filter(r => presentRoles.has(r));
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
  'Mad Bomber',
  'Leprechaun',
  'Warlock',
  'Lycan',
  'Mason',
]);
// The Chupacabra is the first TEAM_SOLO role — it wins alone (eliminate every
// wolf, then reach parity). The Mentalist reads it as a different team from
// both the village and the wolves. Reviler and Minion both win with the
// wolves and are wolf-team for grouping (Mentalist reads them as same-team
// as actual wolves). For parity, though, they count as non-wolf bodies the
// wolves must still clear (see `checkWinCondition`) — they win alongside the
// wolves but only an actual wolf advances parity.
// TEAM_SOLO also stays open for future v2 roles (Tanner, Cult Leader, etc.).

export function teamForRole(role: string): Team {
  if (role === 'Chupacabra') return TEAM_SOLO;
  if (isWolfTeam(role) || role === 'Minion' || role === 'Reviler') return TEAM_WOLF;
  if (VILLAGE_ROLES.has(role)) return TEAM_VILLAGE;
  return TEAM_VILLAGE;
}

/**
 * Roles the Seer reads as 'villager' even though they're on the wolf team.
 */
const SEER_BLIND_ROLES = new Set<string>(['Wolf Man']);

/**
 * Village-team roles the Seer misreads as 'wolf'. The Lycan is loyal to and
 * wins with the village (and reads correctly to every other role — Mentalist,
 * PI, etc.), but the Seer's vision flags them as a wolf.
 */
const SEER_WOLF_APPEARING_ROLES = new Set<string>(['Lycan']);

export function seerSees(targetRole: string): 'wolf' | 'villager' {
  if (SEER_BLIND_ROLES.has(targetRole)) return 'villager';
  if (SEER_WOLF_APPEARING_ROLES.has(targetRole)) return 'wolf';
  return isWolfTeam(targetRole) ? 'wolf' : 'villager';
}
