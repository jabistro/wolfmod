import {
  internalMutation,
  mutation,
  query,
} from './_generated/server';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import {
  findCaller,
  requireHost,
  applyWinIfReached,
  isBotName,
  isTriggerRole,
  TRIGGER_ROLES,
  checkWinCondition,
  dayConfigOf,
  DAY_CONFIG_DEFAULTS,
  flagCubDeathIfApplicable,
} from './helpers';
import { enterStep } from './night';
import {
  enqueueTriggersForDeaths,
  processTriggerQueue,
  applyMadBomberBlast,
  TRIGGER_DWELL_MS,
} from './triggers';
import { NIGHT_STEPS } from '../src/data/nightOrder';

// ───── Config mutation ─────────────────────────────────────────────────────
//
// Sets any subset of the day-phase config. Callable in lobby (initial
// host setup) and during day (mid-game settings cog). When a duration
// changes mid-game, the matching in-flight timer is reset to the full new
// value (preserving paused vs. running state). This is what host expects
// when they save in the cog — the new number shows up on the table now,
// not on the next day/trial.

export const setDayConfig = mutation({
  args: {
    gameId: v.id('games'),
    callerDeviceClientId: v.string(),
    dayDurationSec: v.optional(v.number()),
    accusationSec: v.optional(v.number()),
    defenseSec: v.optional(v.number()),
    voteTimerSec: v.optional(v.number()),
    maxNominationsPerDay: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game) throw new Error('Game not found.');
    if (game.phase === 'ended') {
      throw new Error('Game is already over.');
    }
    await requireHost(ctx, args.gameId, args.callerDeviceClientId);

    const patch: Partial<Doc<'games'>> = {};
    if (args.dayDurationSec !== undefined) {
      if (args.dayDurationSec < 30) throw new Error('Day too short.');
      patch.dayDurationSec = args.dayDurationSec;
    }
    if (args.accusationSec !== undefined) {
      if (args.accusationSec < 5) throw new Error('Accusation too short.');
      patch.accusationSec = args.accusationSec;
    }
    if (args.defenseSec !== undefined) {
      if (args.defenseSec < 5) throw new Error('Defense too short.');
      patch.defenseSec = args.defenseSec;
    }
    if (args.voteTimerSec !== undefined) {
      if (args.voteTimerSec < 1) throw new Error('Vote too short.');
      patch.voteTimerSec = args.voteTimerSec;
    }
    if (args.maxNominationsPerDay !== undefined) {
      if (args.maxNominationsPerDay < 1) throw new Error('Need at least 1 nom.');
      patch.maxNominationsPerDay = args.maxNominationsPerDay;
    }

    const now = Date.now();

    // Reset the in-flight day clock if the day length changed during day
    // phase. Whether the clock is paused (during a trial, or host-paused)
    // or running, replace its remaining with the full new duration.
    if (args.dayDurationSec !== undefined && game.phase === 'day') {
      const fullDayMs = args.dayDurationSec * 1000;
      if (game.dayPausedRemainingMs !== undefined) {
        patch.dayPausedRemainingMs = fullDayMs;
      } else if (game.dayEndsAt !== undefined) {
        patch.dayEndsAt = now + fullDayMs;
      }
    }

    // Reset the in-flight trial sub-phase clock if the duration for the
    // current sub-phase changed. accusation/defense/vote each have their
    // own field; results sub-phase has no clock to reset.
    const nom = game.currentNomination;
    let voteRescheduleEndsAt: number | null = null;
    if (nom && nom.subPhase !== 'results') {
      const matchingNewSec =
        nom.subPhase === 'accusation'
          ? args.accusationSec
          : nom.subPhase === 'defense'
            ? args.defenseSec
            : args.voteTimerSec;
      if (matchingNewSec !== undefined) {
        const fullMs = matchingNewSec * 1000;
        const newEndsAt = now + fullMs;
        const wasPaused = nom.subPhasePausedRemainingMs !== undefined;
        patch.currentNomination = {
          ...nom,
          subPhaseEndsAt: wasPaused ? nom.subPhaseEndsAt : newEndsAt,
          subPhasePausedRemainingMs: wasPaused ? fullMs : undefined,
        };
        // Re-schedule the vote auto-tally for the new endsAt. The previous
        // schedule self-checks subPhaseEndsAt and no-ops on stale fires.
        // Skip when paused — resume will schedule its own.
        if (nom.subPhase === 'vote' && !wasPaused) {
          voteRescheduleEndsAt = newEndsAt;
        }
      }
    }

    await ctx.db.patch(args.gameId, patch);

    if (voteRescheduleEndsAt !== null && nom) {
      await ctx.scheduler.runAfter(
        voteRescheduleEndsAt - now,
        internal.day.tallyVote,
        {
          gameId: args.gameId,
          dayNumber: game.dayNumber,
          nominationIndex: nom.nominationIndex,
          expectedEndsAt: voteRescheduleEndsAt,
        },
      );
    }
  },
});

