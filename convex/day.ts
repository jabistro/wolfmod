import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
} from './_generated/server';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import {
  findCaller,
  requireHost,
  applyWinIfReached,
  postWinBanner,
  isBotName,
  isTriggerRole,
  TRIGGER_ROLES,
  checkWinCondition,
  dayConfigOf,
  DAY_CONFIG_DEFAULTS,
  flagCubDeathIfApplicable,
  flagAlphaConvertIfApplicable,
  wipeNomTapsForDay,
} from './helpers';
import {
  applyDrunkSoberUp,
  enterStep,
  fireDoppelgangerConversionsForDeaths,
  prepareAlphaConvertNight,
} from './night';
import {
  enqueueTriggersForDeaths,
  processTriggerQueue,
  applyMadBomberBlast,
  postBlastReport,
  TRIGGER_DWELL_MS,
} from './triggers';
import { NIGHT_STEPS } from '../src/data/nightOrder';

// Grace window between the displayed vote countdown hitting zero and the
// server actually tallying. The UI timer drives off subPhaseEndsAt and the
// Lives/Dies buttons disable when it ticks past 0, but the tally fires
// VOTE_GRACE_MS later — so any in-flight tap that left a phone before the
// visible deadline still lands in the 'vote' subphase and counts. Network
// RTTs >1500ms (poor cellular) can still race past this and fall through
// to the "vote didn't count" alert on the client. Tunable.
const VOTE_GRACE_MS = 1500;

// Dwell between the 2nd nomination tap (or host force-nominate) and the
// real trial taking over. During this window the discussion view stays
// up, the nommed seat plays a white-fill animation, and a banner names
// the accuser/seconder. Keeps the transition from feeling abrupt and
// gives the table a moment to register who's on the stand. The day
// clock is paused for the duration, so the dwell doesn't eat day time.
const TRIAL_CONFIRM_DWELL_MS = 3000;

// Remote autopilot: how long the moderator "night is falling" message sits in
// chat before the engine actually enters night, so the move never feels abrupt.
const NIGHTFALL_WARNING_MS = 7000;

// Remote autopilot: beat after the vote tally posts before the engine resolves
// (resume day / warn nightfall) — lets the village read the result count.
const RESULT_READ_MS = 4000;

const isRemote = (game: Doc<'games'>) => game.mode === 'remote';

/**
 * Post a moderator (system) announcement to the village chat. Used by the
 * remote autopilot to narrate each beat (trial steps, vote results, nightfall)
 * the way a human moderator would. No-op for local games (no chat).
 */
async function postModeratorMessage(
  ctx: MutationCtx,
  game: Doc<'games'>,
  body: string,
  mentions?: { name: string; id: string }[],
  headline?: string,
  revealRole?: string,
) {
  if (!isRemote(game)) return;
  await ctx.db.insert('messages', {
    gameId: game._id,
    channel: 'village',
    authorName: 'MODERATOR',
    body,
    phaseLabel: `Day ${game.dayNumber}`,
    sentAt: Date.now(),
    system: true,
    ...(mentions && mentions.length ? { mentions } : {}),
    ...(headline ? { headline } : {}),
    ...(revealRole ? { revealRole } : {}),
  });
}

/**
 * Dev convenience: alive bots auto-vote DIES the moment the vote opens (they
 * can't tap), excluding the nominee. Shared by the local host path
 * (`endDefense`) and the remote autopilot (`autoAdvanceTrial`).
 */
