/**
 * Short paraphrased role descriptions. Kept intentionally brief to fit a
 * small description panel in <RoleCard>. Phrased in our own voice — not
 * lifted from any published rulebook.
 *
 * Keyed by the canonical role name (matches entries in `roles.ts`).
 */
export const ROLE_DESCRIPTIONS: Record<string, string> = {
  // ── Villagers ─────────────────────────────────────────────────────────────
  'Villager': 'Ordinary townsfolk. Just a vote and a voice.',
  'Seer': 'Each night, learns whether a chosen player is a wolf.',
  'Witch': 'Sees the wolves’ victim each night. One save and one poison — used once each.',
  'Bodyguard': 'Each night, protects one player from all death. Self-protect once per game.',
  'Hunter': 'On death, may shoot one player down alongside them.',
  'Huntress': 'A single one-time night shot at any player.',
  'Mentalist': 'Each night, learns whether two chosen players are on the same team.',
  'Paranormal Investigator': 'Once per game, learns whether a target or their neighbors include a wolf.',
  'Tough Guy': 'Survives the first wolf attack. Dies publicly the next morning.',
  'Diseased': 'If killed by wolves, the pack gets no kill the following night.',
  'Revealer': 'Each night, may shoot a target. Kills wolves — dies otherwise.',
  'Mad Bomber': 'On death, detonates and takes the players to their left and right.',

  // ── Wolves ────────────────────────────────────────────────────────────────
  'Werewolf': 'Wakes with the pack each night to choose a victim.',
  'Wolf Man': 'Wakes with the wolves. Reads as a villager to the Seer.',
  'Hunter Wolf': 'Wakes with the wolves. On death, may shoot a player down with them.',
  'Wolf Cub': 'Wakes with the wolves. If killed, the surviving wolves get two kills next night.',

  // ── Team Wolf ─────────────────────────────────────────────────────────────
  'Minion': 'Knows who the wolves are. Wins with them — but isn’t one.',
  'Reviler': 'Wakes alone each night. Hunts special villagers — dies if they miss.',
};

export function getRoleDescription(roleName: string): string {
  return ROLE_DESCRIPTIONS[roleName] ?? '';
}