// ───── Day clock mutations ─────────────────────────────────────────────────

export const pauseDayClock = mutation({
  args: {
    gameId: v.id('games'),
    callerDeviceClientId: v.string(),
  },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game) throw new Error('Game not found.');
    if (game.phase !== 'day') throw new Error('Not currently in day.');
    if (game.currentNomination) {
      throw new Error('Day clock is already paused for a trial.');
    }
    await requireHost(ctx, args.gameId, args.callerDeviceClientId);
    if (game.dayPausedRemainingMs !== undefined) return;
    const remaining = Math.max(0, (game.dayEndsAt ?? 0) - Date.now());
    await ctx.db.patch(args.gameId, { dayPausedRemainingMs: remaining });
  },
});

export const resumeDayClock = mutation({
  args: {
    gameId: v.id('games'),
    callerDeviceClientId: v.string(),
  },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game) throw new Error('Game not found.');
    if (game.phase !== 'day') throw new Error('Not currently in day.');
    if (game.currentNomination) {
      throw new Error('Cannot resume day clock while a trial is in flight.');
    }
    await requireHost(ctx, args.gameId, args.callerDeviceClientId);
    const paused = game.dayPausedRemainingMs;
    if (paused === undefined) return;
    await ctx.db.patch(args.gameId, {
      dayEndsAt: Date.now() + paused,
      dayPausedRemainingMs: undefined,
    });
  },
});

export const resetDayClock = mutation({
  args: {
    gameId: v.id('games'),
    callerDeviceClientId: v.string(),
  },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game) throw new Error('Game not found.');
    if (game.phase !== 'day') throw new Error('Not currently in day.');
    if (game.currentNomination) {
      throw new Error('Cannot reset day clock during a trial.');
    }
    await requireHost(ctx, args.gameId, args.callerDeviceClientId);
    const cfg = dayConfigOf(game);
    // Reset to a paused full duration (host explicitly resumes / decides
    // when discussion starts again). Matches ModClock behavior.
    await ctx.db.patch(args.gameId, {
      dayEndsAt: Date.now() + cfg.dayDurationSec * 1000,
      dayPausedRemainingMs: cfg.dayDurationSec * 1000,
    });
  },
});

// ───── Nomination flow ─────────────────────────────────────────────────────

export const nominate = mutation({
  args: {
    gameId: v.id('games'),
    callerDeviceClientId: v.string(),
    targetPlayerId: v.id('players'),
  },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game) throw new Error('Game not found.');
    if (game.phase !== 'day') throw new Error('Not currently in day.');
    if (game.currentNomination) {
      throw new Error('A nomination is already active.');
    }
    await requireHost(ctx, args.gameId, args.callerDeviceClientId);

    const cfg = dayConfigOf(game);
    const dayExpired =
      game.dayPausedRemainingMs === undefined &&
      game.dayEndsAt !== undefined &&
      Date.now() > game.dayEndsAt;
    if (dayExpired) {
      throw new Error('The day has ended — no more nominations.');
    }
    const nominationsUsed = game.nominationsThisDay ?? 0;
    if (nominationsUsed >= cfg.maxNominationsPerDay) {
      throw new Error('No nominations remain for today.');
    }

    const target = await ctx.db.get(args.targetPlayerId);
    if (!target || target.gameId !== args.gameId) {
      throw new Error('Invalid target.');
    }
    if (!target.alive) throw new Error('Target is already eliminated.');

    const accusationMs = cfg.accusationSec * 1000;
    const nominationIndex = nominationsUsed;
    const now = Date.now();

    // Pause the day clock for the duration of the trial — capture remaining
    // so it can be resumed if the trial concludes without a lynch.
    const dayPatch: Partial<Doc<'games'>> = {};
    if (game.dayPausedRemainingMs === undefined) {
      dayPatch.dayPausedRemainingMs = Math.max(
        0,
        (game.dayEndsAt ?? now) - now,
      );
    }

    await ctx.db.patch(args.gameId, {
      ...dayPatch,
      currentNomination: {
        nominatedPlayerId: args.targetPlayerId,
        nominationIndex,
        subPhase: 'accusation' as const,
        // Trial timer starts PAUSED at full duration. Host taps START to
        // begin counting down. Matches ModClock UX where each trial sub-
        // phase has an explicit "start" action.
        subPhaseEndsAt: now + accusationMs,
        subPhasePausedRemainingMs: accusationMs,
        resultsRevealed: false,
      },
      nominationsThisDay: nominationIndex + 1,
    });
  },
});