async function seedBotVotes(
  ctx: MutationCtx,
  game: Doc<'games'>,
  nom: NonNullable<Doc<'games'>['currentNomination']>,
) {
  const players = await ctx.db
    .query('players')
    .withIndex('by_game', q => q.eq('gameId', game._id))
    .collect();
  const aliveBots = players.filter(
    p => p.alive && isBotName(p.name) && p._id !== nom.nominatedPlayerId,
  );
  const now = Date.now();
  for (const bot of aliveBots) {
    await ctx.db.insert('nominationVotes', {
      gameId: game._id,
      dayNumber: game.dayNumber,
      nominationIndex: nom.nominationIndex,
      voterPlayerId: bot._id,
      vote: 'dies',
      votedAt: now,
    });
  }
}

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
    preVoteSec: v.optional(v.number()),
    maxNominationsPerDay: v.optional(v.number()),
    wolfPickerSec: v.optional(v.number()),
    nightActionSec: v.optional(v.number()),
    revealOnLynch: v.optional(v.boolean()),
    revealOnNightDeath: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game) throw new Error('Game not found.');
    if (game.phase === 'ended') {
      throw new Error('Game is already over.');
    }
    await requireHost(ctx, args.gameId, args.callerDeviceClientId);

    const patch: Partial<Doc<'games'>> = {};
    if (args.revealOnLynch !== undefined) patch.revealOnLynch = args.revealOnLynch;
    if (args.revealOnNightDeath !== undefined)
      patch.revealOnNightDeath = args.revealOnNightDeath;
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
    if (args.preVoteSec !== undefined) {
      if (args.preVoteSec < 5) throw new Error('Pre-vote too short.');
      patch.preVoteSec = args.preVoteSec;
    }
    if (args.maxNominationsPerDay !== undefined) {
      if (args.maxNominationsPerDay < 1) throw new Error('Need at least 1 nom.');
      patch.maxNominationsPerDay = args.maxNominationsPerDay;
    }
    if (args.wolfPickerSec !== undefined) {
      // Settings UI constrains to 10–180 in 10 s increments; backend
      // enforces the same so a stale client can't smuggle an out-of-band
      // value through.
      if (args.wolfPickerSec < 10 || args.wolfPickerSec > 180) {
        throw new Error('Wolf decision must be 10–180 s.');
      }
      if (args.wolfPickerSec % 10 !== 0) {
        throw new Error('Wolf decision must step in 10 s increments.');
      }
      patch.wolfPickerSec = args.wolfPickerSec;
    }
    if (args.nightActionSec !== undefined) {
      if (args.nightActionSec < 10 || args.nightActionSec > 180) {
        throw new Error('Night actions must be 10–180 s.');
      }
      if (args.nightActionSec % 10 !== 0) {
        throw new Error('Night actions must step in 10 s increments.');
      }
      patch.nightActionSec = args.nightActionSec;
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
        voteRescheduleEndsAt - now + VOTE_GRACE_MS,
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
    await scheduleDayExpiry(ctx, args.gameId);
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
//
// Nominations are player-driven. Any alive player taps a target seat on the
// circle to register a tap; a second distinct alive tap on the same seat
// fires the trial. The first tapper is the accuser, the second is the
// seconder — both are stamped on `currentNomination` and shown in the
// accusation banner. Self-taps and dead-target taps are rejected. Each
// nominator has at most one live tap on the table: tapping a different
// seat moves the highlight, tapping the same seat untaps. Host has no
// special nomination button anymore (they tap like everyone else); the
// host can still cancel an in-flight trial via `cancelNomination`.

export const toggleNomTap = mutation({
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
      throw new Error('A nomination is already in progress.');
    }
    if (game.pendingTrial) {
      throw new Error('A nomination is being confirmed.');
    }

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

    const me = await findCaller(ctx, args.gameId, args.callerDeviceClientId);
    if (!me) throw new Error('You are not in this game.');
    if (!me.alive) throw new Error('Eliminated players cannot nominate.');
    if (me._id === args.targetPlayerId) {
      throw new Error('You cannot nominate yourself.');
    }

    const target = await ctx.db.get(args.targetPlayerId);
    if (!target || target.gameId !== args.gameId) {
      throw new Error('Invalid target.');
    }
    if (!target.alive) throw new Error('Target is already eliminated.');

    // Find any existing tap rows I own for today.
    const myExistingTaps = await ctx.db
      .query('nomTaps')
      .withIndex('by_game_day_nominator', q =>
        q
          .eq('gameId', args.gameId)
          .eq('dayNumber', game.dayNumber)
          .eq('nominatorPlayerId', me._id),
      )
      .collect();

    const existingOnTarget = myExistingTaps.find(
      r => r.targetPlayerId === args.targetPlayerId,
    );
    if (existingOnTarget) {
      // Tap-same → untap. No trial check (count can only go down).
      await ctx.db.delete(existingOnTarget._id);
      return;
    }

    // Tap-different (or first tap). One live tap per player, so drop any
    // other taps I own before inserting the new one.
    for (const r of myExistingTaps) {
      await ctx.db.delete(r._id);
    }

    const now = Date.now();
    await ctx.db.insert('nomTaps', {
      gameId: args.gameId,
      dayNumber: game.dayNumber,
      targetPlayerId: args.targetPlayerId,
      nominatorPlayerId: me._id,
      createdAt: now,
    });

    // Re-read the target's taps to see if my insert crossed the 2-distinct
    // threshold that fires a trial.
    const targetTaps = await ctx.db
      .query('nomTaps')
      .withIndex('by_game_day_target', q =>
        q
          .eq('gameId', args.gameId)
          .eq('dayNumber', game.dayNumber)
          .eq('targetPlayerId', args.targetPlayerId),
      )
      .collect();

    if (targetTaps.length < 2) return;

    // Earliest tap = accuser, second-earliest = seconder. Anyone after
    // doesn't carry weight — once the 2nd tap lands, the trial starts.
    const sorted = [...targetTaps].sort((a, b) => a.createdAt - b.createdAt);
    const accuserPlayerId = sorted[0].nominatorPlayerId;
    const seconderPlayerId = sorted[1].nominatorPlayerId;

    // Clean slate during the trial — no in-flight highlights linger.
    await wipeNomTapsForDay(ctx, args.gameId, game.dayNumber);

    await scheduleTrialConfirmDwell(ctx, {
      gameId: args.gameId,
      game,
      now,
      targetPlayerId: args.targetPlayerId,
      accuserPlayerId,
      seconderPlayerId,
    });
  },
});

/**
 * Stage the confirmation dwell. Pauses the day clock (so the dwell
 * doesn't eat day time), sets `pendingTrial` for every client to read,
 * and schedules `finalizePendingTrial` to fire when the dwell expires.
 * Used by both the 2-tap path and the host force-nominate path so the
 * visual rhythm is uniform.
 */
async function scheduleTrialConfirmDwell(
  ctx: MutationCtx,
  args: {
    gameId: Id<'games'>;
    game: Doc<'games'>;
    now: number;
    targetPlayerId: Id<'players'>;
    accuserPlayerId: Id<'players'>;
    seconderPlayerId?: Id<'players'>;
  },
) {
  const dwellEndsAt = args.now + TRIAL_CONFIRM_DWELL_MS;
  const dayPatch: Partial<Doc<'games'>> = {};
  if (args.game.dayPausedRemainingMs === undefined) {
    dayPatch.dayPausedRemainingMs = Math.max(
      0,
      (args.game.dayEndsAt ?? args.now) - args.now,
    );
  }
  await ctx.db.patch(args.gameId, {
    ...dayPatch,
    pendingTrial: {
      targetPlayerId: args.targetPlayerId,
      accuserPlayerId: args.accuserPlayerId,
      seconderPlayerId: args.seconderPlayerId,
      dwellEndsAt,
    },
  });
  await ctx.scheduler.runAfter(
    TRIAL_CONFIRM_DWELL_MS,
    internal.day.finalizePendingTrial,
    { gameId: args.gameId, expectedDwellEndsAt: dwellEndsAt },
  );
}

