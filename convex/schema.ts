import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

export default defineSchema({
  games: defineTable({
    roomCode: v.string(),
    /**
     * Play mode. 'local' = everyone in the same room (the app replaces the
     * moderator's clipboard; players talk out loud). 'remote' = players are
     * physically apart and coordinate through in-app text chat (see the
     * `messages` table + convex/chat.ts). Optional so games from older
     * deploys validate; absent is treated as 'local' everywhere.
     */
    mode: v.optional(v.union(v.literal('local'), v.literal('remote'))),
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
          /**
           * Wall-clock deadline for the step's human actor(s) to decide
           * (NIGHT ACTIONS timer). Set for non-wolf steps with a human actor;
           * surfaced to that actor as a visible countdown (picker + chat
           * header). On expiry `nightActionTimeout` auto-resolves laggards.
           */
          decisionEndsAt: v.optional(v.number()),
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
    winner: v.optional(
      v.union(
        v.literal('village'),
        v.literal('wolf'),
        v.literal('chupacabra'),
      ),
    ),
    createdAt: v.number(),
    endedAt: v.optional(v.number()),

    // Day-phase configuration. All optional — see defaults in helpers.ts.
    // voteTimerSec is the per-vote countdown (default 5).
    voteTimerSec: v.optional(v.number()),
    dayDurationSec: v.optional(v.number()),
    accusationSec: v.optional(v.number()),
    defenseSec: v.optional(v.number()),
    // Remote autopilot pre-vote buffer (seconds). See dayConfigOf default.
    preVoteSec: v.optional(v.number()),
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
     * Remote autopilot: set when the day clock has run out with no trial in
     * progress. While set, the village chat is locked and a "night is falling"
     * moderator message is showing; an internal `enterNightFromDayClock` is
     * scheduled for this timestamp and transitions to night when it fires.
     * Cleared on the night transition and when a new day clock initializes.
     */
    nightFallsAt: v.optional(v.number()),
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
          // Remote autopilot buffer between defense and vote — village reads
          // the defense before LIVES/DIES open. Not used in local (host-driven).
          v.literal('prevote'),
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
    // Per-actor night-action decision timer (non-wolf night roles). See
    // dayConfigOf default; auto-resolves the actor on expiry.
    nightActionSec: v.optional(v.number()),

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
     * Alpha Wolf one-time conversion lifecycle. Only present when an Alpha
     * Wolf is in the build (initialized to 'unused' at game start).
     *   - 'unused'  : no qualifying wolf death yet.
     *   - 'armed'   : another (non-Alpha) wolf has died while the Alpha lived;
     *                 the NEXT wolves step converts instead of kills (if the
     *                 Alpha is still alive then). Set once, never re-armed.
     *   - 'spent'   : the conversion night has happened (landed, was blocked,
     *                 was Warlock-cancelled, or was lost because the Alpha
     *                 died before it could fire). Never converts again.
     */
    alphaConvert: v.optional(
      v.union(v.literal('unused'), v.literal('armed'), v.literal('spent')),
    ),
    /**
     * The nightNumber on which the Alpha conversion is actively resolving.
     * Set at `beginNightWaves` when `alphaConvert==='armed'` AND an Alpha is
     * still alive. Read by the wolves picker (CONVERT verb), the
     * `alpha_conversion` reveal step, and morning resolution. Cleared (and
     * `alphaConvert` flipped to 'spent') at that morning's resolution.
     */
    alphaConvertActiveNight: v.optional(v.number()),

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
    /**
     * Set by Mama Wolf at first-night seat selection — the player she marks
     * as a Lycan. Stored on Mama Wolf for the ready-gate, bot auto-pick, and
     * end-game history. The actual Seer-fooling effect lives on the target's
     * `seerAppearsAsWolf` flag below (so it survives Mama Wolf dying).
     */
    mamaWolfTarget: v.optional(v.id('players')),
    /**
     * True when this player has been marked (by Mama Wolf) to read as a wolf
     * to the Seer, despite their real role. Top-level (not in roleState) so a
     * later Doppelganger/Cursed/Sasquatch role-patch can't wipe it. Never
     * changes the player's actual role — only what the Seer's check returns.
     */
    seerAppearsAsWolf: v.optional(v.boolean()),
    /**
     * The Drunk's set-aside future role. Chosen at deal time (the "+1" role a
     * Drunk build carries beyond the player count) and stashed on whoever
     * draws the Drunk. At the start of the third night the Drunk sobers up and
     * `role` is patched to this value (originalRole stays 'Drunk' for the
     * end-game arc). Stays set after the flip for end-game/log reads, and is
     * copied onto a Doppelganger that inherits a still-un-sobered Drunk so
     * they sober on the same night. The Reviler's hunt reads this through the
     * 'Drunk' mask — see `revilerSeesRole`.
     */
    drunkDelayedRole: v.optional(v.string()),
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

  /**
   * Remote-mode in-app chat. One row per message. Append-only; never deleted
   * (post-game review reads the whole transcript). `channel` is the routing
   * tag — read/post permission is NOT stored, it's computed from the live
   * (player.alive, player.role, game.phase, nomination sub-phase) state in
   * convex/chat.ts, exactly the way the night engine gates what each phone
   * sees. So role conversions (Cursed/Sasquatch → wolf) move a player into
   * the right channel with no extra bookkeeping here.
   *
   *   'village' — daytime open forum (gated by nomination speaking rules)
   *   'wolves'  — wolves' night coordination (real wolves only)
   *   'dead'    — eliminated players' ghost channel
   *
   * `authorName` is denormalized so the message list renders without a join.
   * `phaseLabel` ("Day 2" / "Night 3") is stamped at send time for dividers.
   */
  messages: defineTable({
    gameId: v.id('games'),
    channel: v.union(
      v.literal('village'),
      v.literal('wolves'),
      v.literal('dead'),
      // Off-the-record room, postable by everyone only while the host has the
      // game paused — keeps pause chatter out of the village gameplay log.
      v.literal('break'),
    ),
    /**
     * Author of a player message. Omitted on `system` messages (the engine's
     * "moderator" announcements — e.g. the dawn night report), which have no
     * human sender.
     */
    authorPlayerId: v.optional(v.id('players')),
    authorName: v.string(),
    body: v.string(),
    phaseLabel: v.string(),
    sentAt: v.number(),
    /**
     * True for engine-posted moderator announcements (dawn night report).
     * Rendered as a centered, bordered callout instead of a chat bubble.
     */
    system: v.optional(v.boolean()),
    /**
     * Optional big, bold headline for a moderator message (e.g. an elimination
     * line). Rendered larger than `body`, which becomes the smaller detail
     * line beneath it. Mentions tint names in both.
     */
    headline: v.optional(v.string()),
    /**
     * Player names referenced in a moderator `body`, with their player _id
     * (string) — the client tints each occurrence its chat color so you can
     * tell at a glance who's being talked about.
     */
    mentions: v.optional(
      v.array(v.object({ name: v.string(), id: v.string() })),
    ),
    /**
     * Set on the post-vote results message — drives the blue/red LIVES vs DIES
     * tally card in chat (who voted which way), the way local games show it.
     * The plain-language outcome (lynch / no lynch) is a separate moderator
     * message posted just after.
     */
    voteResult: v.optional(
      v.object({
        nomineeName: v.string(),
        livesVoters: v.array(v.string()),
        diesVoters: v.array(v.string()),
      }),
    ),
    /**
     * Set on the dawn night report — rendered as a bold, scannable card
     * ("DAY N" + "NAME HAS BEEN ELIMINATED" / "NO ONE HAS BEEN ELIMINATED")
     * rather than a wordy sentence, with eliminated names tinted their chat
     * color. `id` is the player _id (string) so the client can recompute the
     * same color used for their avatar/messages.
     */
    dawnReport: v.optional(
      v.object({
        dayLabel: v.number(),
        eliminated: v.array(v.object({ name: v.string(), id: v.string() })),
        // Players still alive as the day opens, seat-ordered — the morning
        // "who's left in the game?" roll call. Names tinted their chat color in
        // the card. Optional so dawn reports written before this field still read.
        remaining: v.optional(
          v.array(v.object({ name: v.string(), id: v.string() })),
        ),
      }),
    ),
    /**
     * Set on the end-of-game message — rendered as a big proud WIN banner in
     * chat the moment a win condition is met. The engine jumps straight to the
     * end-game screen behind the chat; closing the chat reveals the role logs.
     */
    winBanner: v.optional(
      v.object({
        winner: v.union(
          v.literal('village'),
          v.literal('wolf'),
          v.literal('chupacabra'),
        ),
      }),
    ),
    /**
     * Morning roll call: the players still in the game as a day opens (day ≥ 2),
     * seat-ordered. Posted at true day-start (after night deaths AND any Hunter
     * cascade resolve) so "who's left?" is accurate before discussion. Rendered
     * as a moderator card with each name tinted its chat-identity color.
     */
    roster: v.optional(
      v.array(v.object({ name: v.string(), id: v.string() })),
    ),
    /**
     * A Hunter / Hunter Wolf death-shot, posted to the village chat as a
     * permanent, prominent elimination record (the on-screen trigger overlay is
     * transient and, in remote mode, hidden behind the docked chat). The shot
     * is a public action — the shooter is revealed, mirroring the overlay.
     */
    shotReport: v.optional(
      v.object({
        shooter: v.object({ name: v.string(), id: v.string() }),
        target: v.object({ name: v.string(), id: v.string() }),
      }),
    ),
    /**
     * A Mad Bomber detonation, posted to the village chat when the bomber dies
     * PUBLICLY (lynch or Hunter shot) — listing everyone the blast took. Night
     * detonations are NOT posted here: their victims already appear in the dawn
     * report, which deliberately doesn't reveal cause of death.
     */
    blastReport: v.optional(
      v.object({
        bomber: v.object({ name: v.string(), id: v.string() }),
        victims: v.array(v.object({ name: v.string(), id: v.string() })),
      }),
    ),
  }).index('by_game_channel', ['gameId', 'channel']),
});