// ───── Trial-clock mutations (accusation / defense / vote) ─────────────────

export const startTrialClock = mutation({
  args: {
    gameId: v.id('games'),
    callerDeviceClientId: v.string(),
  },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game) throw new Error('Game not found.');
    if (game.phase !== 'day') throw new Error('Not currently in day.');
    const nom = game.currentNomination;
    if (!nom) throw new Error('No active nomination.');
    if (nom.subPhase === 'results') {
      throw new Error('Trial is over — vote results revealed.');
    }
    await requireHost(ctx, args.gameId, args.callerDeviceClientId);

    if (nom.subPhasePausedRemainingMs === undefined) return; // already running
    const remaining = Math.max(0, nom.subPhasePausedRemainingMs);
    const newEndsAt = Date.now() + remaining;
    await ctx.db.patch(args.gameId, {
      currentNomination: {
        ...nom,
        subPhaseEndsAt: newEndsAt,
        subPhasePausedRemainingMs: undefined,
      },
    });
    // For the vote sub-phase, schedule (or re-schedule) the auto-tally. The
    // scheduled tallyVote self-checks the current endsAt and no-ops on stale
    // schedules, so it's safe to schedule multiples across pause/resume.
    if (nom.subPhase === 'vote') {
      await ctx.scheduler.runAfter(remaining, internal.day.tallyVote, {
        gameId: args.gameId,
        dayNumber: game.dayNumber,
        nominationIndex: nom.nominationIndex,
        expectedEndsAt: newEndsAt,
      });
    }
  },
});

export const pauseTrialClock = mutation({
  args: {
    gameId: v.id('games'),
    callerDeviceClientId: v.string(),
  },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game) throw new Error('Game not found.');
    if (game.phase !== 'day') throw new Error('Not currently in day.');
    const nom = game.currentNomination;
    if (!nom) throw new Error('No active nomination.');
    if (nom.subPhase === 'results') return;
    await requireHost(ctx, args.gameId, args.callerDeviceClientId);

    if (nom.subPhasePausedRemainingMs !== undefined) return; // already paused
    const remaining = Math.max(0, nom.subPhaseEndsAt - Date.now());
    await ctx.db.patch(args.gameId, {
      currentNomination: {
        ...nom,
        subPhasePausedRemainingMs: remaining,
      },
    });
  },
});

export const resetTrialClock = mutation({
  args: {
    gameId: v.id('games'),
    callerDeviceClientId: v.string(),
  },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game) throw new Error('Game not found.');
    if (game.phase !== 'day') throw new Error('Not currently in day.');
    const nom = game.currentNomination;
    if (!nom) throw new Error('No active nomination.');
    if (nom.subPhase === 'results') return;
    await requireHost(ctx, args.gameId, args.callerDeviceClientId);

    const cfg = dayConfigOf(game);
    const fullMs =
      nom.subPhase === 'accusation'
        ? cfg.accusationSec * 1000
        : nom.subPhase === 'defense'
          ? cfg.defenseSec * 1000
          : cfg.voteTimerSec * 1000;
    // Reset to paused-at-full — host explicitly starts the clock again.
    await ctx.db.patch(args.gameId, {
      currentNomination: {
        ...nom,
        subPhaseEndsAt: Date.now() + fullMs,
        subPhasePausedRemainingMs: fullMs,
      },
    });
  },
});

