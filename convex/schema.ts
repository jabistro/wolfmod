import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

export default defineSchema({
  games: defineTable({
    roomCode: v.string(),
    playerCount: v.number(),
    phase: v.union(
      v.literal('lobby'),
      v.literal('reveal'),
      v.literal('night'),
      v.literal('triggers'),
      v.literal('morning'),
      v.literal('day'),
      v.literal('ended'),
    ),
    nightNumber: v.number(),
    dayNumber: v.number(),
    nightStep: v.optional(v.string()),
    /**
     * Wall-clock deadline (ms) for the current night step. Each step holds at
     * least until this passes, even if the action is recorded earlier. This
     * cloaks "actor is dead" (instant skip) vs "actor is deciding" (variable
     * time) — they look the same to other players.
     */
    nightStepEndsAt: v.optional(v.number()),
    selectedRoles: v.array(v.string()),
    winner: v.optional(v.union(v.literal('village'), v.literal('wolf'))),
    createdAt: v.number(),
    endedAt: v.optional(v.number()),

    // Day-phase configuration. All optional — see defaults in helpers.ts.
    // voteTimerSec is the per-vote countdown (default 5).
    voteTimerSec: v.optional(v.number()),
    dayDurationSec: v.optional(v.number()),
    accusationSec: v.optional(v.number()),
    defenseSec: v.optional(v.number()),
    maxNominationsPerDay: v.optional(v.number()),
    /**
     * Wall-clock deadline (ms) for the day clock. Set when the day begins
     * (host taps BEGIN DAY from reveal screen, or BEGIN DAY N from morning).
     * When `now > dayEndsAt`, no new nominations can be started; host can
     * still tap BEGIN NIGHT when the table is ready.
     */
    dayEndsAt: v.optional(v.number()),
    /**
     * When set, the day clock is paused — this value is the frozen
     * remainingMs. Cleared on resume; `dayEndsAt = now + remainingMs`.
     * Always set when a nomination is in flight (day clock pauses during
     * trials).
     */
    dayPausedRemainingMs: v.optional(v.number()),
    /**
     * Active nomination state, if any. Walks through accusation → defense →
     * vote → results. Only the vote sub-phase auto-advances on timer
     * expire (schedules tallyVote). Accusation/defense advance on host
     * action (END ACCUSATION / END DEFENSE). After CONTINUE GAME, the
     * nomination is cleared and the day clock resumes.
     */
    currentNomination: v.optional(
      v.object({
        nominatedPlayerId: v.id('players'),
        nominationIndex: v.number(),
        subPhase: v.union(
          v.literal('accusation'),
          v.literal('defense'),
          v.literal('vote'),
          v.literal('results'),
        ),
        /**
         * Wall-clock deadline (ms) for the current sub-phase. While paused,
         * this is meaningless — display uses subPhasePausedRemainingMs.
         */
        subPhaseEndsAt: v.number(),
        /**
         * When set, the sub-phase clock is paused. Initial state on a fresh
         * nomination has this set to the full accusation duration so the
         * host can START the timer when ready.
         */
        subPhasePausedRemainingMs: v.optional(v.number()),
        resultsRevealed: v.boolean(),
      }),
    ),
    nominationsThisDay: v.optional(v.number()),

    /**
     * Carryover from a Diseased death. Flipped on at the morning resolution
     * where a Diseased player actually died from wolf attack; read at the
     * following night's wolves step to insert a `wolf_blocked` action in
     * place of `wolf_kill`. Cleared at the start of the next morning
     * resolution so the cycle resets each night.
     */
    wolvesBlockedNextNight: v.optional(v.boolean()),

    /**
     * Carryover from a Wolf Cub death. Flipped on whenever a Wolf Cub
     * player dies (any cause — wolf can't kill teammate, but lynch, witch
     * poison, hunter shot, MB cascade, etc. all qualify). Read at the
     * following night's wolves step: while set, `requiredKills` is 2
     * instead of 1. Diseased block takes priority — if both flags are
     * set, the night is blocked and the vengeance is wasted. Cleared at
     * the start of the next morning resolution.
     */
    wolfCubVengeance: v.optional(v.boolean()),

    /**
     * Lifetime set of players the Leprechaun has previously moved a wolf
     * kill OFF of. Each entry is one-and-done — the Leprechaun cannot
     * redirect a kill targeting that same player again later in the game.
     * Includes the Leprechaun themselves if they ever moved a kill off
     * themselves. Grows across nights; never cleared.
     */
    leprechaunMovedOff: v.optional(v.array(v.id('players'))),

    /**
     * Death-trigger queue. Populated when Hunter / Hunter Wolf dies
     * (overnight or via lynch); each entry gets a 10 s dwell so the
     * actor can decide whom to shoot. Mad Bomber is NOT queued — its
     * detonation is automatic at the moment of death and writes its
     * own `mad_bomber_kill` action row inline. `visibility` is retained
     * as optional for legacy records (older runs may still have it set).
     */
    pendingDeathTriggers: v.optional(
      v.array(
        v.object({
          playerId: v.id('players'),
          role: v.union(
            v.literal('Hunter'),
            v.literal('Hunter Wolf'),
          ),
          visibility: v.optional(
            v.union(v.literal('public'), v.literal('silent')),
          ),
        }),
      ),
    ),
    /**
     * Where the engine returns to after `pendingDeathTriggers` empties.
     * Set when entering the 'triggers' phase.
     */
    triggersFollowUp: v.optional(
      v.union(
        v.literal('morning'),
        v.literal('day'),
        v.literal('night'),
      ),
    ),
    /**
     * Wall-clock deadline (ms) for the current trigger head's decision. On
     * timeout, an internal mutation auto-defaults Hunter/HW → skip. The
     * dwell is also enforced as a minimum so quick decisions don't leak
     * "actor decided fast".
     */
    triggerEndsAt: v.optional(v.number()),
    /**
     * Wall-clock lock on the CONTINUE button after a vote is revealed.
     * Set in tallyVote regardless of whether anyone was lynched. Cloaks
     * whether a trigger role died — the host can't tell from button
     * timing.
     */
    voteDwellEndsAt: v.optional(v.number()),

    /**
     * Public message shown to ALL phones for ~4 s after a Hunter/HW shot.
     * Cloaks the role — Hunter shots are phrased "X HAS SHOT Y" for both
     * Hunter and Hunter Wolf. Queue processing pauses for this window so
     * the village can read the result before the next trigger fires.
     * Cleared by `announcementTick`. Mad Bomber detonations are NOT
     * announced through this field — they fold silently into the morning
     * death list or the lynch result panel, since MB's role stays hidden.
     */
    triggerAnnouncement: v.optional(
      v.object({
        lines: v.array(v.string()),
        endsAt: v.number(),
      }),
    ),
  }).index('by_room_code', ['roomCode']),

  players: defineTable({
    gameId: v.id('games'),
    name: v.string(),
    seatPosition: v.optional(v.number()),
    role: v.optional(v.string()),
    /**
     * Set once at deal time and never mutated. Lets end-game show a
     * converted Cursed as "Cursed → Werewolf" alongside their current
     * (post-conversion) role. Used for the same purpose with Doppelganger.
     */
    originalRole: v.optional(v.string()),
    /**
     * Set by the Doppelganger at first-night seat selection — the player
     * whose role they'll inherit on elimination. Cleared after the
     * conversion fires (or stays set forever if Doppelganger dies first).
     */
    doppelgangerTarget: v.optional(v.id('players')),
    alive: v.boolean(),
    isHost: v.boolean(),
    deviceClientId: v.string(),
    joinedAt: v.number(),
    revealedAt: v.optional(v.number()),
    pendingDeath: v.optional(v.boolean()),
    roleState: v.optional(v.any()),
  })
    .index('by_game', ['gameId'])
    .index('by_device', ['deviceClientId'])
    .index('by_game_device', ['gameId', 'deviceClientId']),

  /**
   * Append-only log of every night/day action. Powers spectator view, the
   * morning death-resolution math, and post-game history. We never delete
   * rows here; resolution writes new entries (e.g. 'death' rows alongside
   * the 'wolf_kill' that caused them).
   */
  nightActions: defineTable({
    gameId: v.id('games'),
    nightNumber: v.number(),
    actorPlayerId: v.optional(v.id('players')),
    actionType: v.string(),
    targetPlayerId: v.optional(v.id('players')),
    result: v.optional(v.any()),
    resolvedAt: v.number(),
  }).index('by_game_night', ['gameId', 'nightNumber']),

  /**
   * One row per voter per nomination. We keep history (don't overwrite)
   * across the game so spectators can review who voted what across the
   * whole day. nominationIndex disambiguates multiple nominations in a
   * single day.
   */
  nominationVotes: defineTable({
    gameId: v.id('games'),
    dayNumber: v.number(),
    nominationIndex: v.number(),
    voterPlayerId: v.id('players'),
    vote: v.union(v.literal('lives'), v.literal('dies')),
    votedAt: v.number(),
  }).index('by_game_nomination', ['gameId', 'dayNumber', 'nominationIndex']),
});