/**
 * Promotes `pendingTrial` into the real `currentNomination`. Defensive
 * against stale schedules: if the stored dwellEndsAt no longer matches
 * what we scheduled for (because the game ended, a cancel happened, or
 * a new pendingTrial superseded ours), this is a no-op.
 */
export const finalizePendingTrial = internalMutation({
  args: {
    gameId: v.id('games'),
    expectedDwellEndsAt: v.number(),
  },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game) return;
    if (game.phase !== 'day') return;
    const pending = game.pendingTrial;
    if (!pending) return;
    if (pending.dwellEndsAt !== args.expectedDwellEndsAt) return;
    if (game.currentNomination) return;

    const cfg = dayConfigOf(game);
    const accusationMs = cfg.accusationSec * 1000;
    const nominationsUsed = game.nominationsThisDay ?? 0;
    const nominationIndex = nominationsUsed;
    const now = Date.now();
    const remote = isRemote(game);
    const endsAt = now + accusationMs;

    await ctx.db.patch(args.gameId, {
      pendingTrial: undefined,
      currentNomination: {
        nominatedPlayerId: pending.targetPlayerId,
        nominationIndex,
        subPhase: 'accusation' as const,
        // Remote autopilot starts the accusation clock RUNNING immediately
        // (no host START tap). Local keeps it PAUSED at full duration so the
        // host explicitly starts each trial sub-phase.
        subPhaseEndsAt: endsAt,
        subPhasePausedRemainingMs: remote ? undefined : accusationMs,
        resultsRevealed: false,
        accuserPlayerId: pending.accuserPlayerId,
        seconderPlayerId: pending.seconderPlayerId,
      },
      nominationsThisDay: nominationIndex + 1,
    });

    if (remote) {
      const accused = await ctx.db.get(pending.targetPlayerId);
      const accuser = await ctx.db.get(pending.accuserPlayerId);
      const seconder = pending.seconderPlayerId
        ? await ctx.db.get(pending.seconderPlayerId)
        : null;
      const accuserName = accuser?.name ?? 'Someone';
      const secPart =
        seconder && seconder._id !== accuser?._id
          ? `, seconded by ${seconder.name}`
          : '';
      const cueMentions = [accused, accuser, seconder]
        .filter((p): p is NonNullable<typeof p> => !!p)
        .map(p => ({ name: p.name, id: p._id as string }));
      await postModeratorMessage(
        ctx,
        game,
        `${accused?.name ?? 'A player'} is on trial — accused by ${accuserName}${secPart}.\n\n${accuserName}, make your accusation.`,
        cueMentions,
      );
      await ctx.scheduler.runAfter(accusationMs, internal.day.autoAdvanceTrial, {
        gameId: args.gameId,
        fromSubPhase: 'accusation',
        expectedEndsAt: endsAt,
      });
    }
  },
});

// ───── Remote autopilot: trial sub-phase auto-advance ──────────────────────
//
// Drives accusation → defense → prevote → vote without host taps. Each step
// schedules the next; the scheduled call self-checks (subPhase, endsAt, pause)
// and no-ops on stale/superseded/paused schedules — the same defensive pattern
// as tallyVote. Re-armed on host resume (see startTrialClock).
export const autoAdvanceTrial = internalMutation({
  args: {
    gameId: v.id('games'),
    fromSubPhase: v.union(
      v.literal('accusation'),
      v.literal('defense'),
      v.literal('prevote'),
    ),
    expectedEndsAt: v.number(),
  },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game || !isRemote(game) || game.phase !== 'day') return;
    const nom = game.currentNomination;
    if (!nom || nom.subPhase !== args.fromSubPhase) return;
    if (nom.subPhasePausedRemainingMs !== undefined) return; // paused by host
    if (nom.subPhaseEndsAt !== args.expectedEndsAt) return; // stale/superseded
    if (Date.now() < nom.subPhaseEndsAt - 100) return; // fired too early

    await applyTrialAdvance(ctx, game, nom);
  },
});