// ───── Sub-phase advance mutations ─────────────────────────────────────────

export const endAccusation = mutation({
  args: {
    gameId: v.id('games'),
    callerDeviceClientId: v.string(),
  },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game) throw new Error('Game not found.');
    if (game.phase !== 'day') throw new Error('Not currently in day.');
    const nom = game.currentNomination;
    if (!nom) throw new Error('No active nomination.');
    if (nom.subPhase !== 'accusation') {
      throw new Error('Not in accusation sub-phase.');
    }
    await requireHost(ctx, args.gameId, args.callerDeviceClientId);

    const cfg = dayConfigOf(game);
    const defenseMs = cfg.defenseSec * 1000;
    await ctx.db.patch(args.gameId, {
      currentNomination: {
        ...nom,
        subPhase: 'defense' as const,
        subPhaseEndsAt: Date.now() + defenseMs,
        subPhasePausedRemainingMs: defenseMs,
      },
    });
  },
});

export const endDefense = mutation({
  args: {
    gameId: v.id('games'),
    callerDeviceClientId: v.string(),
  },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game) throw new Error('Game not found.');
    if (game.phase !== 'day') throw new Error('Not currently in day.');
    const nom = game.currentNomination;
    if (!nom) throw new Error('No active nomination.');
    if (nom.subPhase !== 'defense') {
      throw new Error('Not in defense sub-phase.');
    }
    await requireHost(ctx, args.gameId, args.callerDeviceClientId);

    const cfg = dayConfigOf(game);
    const voteMs = cfg.voteTimerSec * 1000;
    // Vote sub-phase enters paused so the host can announce "time to vote"
    // before starting the countdown. Host taps START to kick off the vote
    // (and seed the auto-tally schedule).
    await ctx.db.patch(args.gameId, {
      currentNomination: {
        ...nom,
        subPhase: 'vote' as const,
        subPhaseEndsAt: Date.now() + voteMs,
        subPhasePausedRemainingMs: voteMs,
      },
    });

    // Dev convenience: bots auto-vote DIES so the lynch flow is testable
    // with a single real player. Bots can't tap, so we record their votes
    // at the moment the vote sub-phase opens. The nominee is excluded.
    const players = await ctx.db
      .query('players')
      .withIndex('by_game', q => q.eq('gameId', args.gameId))
      .collect();
    const aliveBots = players.filter(
      p =>
        p.alive &&
        isBotName(p.name) &&
        p._id !== nom.nominatedPlayerId,
    );
    const now = Date.now();
    for (const bot of aliveBots) {
      await ctx.db.insert('nominationVotes', {
        gameId: args.gameId,
        dayNumber: game.dayNumber,
        nominationIndex: nom.nominationIndex,
        voterPlayerId: bot._id,
        vote: 'dies',
        votedAt: now,
      });
    }
  },
});

// ───── Vote casting ────────────────────────────────────────────────────────

export const castVote = mutation({
  args: {
    gameId: v.id('games'),
    callerDeviceClientId: v.string(),
    vote: v.union(v.literal('lives'), v.literal('dies')),
  },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game) throw new Error('Game not found.');
    if (game.phase !== 'day') throw new Error('Not currently in day.');
    const nom = game.currentNomination;
    if (!nom) throw new Error('No active nomination.');
    if (nom.subPhase !== 'vote') {
      throw new Error('Voting has not opened yet.');
    }
    if (nom.resultsRevealed) throw new Error('Voting has closed.');

    const me = await findCaller(ctx, args.gameId, args.callerDeviceClientId);
    if (!me) throw new Error('You are not in this game.');
    if (!me.alive) throw new Error('Eliminated players cannot vote.');
    if (me._id === nom.nominatedPlayerId) {
      throw new Error('You are on trial — you cannot vote on yourself.');
    }

    // Replace any prior vote so players can change their mind before the
    // timer expires.
    const existing = await ctx.db
      .query('nominationVotes')
      .withIndex('by_game_nomination', q =>
        q
          .eq('gameId', args.gameId)
          .eq('dayNumber', game.dayNumber)
          .eq('nominationIndex', nom.nominationIndex),
      )
      .filter(q => q.eq(q.field('voterPlayerId'), me._id))
      .first();
    if (existing) {
      await ctx.db.delete(existing._id);
    }

    await ctx.db.insert('nominationVotes', {
      gameId: args.gameId,
      dayNumber: game.dayNumber,
      nominationIndex: nom.nominationIndex,
      voterPlayerId: me._id,
      vote: args.vote,
      votedAt: Date.now(),
    });
  },
});

