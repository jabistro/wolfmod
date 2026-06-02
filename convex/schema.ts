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
    /**
     * Legacy single-step pointer (sequential engine). Engine no longer
     * writes these — `nightActiveSteps` + `nightCompletedSteps` are the
     * authoritative state. Kept optional so any docs from older deploys
     * still validate.
     */
    nightStep: v.optional(v.string()),
    nightStepEndsAt: v.optional(v.number()),

    /**
     * Currently-active night steps. Multiple steps can be active in parallel
     * once their gates are satisfied (see src/data/nightOrder.ts → gateFor).
     * Each entry carries its own dwell deadline so an actor's reading window
     * is per-step, not global. Cleared on transition to morning.
     */
    nightActiveSteps: v.optional(
      v.array(
        v.object({
          step: v.string(),
          endsAt: v.number(),
        }),
      ),
    ),
    /**
     * Steps that have already completed this night (action(s) recorded +
     * dwell elapsed). Drives gate evaluation for newly-activatable steps.
     * Cleared on transition to morning.
     */
    nightCompletedSteps: v.optional(v.array(v.string())),
    /**
     * Minimum wall-clock deadline before the night can transition to morning,
     * even if every active step finishes earlier. Cloaks games where most
     * roles are dead/spent — without this floor, fast-resolving nights would
     * tell observers that the table is thinned out. Cleared at morning.
     */
    nightFloorEndsAt: v.optional(v.number()),
    selectedRoles: v.array(v.string()),
    /**
     * Dev-only: pre-game seat→role pins. Set via the lobby's ASSIGN ROLES
     * (DEV) modal (gated by __DEV__ / EXPO_PUBLIC_ALLOW_BOTS). startGame
     * honors these first, then shuffles whatever remains in `selectedRoles`
     * into the unpinned seats. Cleared implicitly when the game leaves the
     * lobby; pruned by `setRoles` if the build no longer covers the pins.
     */
    devRoleAssignments: v.optional(
      v.array(
        v.object({
          seatPosition: v.number(),
          role: v.string(),
        }),
      ),
    ),
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
        /**
         * The player whose tap first highlighted this seat (earliest tap
         * still standing at the moment the trial fired). Surfaced in the
         * accusation banner so the village knows who pushed the trial.
         * Optional because legacy in-flight rows from older deploys may
         * have been written before this field existed.
         */
        accuserPlayerId: v.optional(v.id('players')),
        /**
         * The player whose second tap on the same target tipped it into a
         * trial. Surfaced alongside the accuser. Optional for the same
         * legacy reason as accuserPlayerId.
         */
        seconderPlayerId: v.optional(v.id('players')),
      }),
    ),
    nominationsThisDay: v.optional(v.number()),

    /**
     * Confirmation dwell between "the 2nd tap landed" and "the trial
     * screen takes over". While set, all clients stay on the discussion
     * screen with the target seat playing a white-fill animation + a
     * banner showing accuser/seconder names — gives the table a moment
     * to register who got put on the stand instead of jarring straight
     * into the accusation timer. An internal `finalizePendingTrial` is
     * scheduled for `dwellEndsAt`; when it fires it patches
     * `currentNomination` (the real trial state) and clears this field.
     * The day clock is paused the moment this is set, so the dwell
     * doesn't burn day time. On host force-nominate, the host is
     * stamped as both accuser and seconder.
     */
    pendingTrial: v.optional(
      v.object({
        targetPlayerId: v.id('players'),
        accuserPlayerId: v.id('players'),
        seconderPlayerId: v.optional(v.id('players')),
        dwellEndsAt: v.number(),
      }),
    ),

    /**
     * Confirmation dwell between "the wolves' kill is locked in" and "the
     * wolf_kill row gets written". While set, the picker is locked and the
     * target seat plays a red-fill animation so all wolves (and ghosts)
     * register the chosen victim before the step rolls on. An internal
     * `finalizePendingWolfKill` is scheduled for `dwellEndsAt`; when it
     * fires it inserts the `wolf_kill` row, clears this field, and either
     * resets the wolves' votes (Wolf Cub vengeance kill #1) or force-
     * advances the wolves step (final kill).
     *
     * `kind` distinguishes the two paths into this state:
     *   - 'consensus': all alive wolves voted the same target before the
     *     shot clock expired. Standard 3 s dwell with just the red-fill
     *     animation.
     *   - 'rng': the shot clock expired and the server rolled dice (either
     *     a vote tie among the max-vote targets, or zero votes so the
     *     server randomized over the alive non-wolf village). 5 s dwell so
     *     the client can play a ~2 s bouncing-highlight animation through
     *     `candidatePlayerIds` before settling on `targetPlayerId` for the
     *     red fill.
     *
     * `actorPlayerId` is the wolf attributed to the kill on the eventual
     * `wolf_kill` row. On consensus, it's the wolf whose vote triggered
     * the lock; on RNG, it's a randomly picked alive wolf.
     */
    pendingWolfKill: v.optional(
      v.object({
        targetPlayerId: v.id('players'),
        actorPlayerId: v.id('players'),
        dwellEndsAt: v.number(),
        kind: v.optional(
          v.union(v.literal('consensus'), v.literal('rng')),
        ),
        candidatePlayerIds: v.optional(v.array(v.id('players'))),
      }),
    ),

    /**
     * Wall-clock shot-clock deadline for the current wolves' consensus
     * round. Set when the wolves step activates (and re-set after a
     * Wolf Cub vengeance kill #1 finalizes, for the kill #2 round).
     * When wall-clock passes this value and no `pendingWolfKill` has been
     * locked in yet, `wolfPickerTimeoutTick` auto-resolves: majority vote
     * wins, ties roll RNG over the tied targets, zero votes roll RNG over
     * the alive non-wolf village. Cleared the moment a `pendingWolfKill`
     * is set (so the visible countdown disappears) and on step
     * completion.
     */
    wolvesPickerEndsAt: v.optional(v.number()),

    /**
     * Per-round shot-clock length for the wolves' picker, in seconds.
     * Defaults to 30. Constrained to 10–60 in 10 s increments by the
     * settings UI; the engine reads this when arming each consensus
     * round. Editable in the lobby TIMERS modal and the day-phase
     * settings cog — both call `setDayConfig` to patch this field.
     */
    wolfPickerSec: v.optional(v.number()),

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

  /**
   * Live nomination-highlight taps for the current day. Every alive player
   * may have at most one active tap (enforced in `toggleNomTap`); a second
   * distinct tapper on the same target fires the trial. All rows for the
   * day are wiped when a trial starts, when a trial is cancelled, on
   * `beginNight`, and on day expiry — so this table never accumulates
   * across days.
   */
  nomTaps: defineTable({
    gameId: v.id('games'),
    dayNumber: v.number(),
    targetPlayerId: v.id('players'),
    nominatorPlayerId: v.id('players'),
    createdAt: v.number(),
  })
    .index('by_game_day_target', ['gameId', 'dayNumber', 'targetPlayerId'])
    .index('by_game_day_nominator', ['gameId', 'dayNumber', 'nominatorPlayerId']),
});
