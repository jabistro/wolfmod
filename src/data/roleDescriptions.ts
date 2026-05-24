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
  'Priest': 'Once per game, blesses a player. The blessed survives the first kill aimed at them.',
  'Aura Seer': 'Each night, learns whether a chosen player carries any special role.',
  'Martyr': 'Once per game, may take a day-vote elimination in another player\'s place.',
  'Professor Impatience': 'On death, day votes and night kills both double for the rest of the game.',
  'Prince': 'Survives the first lynch vote — reveals as Prince and stays in the game.',
  'Cutthroat': 'Once per game, may quietly eliminate one of their two neighbors.',
  'Gladys': 'After a neighbor dies, learns whether the new neighbors have any active night role.',
  'Magistrate': 'Once per game, may flip a single vote — including the one to eliminate them.',
  'Wise Old Man': 'Night one, learns every special villager. Dies after day two; if attacked, the Seer sees twice.',
  'Mason': 'Wakes on the first night to identify the other Masons.',
  'Soothsayer': 'First night only, picks two players and learns whether they share a team.',
  'Elusive Seer': 'First night, learns the identity of every plain Villager.',
  'Oracle': 'Once per game, learns the exact role of a chosen player.',
  'Mortician': 'Each night, may strike a player. The power keeps until they finally hit a wolf.',
  'Apprentice Exposer': 'Once per game, exposes a target\'s role the next morning — unless they\'re a wolf.',
  'Assassin': 'Once per day, may quietly eliminate one of their two neighbors.',
  'The Thing': 'Each night, may tap a neighbor as a silent signal.',
  'Troublemaker': 'Once per game, may call for two players to be lynched the following day.',
  'Reactive Seer': 'Each night that follows a village-team day elimination, may hunt for a wolf.',
  'Mystic Seer': 'Each night, learns the exact role of a chosen player.',
  'Gemini': 'Wakes on the first night to identify the other Gemini.',
  'Warlock': 'Once per game, may cancel a night kill and aim it at a different player instead.',
  'Exposer': 'Wakes every night. Once per game, may pick a player to be publicly outed by morning.',
  'Insomniac': 'Each night, learns whether at least one of their neighbors performed a night action.',
  'Tough Girl': 'Survives the first wolf attack until the next night. If only she and one wolf remain, village wins.',
  'Leprechaun': 'Each night, may shove the wolves\' kill to a player adjacent to their original target.',
  'Village Idiot': 'Their vote always lands on elimination — never on the no-lynch.',
  'Robber': 'Night one, swipes another player\'s card and assumes their role.',
  'Old Woman': 'Each night, sends one player away — they miss the next day entirely.',
  'Old Man': 'Dies on his own on a fated night, timed to the number of wolves in play.',
  'Sheepdog': 'If the day clock runs out with no vote, automatically votes for elimination.',
  'Virginia Woolf': 'Night one, picks a player who fears her. If she dies, they die with her.',
  'Pacifist': 'Always votes against any elimination — never for the lynch.',
  'Cupid': 'On night one, links two players. They live and die together — if one falls, so does the other.',
  'Innocent': 'On death, triggers a public hunt — the village keeps lynching until they catch a wolf-team player.',
  'The Mummy': 'Each night, hypnotizes a fresh target. Their daytime vote mirrors the Mummy\'s.',
  'Ghost': 'Dies on night one. From the grave, sends a single-letter message to the living each day.',
  'Mayor': 'Their vote carries the weight of two.',
  'Empath': 'Each night, senses whether the Seer sits beside a wolf.',
  'Beholder': 'On night one, recognizes the Seer in the room.',
  'Influencer': 'While alive, casts an extra vote for the lynch. After death, an extra vote against it.',
  'Infected': 'Village can\'t win unless this player is eliminated. If wolves take her, they skip their next kill.',
  'One-Eyed Seer': 'Each night, checks one player for wolf status. Once a wolf is found, locked on them until that wolf dies.',
  'Apprentice Seer': 'Inherits the Seer\'s powers when the Seer dies — checks one player per night from then on.',
  'Magician': 'Each night, may wield a different special power.',
  'The Count': 'Night one, learns the wolf count to either side of him.',
  'Eye of the Seer': 'On death, blinds the Seer — every future check returns "villager".',
  'Outcast': 'On death, every village night ability sits idle the following night.',
  'Necromancer': 'Each night, pairs two players. If one falls that same night, the bond drags the other down too.',
  'Spellcaster': 'Each night, gags one player — no voice, no nomination, no vote come morning.',
  'Lycan': 'Loyal to the village, but the Seer\'s vision misreads them as a wolf.',

  // ── Wolves ────────────────────────────────────────────────────────────────
  'Werewolf': 'Wakes with the pack each night to choose a victim.',
  'Wolf Man': 'Wakes with the wolves. Reads as a villager to the Seer.',
  'Hunter Wolf': 'Wakes with the wolves. On death, may shoot a player down with them.',
  'Wolf Cub': 'Wakes with the wolves. If killed, the surviving wolves get two kills next night.',
  'Exploding Wolf': 'Wakes with the pack. When this wolf dies, both adjacent players go down in the blast.',
  'Kamikaze Wolf': 'Wakes with the pack. Booby-trapped — if the Seer checks them while other wolves still live, both die.',
  'Alpha Wolf': 'Wakes with the pack. The night after a wolf is lynched, may convert that night\'s target into a new wolf instead of killing.',
  'Oracle Wolf': 'Wakes with the pack. Every wolf death triggers a return to the night, granting one role-read on any player.',
  'Assassin Wolf': 'Wakes with the pack. Lashes out on death — may take a neighbor down too.',
  'Dreamwolf': 'A dormant wolf — stays asleep until a wolf falls or the pack tries to claim them.',
  'Mystic Wolf': 'Wakes with the pack, then wakes alone to learn one player\'s role — a wolf-side Seer.',
  // TODO: verify Bezier variant
  'Big Bad Wolf': 'Wakes with the pack. As the last wolf standing, hits even harder — a second kill each night.',
  // TODO: verify Bezier variant
  'Teenage Werewolf': 'A young wolf still finding its teeth — does not act on the first night.',

  // ── Team Wolf ─────────────────────────────────────────────────────────────
  'Minion': 'Knows who the wolves are. Wins with them — but isn’t one.',
  'Reviler': 'Wakes alone each night. Hunts special villagers — dies if they miss.',
  'Spy': 'Wolf-team. On the first night, sees who the wolves are without becoming one.',
  'Sorceress': 'Wolf-team. Each night, may check whether a chosen player is the Seer.',

  // ── Solo ──────────────────────────────────────────────────────────────────
  'Cursed': 'Starts on the village team. If wolves attack, joins the pack instead of dying.',
  'Doppelgänger': 'On night one, copies another player\'s role and joins their team.',
  'Tanner': 'Wins solo only if voted out by the village during the day.',
  'Cult Leader': 'Each night, recruits a player into the cult. Wins when the cult outnumbers the village.',
  // TODO: verify Bezier variant
  'Sasquatch': 'Village team — but hunts alone each night, killing one player just like the wolves.',
  // TODO: verify Bezier variant
  'Drunk': 'Holds a hidden role unknown even to themselves until the game brings it out.',
};

export function getRoleDescription(roleName: string): string {
  return ROLE_DESCRIPTIONS[roleName] ?? '';
}