// ───── Tally (scheduled, vote sub-phase only) ──────────────────────────────

export const tallyVote = internalMutation({
  args: {
    gameId: v.id('games'),
    dayNumber: v.number(),
    nominationIndex: v.number(),
    expectedEndsAt: v.number(),
  },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game) return;
    if (game.phase !== 'day') return;
    const nom = game.currentNomination;
    if (!nom) return;
    if (nom.subPhase !== 'vote') return;
    if (nom.nominationIndex !== args.nominationIndex) return;
    if (game.dayNumber !== args.dayNumber) return;
    if (nom.resultsRevealed) return;
    // Self-check: scheduled tally only fires for the schedule it was
    // booked for. Host pause/reset cancels by changing subPhaseEndsAt.
    if (nom.subPhaseEndsAt !== args.expectedEndsAt) return;
    if (nom.subPhasePausedRemainingMs !== undefined) return;
    if (Date.now() < nom.subPhaseEndsAt - 100) return;

    const players = await ctx.db
      .query('players')
      .withIndex('by_game', q => q.eq('gameId', args.gameId))
      .collect();
    const aliveCount = players.filter(p => p.alive).length;
    const eligibleCount = Math.max(0, aliveCount - 1);
    const votes = await ctx.db
      .query('nominationVotes')
      .withIndex('by_game_nomination', q =>
        q
          .eq('gameId', args.gameId)
          .eq('dayNumber', game.dayNumber)
          .eq('nominationIndex', nom.nominationIndex),
      )
      .collect();
    const dies = votes.filter(v => v.vote === 'dies').length;
    const lives = eligibleCount - dies;
    const lynch = dies > lives;

    // Cloak rule for the post-vote dwell:
    //   - No lynch → no death → no cloak needed.
    //   - Game has no Hunter / Hunter Wolf in the build → no actor will
    //     ever need a private decision window → no cloak needed. (Mad
    //     Bomber doesn't need a dwell — its blast is instant and folds
    //     into the result panel.)
    //   - Game has Hunter/HW AND someone is lynched → dwell, so the
    //     presence/absence of WAIT doesn't reveal whether the lynched
    //     player was a Hunter waiting to shoot.
    //   - Exception: if the lynch already ends the game and no cascade
    //     is pending (no Hunter/HW in this lynch chain), skip the dwell —
    //     end-game reveals all roles anyway.
    const targetId = lynch ? nom.nominatedPlayerId : null;
    const target = targetId ? await ctx.db.get(targetId) : null;
    const targetIsHunter = !!target && isTriggerRole(target.role);
    const targetIsBomber = !!target && target.role === 'Mad Bomber';
    // If the target is a bomber and any Hunter/HW is alive (besides the
    // target), the blast may catch them and create a cascade. We can't
    // know exact seat geometry here without doing the blast, so treat
    // this conservatively as "cascade possible".
    const aliveHunterExists = players.some(
      p =>
        p.alive &&
        p._id !== targetId &&
        p.role !== undefined &&
        isTriggerRole(p.role),
    );
    const cascadePossible =
      targetIsHunter || (targetIsBomber && aliveHunterExists);
    const gameHasTriggerRoles = game.selectedRoles.some(r =>
      TRIGGER_ROLES.has(r),
    );
    const playersAfterLynch =
      lynch && targetId
        ? players.map(p =>
            p._id === targetId ? { ...p, alive: false } : p,
          )
        : players;
    const winMet = checkWinCondition(playersAfterLynch) != null;
    const dwellNeeded =
      lynch && gameHasTriggerRoles && !(winMet && !cascadePossible);

    await ctx.db.patch(args.gameId, {
      currentNomination: {
        ...nom,
        subPhase: 'results' as const,
        resultsRevealed: true,
      },
      voteDwellEndsAt: dwellNeeded ? Date.now() + TRIGGER_DWELL_MS : undefined,
    });

    if (!lynch || !target || !targetId) return;

    // Apply the lynch death immediately so the trigger actor (if any) can
    // act during the dwell. Their decision is private; host CONTINUE
    // remains locked until the dwell ends and any cascade triggers
    // resolve.
    await ctx.db.patch(targetId, { alive: false });
    await ctx.db.insert('nightActions', {
      gameId: args.gameId,
      nightNumber: game.nightNumber,
      actorPlayerId: undefined,
      actionType: 'death',
      targetPlayerId: targetId,
      result: { cause: 'lynch', phase: 'day', dayNumber: game.dayNumber },
      resolvedAt: Date.now(),
    });
    // Wolf Cub vengeance: lynching the cub triggers 2 wolf kills next night.
    await flagCubDeathIfApplicable(ctx, args.gameId, [targetId]);

    // Mad Bomber detonations resolve INLINE — both alive neighbors die
    // at the moment of the bomber's lynch. Their deaths appear in the
    // same result panel as the lynch itself. Set the trigger context
    // BEFORE the blast so any Hunter caught in the cascade gets their
    // death row tagged phase:'day'.
    let blastDead: Id<'players'>[] = [];
    if (targetIsBomber) {
      await ctx.db.patch(args.gameId, { triggersFollowUp: 'night' });
      blastDead = await applyMadBomberBlast(
        ctx,
        args.gameId,
        game.nightNumber,
        targetId,
      );
    }

    // Enqueue Hunter/HW triggers from the lynch target AND any blast
    // victim. `enqueueTriggersForDeaths` filters non-Hunter IDs out, so
    // passing the bomber's own ID through is safe.
    const cascadeIds: Id<'players'>[] = [targetId, ...blastDead];
    if (targetIsHunter && !targetIsBomber) {
      await ctx.db.patch(args.gameId, { triggersFollowUp: 'night' });
    }
    if (targetIsHunter || targetIsBomber) {
      await enqueueTriggersForDeaths(ctx, args.gameId, cascadeIds);
      await processTriggerQueue(ctx, args.gameId);
    }
  },
});