// Advance the trial one step (accusation → defense → prevote → vote), posting
// the moderator cue and scheduling the next auto-advance. Shared by the timer
// (autoAdvanceTrial) and the speaker's early SEND (submitTrialStatement).
async function applyTrialAdvance(
  ctx: MutationCtx,
  game: Doc<'games'>,
  nom: NonNullable<Doc<'games'>['currentNomination']>,
) {
  const cfg = dayConfigOf(game);
  const now = Date.now();
  const accused = await ctx.db.get(nom.nominatedPlayerId);
  const accusedName = accused?.name ?? 'the accused';
  const accusedMention = accused
    ? [{ name: accused.name, id: accused._id as string }]
    : undefined;

  if (nom.subPhase === 'accusation') {
    const defenseMs = cfg.defenseSec * 1000;
    const nextEndsAt = now + defenseMs;
    await ctx.db.patch(game._id, {
      currentNomination: {
        ...nom,
        subPhase: 'defense' as const,
        subPhaseEndsAt: nextEndsAt,
        subPhasePausedRemainingMs: undefined,
      },
    });
    await postModeratorMessage(
      ctx,
      game,
      `${accusedName}, make your defense.`,
      accusedMention,
    );
    await ctx.scheduler.runAfter(defenseMs, internal.day.autoAdvanceTrial, {
      gameId: game._id,
      fromSubPhase: 'defense',
      expectedEndsAt: nextEndsAt,
    });
    return;
  }

  if (nom.subPhase === 'defense') {
    const preVoteMs = cfg.preVoteSec * 1000;
    const nextEndsAt = now + preVoteMs;
    await ctx.db.patch(game._id, {
      currentNomination: {
        ...nom,
        subPhase: 'prevote' as const,
        subPhaseEndsAt: nextEndsAt,
        subPhasePausedRemainingMs: undefined,
      },
    });
    await postModeratorMessage(
      ctx,
      game,
      `The vote on ${accusedName} is coming up. Vote LIVES to spare them, DIES to eliminate them.`,
      accusedMention,
    );
    await ctx.scheduler.runAfter(preVoteMs, internal.day.autoAdvanceTrial, {
      gameId: game._id,
      fromSubPhase: 'prevote',
      expectedEndsAt: nextEndsAt,
    });
    return;
  }

  // prevote → vote: open the ballot, seed bot votes, schedule the tally.
  const voteMs = cfg.voteTimerSec * 1000;
  const nextEndsAt = now + voteMs;
  await ctx.db.patch(game._id, {
    currentNomination: {
      ...nom,
      subPhase: 'vote' as const,
      subPhaseEndsAt: nextEndsAt,
      subPhasePausedRemainingMs: undefined,
    },
  });
  await seedBotVotes(ctx, game, nom);
  await ctx.scheduler.runAfter(voteMs + VOTE_GRACE_MS, internal.day.tallyVote, {
    gameId: game._id,
    dayNumber: game.dayNumber,
    nominationIndex: nom.nominationIndex,
    expectedEndsAt: nextEndsAt,
  });
}

// Wave 2: the speaker's SEND during their accusation/defense window posts their
// statement to the village chat AND ends their turn early (advances the trial).
// The client also calls this at the timer to auto-send whatever's typed; the
// server fallback (autoAdvanceTrial) advances even if the client never fires.
export const submitTrialStatement = mutation({
  args: {
    gameId: v.id('games'),
    deviceClientId: v.string(),
    body: v.string(),
  },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game || !isRemote(game) || game.phase !== 'day') return;
    const nom = game.currentNomination;
    if (!nom) return;
    if (nom.subPhasePausedRemainingMs !== undefined) return; // host paused
    const me = await findCaller(ctx, args.gameId, args.deviceClientId);
    if (!me) return;
    const isAccuser =
      nom.subPhase === 'accusation' && nom.accuserPlayerId === me._id;
    const isAccused =
      nom.subPhase === 'defense' && nom.nominatedPlayerId === me._id;
    if (!isAccuser && !isAccused) return; // not the speaker / not their turn

    const body = args.body.trim();
    if (body) {
      await ctx.db.insert('messages', {
        gameId: args.gameId,
        channel: 'village',
        authorPlayerId: me._id,
        authorName: me.name,
        body,
        phaseLabel: `Day ${game.dayNumber}`,
        sentAt: Date.now(),
      });
    }
    await applyTrialAdvance(ctx, game, nom);
  },
});

// Host escape hatch: bypass the 2-tap requirement and put a player on
// trial directly. The host is recorded as BOTH the accuser and seconder
// — solo playtesters need both banner blocks to render so they can see
// the layout, and at a real table the host is functionally vouching for
// the call anyway. Otherwise indistinguishable from a normal trial —
// same accusation timer, same nominations-budget decrement, same wipe
// of in-flight nomTaps. Useful for solo-with-bots testing and as an
// emergency fallback if the table can't get a second tap (e.g. one
// alive villager + bots).
export const hostForceNominate = mutation({
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
      throw new Error('A nomination is already in progress.');
    }
    if (game.pendingTrial) {
      throw new Error('A nomination is being confirmed.');
    }
    const host = await requireHost(
      ctx,
      args.gameId,
      args.callerDeviceClientId,
    );

    const cfg = dayConfigOf(game);
    const now = Date.now();
    const dayExpired =
      game.dayPausedRemainingMs === undefined &&
      game.dayEndsAt !== undefined &&
      now > game.dayEndsAt;
    if (dayExpired) {
      throw new Error('The day has ended — no more nominations.');
    }
    const nominationsUsed = game.nominationsThisDay ?? 0;
    if (nominationsUsed >= cfg.maxNominationsPerDay) {
      throw new Error('No nominations remain for today.');
    }

    // No self-nominate guard here: the host override is a deliberate
    // moderator action, so the host may put anyone on trial — including
    // themselves. (The accused still can't vote on themselves; see castVote.)
    const target = await ctx.db.get(args.targetPlayerId);
    if (!target || target.gameId !== args.gameId) {
      throw new Error('Invalid target.');
    }
    if (!target.alive) throw new Error('Target is already eliminated.');

    await wipeNomTapsForDay(ctx, args.gameId, game.dayNumber);

    await scheduleTrialConfirmDwell(ctx, {
      gameId: args.gameId,
      game,
      now,
      targetPlayerId: args.targetPlayerId,
      accuserPlayerId: host._id,
      seconderPlayerId: host._id,
    });
  },
});