// ───── Continue past the result panel ──────────────────────────────────────

export const continueGameAfterVote = mutation({
  args: {
    gameId: v.id('games'),
    callerDeviceClientId: v.string(),
  },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game) throw new Error('Game not found.');
    if (game.phase !== 'day') throw new Error('Not currently in day.');
    const nom = game.currentNomination;
    if (!nom) throw new Error('No active nomination.');
    if (!nom.resultsRevealed) throw new Error('Vote has not been tallied yet.');

    await requireHost(ctx, args.gameId, args.callerDeviceClientId);

    // Dwell + trigger locks (existing — preserves trigger-role cloak).
    const now = Date.now();
    if (game.voteDwellEndsAt && now < game.voteDwellEndsAt) {
      throw new Error('Continue is still locked.');
    }
    if ((game.pendingDeathTriggers?.length ?? 0) > 0) {
      throw new Error('A trigger is still being decided.');
    }
    if (
      game.triggerAnnouncement &&
      now < game.triggerAnnouncement.endsAt
    ) {
      throw new Error('Announcement is still displaying.');
    }

    const nominee = await ctx.db.get(nom.nominatedPlayerId as Id<'players'>);
    const wasLynched = !!nominee && !nominee.alive;

    // Clear nomination + dwell state regardless of result. If no lynch and
    // day still has time AND noms still remain, resume the day clock from
    // the pause we captured at nominate(). Otherwise leave the clock paused
    // (or expired) — the discussion view will show "DAY IS OVER" until host
    // taps BEGIN NIGHT.
    const cfg = dayConfigOf(game);
    const nominationsUsed = game.nominationsThisDay ?? 0;
    const noNomsLeft = nominationsUsed >= cfg.maxNominationsPerDay;

    const basePatch: Partial<Doc<'games'>> = {
      currentNomination: undefined,
      voteDwellEndsAt: undefined,
      triggersFollowUp: undefined,
      triggerAnnouncement: undefined,
    };

    if (wasLynched) {
      // Day ends on lynch regardless of remaining time/noms.
      await ctx.db.patch(args.gameId, basePatch);
      const won = await applyWinIfReached(ctx, args.gameId);
      if (won) return;
      await ctx.db.patch(args.gameId, {
        phase: 'night',
        nightNumber: game.nightNumber + 1,
      });
      await enterStep(ctx, args.gameId, NIGHT_STEPS[0]);
      return;
    }

    // No lynch. Resume the day clock if there's any reason to keep playing.
    const dayClockRemaining = game.dayPausedRemainingMs ?? 0;
    const dayHasTimeLeft = dayClockRemaining > 0;
    if (dayHasTimeLeft && !noNomsLeft) {
      await ctx.db.patch(args.gameId, {
        ...basePatch,
        dayEndsAt: now + dayClockRemaining,
        dayPausedRemainingMs: undefined,
      });
    } else {
      // Day is over (either out of time or out of nominations). Leave the
      // day clock paused at whatever it has; discussion view will show
      // "DAY IS OVER — BEGIN NIGHT WHEN READY".
      await ctx.db.patch(args.gameId, {
        ...basePatch,
        dayEndsAt: now, // mark expired for clean client display
        dayPausedRemainingMs: undefined,
      });
    }
  },
});