// Host can undo a misheard / mistaken nomination during accusation or
// defense. The nomination slot is refunded so the cancelled trial does not
// count against the day's budget; if the host re-nominates, that fresh call
// to `nominate` decrements as usual. Voting sub-phase is intentionally
// excluded — once votes can be cast, the trial is committed.
export const cancelNomination = mutation({
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
    if (nom.subPhase !== 'accusation' && nom.subPhase !== 'defense') {
      throw new Error('Too late to cancel — voting has already opened.');
    }
    await requireHost(ctx, args.gameId, args.callerDeviceClientId);

    // Defensive: votes can't be cast before the vote sub-phase, but if any
    // stale row exists it would leak into a re-nom that reuses this index.
    const stale = await ctx.db
      .query('nominationVotes')
      .withIndex('by_game_nomination', q =>
        q
          .eq('gameId', args.gameId)
          .eq('dayNumber', game.dayNumber)
          .eq('nominationIndex', nom.nominationIndex),
      )
      .collect();
    for (const row of stale) {
      await ctx.db.delete(row._id);
    }

    // Defensive: trial-start already wiped taps, but any tap that landed
    // after the trial began (shouldn't be possible — toggleNomTap rejects
    // when currentNomination is set — but belt-and-braces) gets cleared
    // here so the next round starts clean.
    await wipeNomTapsForDay(ctx, args.gameId, game.dayNumber);

    const nominationsUsed = game.nominationsThisDay ?? 0;

    // Leave `dayPausedRemainingMs` alone so the day clock stays paused at
    // exactly the value it had when the trial fired. The host then taps
    // the play button on the DayClockBar to resume when the village is
    // ready — gives them a beat to settle the table after the cancel
    // instead of jamming straight back into ticking discussion time.
    await ctx.db.patch(args.gameId, {
      currentNomination: undefined,
      nominationsThisDay: Math.max(0, nominationsUsed - 1),
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
    // The grace tail (VOTE_GRACE_MS past newEndsAt) keeps subPhase === 'vote'
    // long enough to absorb in-flight taps from before the visible 0.
    if (nom.subPhase === 'vote') {
      await ctx.scheduler.runAfter(
        remaining + VOTE_GRACE_MS,
        internal.day.tallyVote,
        {
          gameId: args.gameId,
          dayNumber: game.dayNumber,
          nominationIndex: nom.nominationIndex,
          expectedEndsAt: newEndsAt,
        },
      );
    } else if (
      isRemote(game) &&
      (nom.subPhase === 'accusation' ||
        nom.subPhase === 'defense' ||
        nom.subPhase === 'prevote')
    ) {
      // Remote autopilot: re-arm the sub-phase auto-advance after a host
      // pause/resume so the trial keeps self-driving.
      await ctx.scheduler.runAfter(remaining, internal.day.autoAdvanceTrial, {
        gameId: args.gameId,
        fromSubPhase: nom.subPhase,
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

    // Resetting the VOTE clock also wipes the ballot so the table re-votes from
    // scratch. Real players' votes are cleared and must be re-cast; bots can't
    // tap, so we re-seed their DIES votes immediately (same as when the vote
    // first opens). No votes exist in accusation/defense, so skip those.
    if (nom.subPhase === 'vote') {
      const priorVotes = await ctx.db
        .query('nominationVotes')
        .withIndex('by_game_nomination', q =>
          q
            .eq('gameId', args.gameId)
            .eq('dayNumber', game.dayNumber)
            .eq('nominationIndex', nom.nominationIndex),
        )
        .collect();
      for (const prior of priorVotes) {
        await ctx.db.delete(prior._id);
      }

      const players = await ctx.db
        .query('players')
        .withIndex('by_game', q => q.eq('gameId', args.gameId))
        .collect();
      const aliveBots = players.filter(
        p => p.alive && isBotName(p.name) && p._id !== nom.nominatedPlayerId,
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
    }
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
    // Remote games advance on the autopilot timer — host can't manually end.
    if (isRemote(game)) return;
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
    // Remote games advance on the autopilot timer — host can't manually end.
    if (isRemote(game)) return;
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
    if (nom.subPhase === 'results' || nom.resultsRevealed) {
      throw new Error('Voting has closed.');
    }
    if (nom.subPhase !== 'vote') {
      throw new Error('Voting has not opened yet.');
    }

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
    // The tally is intentionally scheduled VOTE_GRACE_MS past subPhaseEndsAt
    // — see the constant comment. Date-gate matches that schedule.
    if (Date.now() < nom.subPhaseEndsAt + VOTE_GRACE_MS - 100) return;

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

    // Remote autopilot: post the per-voter tally card (who voted which way,
    // like the local results screen) and schedule the resolution (resume day
    // vs. warned nightfall) — no host CONTINUE tap. autoResolveAfterVote waits
    // out the dwell/triggers before acting, then posts the plain outcome below.
    if (isRemote(game)) {
      // Every eligible voter (alive, not the nominee) shows on the card. A
      // DIES vote lands in the red column; anything else — an explicit LIVES
      // OR no vote at all — counts as LIVES (matches the lynch math, where
      // abstentions spare the accused).
      const diesVoterIds = new Set(
        votes.filter(v => v.vote === 'dies').map(v => v.voterPlayerId),
      );
      const eligible = players.filter(
        p => p.alive && p._id !== nom.nominatedPlayerId,
      );
      const livesVoters = eligible
        .filter(p => !diesVoterIds.has(p._id))
        .map(p => p.name);
      const diesVoters = eligible
        .filter(p => diesVoterIds.has(p._id))
        .map(p => p.name);
      const nameById = new Map(players.map(p => [p._id, p.name]));
      await ctx.db.insert('messages', {
        gameId: args.gameId,
        channel: 'village',
        authorName: 'MODERATOR',
        body: '',
        phaseLabel: `Day ${game.dayNumber}`,
        sentAt: Date.now(),
        system: true,
        voteResult: {
          nomineeName: nameById.get(nom.nominatedPlayerId) ?? 'the accused',
          livesVoters,
          diesVoters,
        },
      });
      await ctx.scheduler.runAfter(
        RESULT_READ_MS,
        internal.day.autoResolveAfterVote,
        {
          gameId: args.gameId,
          dayNumber: game.dayNumber,
          nominationIndex: nom.nominationIndex,
        },
      );
    }

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
    // Alpha Wolf: lynching a pack member arms the one-time conversion.
    await flagAlphaConvertIfApplicable(ctx, args.gameId, [targetId]);
    // Doppelganger conversion: deferred reveal at next dawn step.
    await fireDoppelgangerConversionsForDeaths(
      ctx,
      args.gameId,
      game.nightNumber,
      [targetId],
      'day',
    );

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
      // Remote: post the detonation to chat so the village sees who the blast
      // took (the lynch result card only names the bomber). Public death →
      // fair to attribute the blast.
      await postBlastReport(ctx, args.gameId, targetId, blastDead);
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

    // Remote games resolve on the autopilot (autoResolveAfterVote) — the host
    // CONTINUE tap is a no-op there.
    if (isRemote(game)) return;
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
      // Alpha Wolf conversion-night determination (bypasses beginNightWaves).
      await prepareAlphaConvertNight(ctx, args.gameId);
      // Drunk sober-up (start of N3) — bypasses beginNightWaves like the above.
      if (await applyDrunkSoberUp(ctx, args.gameId)) return;
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

// ───── Remote autopilot: post-vote resolution ─────────────────────────────
//
// The remote-mode replacement for the host's CONTINUE GAME tap. Scheduled by
// tallyVote; waits out the trigger-cloak dwell, any pending Hunter decision,
// and any shot announcement (rescheduling itself), then either resumes the day
// (no lynch, time + noms left) or warns the table and queues nightfall.
export const autoResolveAfterVote = internalMutation({
  args: {
    gameId: v.id('games'),
    dayNumber: v.number(),
    nominationIndex: v.number(),
  },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game || !isRemote(game) || game.phase !== 'day') return;
    const nom = game.currentNomination;
    if (
      !nom ||
      nom.nominationIndex !== args.nominationIndex ||
      game.dayNumber !== args.dayNumber ||
      nom.subPhase !== 'results' ||
      !nom.resultsRevealed
    ) {
      return;
    }

    const now = Date.now();
    // Hold until the trigger-cloak dwell, any pending Hunter/HW decision, and
    // any shot announcement have cleared — reschedule ourselves until then.
    if (game.voteDwellEndsAt && now < game.voteDwellEndsAt) {
      await ctx.scheduler.runAfter(
        game.voteDwellEndsAt - now + 50,
        internal.day.autoResolveAfterVote,
        args,
      );
      return;
    }
    if ((game.pendingDeathTriggers?.length ?? 0) > 0) {
      await ctx.scheduler.runAfter(750, internal.day.autoResolveAfterVote, args);
      return;
    }
    if (game.triggerAnnouncement && now < game.triggerAnnouncement.endsAt) {
      await ctx.scheduler.runAfter(
        game.triggerAnnouncement.endsAt - now + 50,
        internal.day.autoResolveAfterVote,
        args,
      );
      return;
    }

    const nominee = await ctx.db.get(nom.nominatedPlayerId as Id<'players'>);
    const wasLynched = !!nominee && !nominee.alive;

    // If this lynch ends the game, skip the "night is falling" beat entirely:
    // post the WIN banner to chat and jump straight to the end-game screen
    // (behind the chat). The banner is the proud result; closing chat → logs.
    if (wasLynched) {
      const won = await applyWinIfReached(ctx, args.gameId);
      if (won) {
        // Announce the deciding elimination FIRST — even a game-ending lynch
        // must be confirmed to the village, not inferred from the win banner
        // (the vote tally alone doesn't say who actually went down).
        await postModeratorMessage(
          ctx,
          game,
          '',
          nominee ? [{ name: nominee.name, id: nominee._id as string }] : undefined,
          `${(nominee?.name ?? 'THE ACCUSED').toUpperCase()} HAS BEEN ELIMINATED`,
          game.revealOnLynch && nominee ? nominee.role : undefined,
        );
        const ended = await ctx.db.get(args.gameId);
        if (ended) await postWinBanner(ctx, ended);
        await ctx.db.patch(args.gameId, {
          currentNomination: undefined,
          voteDwellEndsAt: undefined,
          triggersFollowUp: undefined,
          triggerAnnouncement: undefined,
          phase: 'ended',
          endedAt: Date.now(),
        });
        return;
      }
    }

    const cfg = dayConfigOf(game);
    const noNomsLeft = (game.nominationsThisDay ?? 0) >= cfg.maxNominationsPerDay;
    const dayHasTimeLeft = (game.dayPausedRemainingMs ?? 0) > 0;
    // Day ends → night on: a lynch, the last nomination spent, or the clock
    // having run out (captured as the paused remaining at trial start).
    const goNight = wasLynched || noNomsLeft || !dayHasTimeLeft;

    if (goNight) {
      // Warn first. Keep the nomination in 'results' so the result view stays
      // up and no new nomination can start during the warning window; the
      // scheduled enterNightFromDay clears it and transitions.
      const headline = wasLynched
        ? `${(nominee?.name ?? 'THE ACCUSED').toUpperCase()} HAS BEEN ELIMINATED`
        : 'NO ONE WAS ELIMINATED';
      const detail = wasLynched
        ? 'Night is falling…'
        : 'The day is over — night is falling…';
      const outcomeMentions =
        wasLynched && nominee
          ? [{ name: nominee.name, id: nominee._id as string }]
          : undefined;
      await postModeratorMessage(
        ctx,
        game,
        detail,
        outcomeMentions,
        headline,
        wasLynched && game.revealOnLynch && nominee ? nominee.role : undefined,
      );
      await ctx.scheduler.runAfter(
        NIGHTFALL_WARNING_MS,
        internal.day.enterNightFromDay,
        {
          gameId: args.gameId,
          dayNumber: game.dayNumber,
          nominationIndex: nom.nominationIndex,
        },
      );
      return;
    }

    // No lynch, day still has time + nominations — resume discussion.
    await postModeratorMessage(
      ctx,
      game,
      'Discussion resumes.',
      undefined,
      'NO ONE WAS ELIMINATED',
    );
    await ctx.db.patch(args.gameId, {
      currentNomination: undefined,
      voteDwellEndsAt: undefined,
      triggersFollowUp: undefined,
      triggerAnnouncement: undefined,
      dayEndsAt: now + (game.dayPausedRemainingMs ?? 0),
      dayPausedRemainingMs: undefined,
    });
    await scheduleDayExpiry(ctx, args.gameId);
  },
});

// Remote autopilot: (re)schedule the day-clock expiry check for a running
// clock. Called whenever the day clock starts/resumes. The tick self-validates
// against the current dayEndsAt, so redundant schedules are harmless.
async function scheduleDayExpiry(ctx: MutationCtx, gameId: Id<'games'>) {
  const game = await ctx.db.get(gameId);
  if (!game || !isRemote(game) || game.phase !== 'day') return;
  if (game.dayPausedRemainingMs !== undefined) return; // paused
  if (!game.dayEndsAt) return;
  await ctx.scheduler.runAfter(
    Math.max(0, game.dayEndsAt - Date.now()),
    internal.day.dayClockExpiryTick,
    { gameId, expectedEndsAt: game.dayEndsAt },
  );
}

// Remote autopilot: fires when the discussion clock runs out with no trial in
// flight. Locks the floor (via nightFallsAt → chat lock) and warns before the
// engine moves to night.
export const dayClockExpiryTick = internalMutation({
  args: { gameId: v.id('games'), expectedEndsAt: v.number() },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game || !isRemote(game) || game.phase !== 'day') return;
    if (game.currentNomination || game.pendingTrial) return; // trial → clock paused
    if (game.dayPausedRemainingMs !== undefined) return; // host-paused
    if (game.dayEndsAt !== args.expectedEndsAt) return; // stale/superseded
    if (game.nightFallsAt) return; // already warning
    if (Date.now() < game.dayEndsAt - 100) return; // fired early

    const endsAt = Date.now() + NIGHTFALL_WARNING_MS;
    await ctx.db.patch(args.gameId, { nightFallsAt: endsAt });
    await postModeratorMessage(
      ctx,
      game,
      'No one was put on trial. Night is falling…',
      undefined,
      'THE DAY IS OVER',
    );
    await ctx.scheduler.runAfter(
      NIGHTFALL_WARNING_MS,
      internal.day.enterNightFromDayClock,
      { gameId: args.gameId, expectedNightFallsAt: endsAt },
    );
  },
});

// Remote autopilot: the night transition after a day-clock-expiry warning.
export const enterNightFromDayClock = internalMutation({
  args: { gameId: v.id('games'), expectedNightFallsAt: v.number() },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game || game.phase !== 'day') return;
    if (game.nightFallsAt !== args.expectedNightFallsAt) return;
    if (game.currentNomination) return; // a trial somehow started — abort
    await ctx.db.patch(args.gameId, { nightFallsAt: undefined });
    const won = await applyWinIfReached(ctx, args.gameId);
    if (won) return;
    await ctx.db.patch(args.gameId, {
      phase: 'night',
      nightNumber: game.nightNumber + 1,
    });
    // Alpha Wolf conversion-night determination (this path bypasses
    // beginNightWaves, so stamp it here before the first step activates).
    await prepareAlphaConvertNight(ctx, args.gameId);
    // Drunk sober-up (start of N3) — bypasses beginNightWaves like the above.
    if (await applyDrunkSoberUp(ctx, args.gameId)) return;
    await enterStep(ctx, args.gameId, NIGHT_STEPS[0]);
  },
});

// Remote autopilot: the actual night entry after the nightfall warning window.
// Lynch death/cascades were already applied in tallyVote; this just clears the
// nomination and transitions (or ends the game if the lynch met a win).
export const enterNightFromDay = internalMutation({
  args: {
    gameId: v.id('games'),
    dayNumber: v.number(),
    nominationIndex: v.number(),
  },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game || game.phase !== 'day') return;
    const nom = game.currentNomination;
    if (
      !nom ||
      nom.nominationIndex !== args.nominationIndex ||
      game.dayNumber !== args.dayNumber ||
      nom.subPhase !== 'results'
    ) {
      return;
    }

    await ctx.db.patch(args.gameId, {
      currentNomination: undefined,
      voteDwellEndsAt: undefined,
      triggersFollowUp: undefined,
      triggerAnnouncement: undefined,
    });
    const won = await applyWinIfReached(ctx, args.gameId);
    if (won) return;
    await ctx.db.patch(args.gameId, {
      phase: 'night',
      nightNumber: game.nightNumber + 1,
    });
    // Alpha Wolf conversion-night determination (this path bypasses
    // beginNightWaves, so stamp it here before the first step activates).
    await prepareAlphaConvertNight(ctx, args.gameId);
    // Drunk sober-up (start of N3) — bypasses beginNightWaves like the above.
    if (await applyDrunkSoberUp(ctx, args.gameId)) return;
    await enterStep(ctx, args.gameId, NIGHT_STEPS[0]);
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

    // "Role reveal" variant: when on, day-phase deaths (the lynch + any
    // Hunter/HW/Mad Bomber cascade it triggers) surface the victim's CURRENT
    // role. Off → role stays null and the client renders the plain panel.
    const revealOnLynch = game.revealOnLynch ?? false;

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
      role: string | null;
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
        cascadeDeaths.push({
          _id: p._id,
          name: p.name,
          cause,
          shotByName,
          role: revealOnLynch ? p.role ?? null : null,
        });
      }
    }

    let nomination: {
      nominee: { _id: Id<'players'>; name: string; role: string | null } | null;
      subPhase: 'accusation' | 'defense' | 'prevote' | 'vote' | 'results';
      subPhaseEndsAt: number;
      subPhasePausedRemainingMs: number | null;
      resultsRevealed: boolean;
      votedCount: number;
      eligibleCount: number;
      livesVoters: string[];
      diesVoters: string[];
      myVote: 'lives' | 'dies' | null;
      iAmNominee: boolean;
      accuser: { _id: Id<'players'>; name: string } | null;
      seconder: { _id: Id<'players'>; name: string } | null;
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
            // Vote default: if a player doesn't vote before the timer ends,
            // house rules treat it as a LIVES vote. Keep the display list
            // clean by showing only the player's name.
            livesVoters.push(p.name);
          }
        }
      }

      const eligibleCount = Math.max(0, alive.length - 1);
      const accuser = nom.accuserPlayerId
        ? playerById.get(nom.accuserPlayerId) ?? null
        : null;
      const seconder = nom.seconderPlayerId
        ? playerById.get(nom.seconderPlayerId) ?? null
        : null;
      nomination = {
        nominee: nominee
          ? {
              _id: nominee._id,
              name: nominee.name,
              // Reveal the lynched player's CURRENT role once results are
              // shown and they actually died (results + dead == lynched).
              role:
                revealOnLynch && nom.resultsRevealed && !nominee.alive
                  ? nominee.role ?? null
                  : null,
            }
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
        accuser: accuser ? { _id: accuser._id, name: accuser.name } : null,
        seconder: seconder ? { _id: seconder._id, name: seconder.name } : null,
      };
    }

    // Live nomination-highlight taps, oldest first. Empty during a trial
    // (trial-start wipes them). Drives the discussion-view seating ring:
    // seats with ≥1 tap glow, and the tapper's name renders next to the
    // seat so the table sees who pushed the highlight.
    let nomTaps: Array<{
      targetPlayerId: Id<'players'>;
      nominatorPlayerId: Id<'players'>;
      nominatorName: string;
      isMe: boolean;
      createdAt: number;
    }> = [];
    if (game.phase === 'day' && !game.currentNomination) {
      const tapRows = await ctx.db
        .query('nomTaps')
        .withIndex('by_game_day_target', q =>
          q.eq('gameId', args.gameId).eq('dayNumber', game.dayNumber),
        )
        .collect();
      tapRows.sort((a, b) => a.createdAt - b.createdAt);
      nomTaps = tapRows.map(r => {
        const nominator = playerById.get(r.nominatorPlayerId);
        return {
          targetPlayerId: r.targetPlayerId,
          nominatorPlayerId: r.nominatorPlayerId,
          nominatorName: nominator?.name ?? '???',
          isMe: r.nominatorPlayerId === me._id,
          createdAt: r.createdAt,
        };
      });
    }

    // Trial-confirm dwell (2s between the 2nd tap and the trial actually
    // starting). Surfaces names so DiscussionView can render the seat
    // fill animation + accuser/seconder banner without a second round-trip.
    let pendingTrial: {
      target: { _id: Id<'players'>; name: string };
      accuser: { _id: Id<'players'>; name: string } | null;
      seconder: { _id: Id<'players'>; name: string } | null;
      dwellEndsAt: number;
    } | null = null;
    if (game.pendingTrial) {
      const pt = game.pendingTrial;
      const target = playerById.get(pt.targetPlayerId);
      const accuser = playerById.get(pt.accuserPlayerId) ?? null;
      const seconder = pt.seconderPlayerId
        ? playerById.get(pt.seconderPlayerId) ?? null
        : null;
      if (target) {
        pendingTrial = {
          target: { _id: target._id, name: target.name },
          accuser: accuser ? { _id: accuser._id, name: accuser.name } : null,
          seconder: seconder
            ? { _id: seconder._id, name: seconder.name }
            : null,
          dwellEndsAt: pt.dwellEndsAt,
        };
      }
    }

    return {
      game: {
        _id: game._id,
        roomCode: game.roomCode,
        mode: game.mode ?? 'local',
        phase: game.phase,
        dayNumber: game.dayNumber,
        nightNumber: game.nightNumber,
        winner: game.winner,
        playerCount: game.playerCount,
        selectedRoles: game.selectedRoles,
        voteDwellEndsAt: game.voteDwellEndsAt ?? null,
        revealOnLynch: game.revealOnLynch ?? false,
        revealOnNightDeath: game.revealOnNightDeath ?? false,
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
          preVoteSec: cfg.preVoteSec,
          maxNominationsPerDay: cfg.maxNominationsPerDay,
          wolfPickerSec: cfg.wolfPickerSec,
          nightActionSec: cfg.nightActionSec,
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
      players: players
        .slice()
        .sort((a, b) => (a.seatPosition ?? 0) - (b.seatPosition ?? 0))
        .map(p => ({
          _id: p._id,
          name: p.name,
          seatPosition: p.seatPosition,
          alive: p.alive,
        })),
      currentNomination: nomination,
      pendingTrial,
      nomTaps,
      cascadeDeaths,
      hostMissing: !players.some(p => p.isHost),
    };
  },
});

// Re-export so other modules can use default if needed (no runtime use,
// just type clarity for downstream).
export { DAY_CONFIG_DEFAULTS };