// ───── Query ───────────────────────────────────────────────────────────────

export const dayView = query({
  args: {
    gameId: v.id('games'),
    deviceClientId: v.string(),
  },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game) return null;

    const players = await ctx.db
      .query('players')
      .withIndex('by_game', q => q.eq('gameId', args.gameId))
      .collect();
    const me = players.find(p => p.deviceClientId === args.deviceClientId);
    if (!me) return null;

    const playerById = new Map(players.map(p => [p._id, p]));
    const alive = players.filter(p => p.alive);

    const cfg = dayConfigOf(game);
    const nominationsUsed = game.nominationsThisDay ?? 0;
    const nominationsRemaining = Math.max(
      0,
      cfg.maxNominationsPerDay - nominationsUsed,
    );

    // Cascade deaths from THIS lynch (Hunter/HW shot, MB blast). For shot
    // deaths we also resolve the shooter's name from the matching shot
    // action — the shooter is public info (the announcement already says
    // "X HAS SHOT Y"), and attribution lets the table see chained shots
    // correctly (e.g. Hunter shoots HW, HW then shoots someone else).
    //
    // Anchor the time window on the LYNCH ROW itself rather than the
    // vote-dwell deadline: MB blasts in a no-Hunter game skip the dwell,
    // so `voteDwellEndsAt` is undefined, but cascade rows still exist
    // and should appear in the result panel.
    let cascadeDeaths: Array<{
      _id: Id<'players'>;
      name: string;
      cause: string;
      shotByName: string | null;
    }> = [];
    if (game.currentNomination?.resultsRevealed) {
      const nom = game.currentNomination;
      const rows = await ctx.db
        .query('nightActions')
        .withIndex('by_game_night', q =>
          q.eq('gameId', args.gameId).eq('nightNumber', game.nightNumber),
        )
        .collect();
      const lynchRow = rows.find(
        r =>
          r.actionType === 'death' &&
          r.targetPlayerId === nom.nominatedPlayerId &&
          (r.result as { cause?: string } | undefined)?.cause === 'lynch',
      );
      const lynchStart = lynchRow?.resolvedAt;
      const shotRows = rows.filter(
        r =>
          r.actionType === 'hunter_shot' || r.actionType === 'hunter_wolf_shot',
      );
      for (const r of rows) {
        if (lynchStart === undefined) break;
        if (r.actionType !== 'death') continue;
        if (r.resolvedAt < lynchStart) continue;
        const cause = (r.result?.cause as string | undefined) ?? '';
        if (cause === 'lynch' || cause === '') continue;
        if (!r.targetPlayerId) continue;
        const p = playerById.get(r.targetPlayerId);
        if (!p) continue;
        let shotByName: string | null = null;
        if (cause === 'hunter' || cause === 'hunter-wolf') {
          const shot = shotRows.find(s => s.targetPlayerId === r.targetPlayerId);
          if (shot?.actorPlayerId) {
            const shooter = playerById.get(shot.actorPlayerId);
            if (shooter) shotByName = shooter.name;
          }
        }
        cascadeDeaths.push({ _id: p._id, name: p.name, cause, shotByName });
      }
    }

    let nomination: {
      nominee: { _id: Id<'players'>; name: string } | null;
      subPhase: 'accusation' | 'defense' | 'vote' | 'results';
      subPhaseEndsAt: number;
      subPhasePausedRemainingMs: number | null;
      resultsRevealed: boolean;
      votedCount: number;
      eligibleCount: number;
      livesVoters: string[];
      diesVoters: string[];
      myVote: 'lives' | 'dies' | null;
      iAmNominee: boolean;
    } | null = null;

    if (game.currentNomination) {
      const nom = game.currentNomination;
      const nominee = playerById.get(nom.nominatedPlayerId);
      const allVotes = await ctx.db
        .query('nominationVotes')
        .withIndex('by_game_nomination', q =>
          q
            .eq('gameId', args.gameId)
            .eq('dayNumber', game.dayNumber)
            .eq('nominationIndex', nom.nominationIndex),
        )
        .collect();

      const myVote =
        allVotes.find(v => v.voterPlayerId === me._id)?.vote ?? null;

      const livesVoters: string[] = [];
      const diesVoters: string[] = [];

      if (nom.resultsRevealed) {
        for (const v of allVotes) {
          const voter = playerById.get(v.voterPlayerId);
          if (!voter) continue;
          if (v.vote === 'lives') livesVoters.push(voter.name);
          else diesVoters.push(voter.name);
        }
        const votedIds = new Set(allVotes.map(v => v.voterPlayerId));
        for (const p of alive) {
          if (p._id === nom.nominatedPlayerId) continue;
          if (!votedIds.has(p._id)) {
            livesVoters.push(`${p.name} (no vote)`);
          }
        }
      }

      const eligibleCount = Math.max(0, alive.length - 1);
      nomination = {
        nominee: nominee
          ? { _id: nominee._id, name: nominee.name }
          : null,
        subPhase: nom.subPhase,
        subPhaseEndsAt: nom.subPhaseEndsAt,
        subPhasePausedRemainingMs: nom.subPhasePausedRemainingMs ?? null,
        resultsRevealed: nom.resultsRevealed,
        votedCount: allVotes.length,
        eligibleCount,
        livesVoters,
        diesVoters,
        myVote,
        iAmNominee: me._id === nom.nominatedPlayerId,
      };
    }

    return {
      game: {
        _id: game._id,
        phase: game.phase,
        dayNumber: game.dayNumber,
        nightNumber: game.nightNumber,
        winner: game.winner,
        playerCount: game.playerCount,
        selectedRoles: game.selectedRoles,
        voteDwellEndsAt: game.voteDwellEndsAt ?? null,
        pendingTriggerCount: game.pendingDeathTriggers?.length ?? 0,
        // Day-clock state
        dayEndsAt: game.dayEndsAt ?? null,
        dayPausedRemainingMs: game.dayPausedRemainingMs ?? null,
        // Nominations
        nominationsUsed,
        nominationsRemaining,
        maxNominationsPerDay: cfg.maxNominationsPerDay,
        // Full config (for the settings cog modal)
        config: {
          dayDurationSec: cfg.dayDurationSec,
          accusationSec: cfg.accusationSec,
          defenseSec: cfg.defenseSec,
          voteTimerSec: cfg.voteTimerSec,
          maxNominationsPerDay: cfg.maxNominationsPerDay,
        },
      },
      me: {
        _id: me._id,
        name: me.name,
        role: me.role,
        alive: me.alive,
        isHost: me.isHost,
        seatPosition: me.seatPosition,
      },
      alive: alive
        .sort((a, b) => (a.seatPosition ?? 0) - (b.seatPosition ?? 0))
        .map(p => ({
          _id: p._id,
          name: p.name,
          seatPosition: p.seatPosition,
        })),
      currentNomination: nomination,
      cascadeDeaths,
    };
  },
});

// Re-export so other modules can use default if needed (no runtime use,
// just type clarity for downstream).
export { DAY_CONFIG_DEFAULTS };
