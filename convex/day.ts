import {
  internalMutation,
  mutation,
  query,
} from './_generated/server';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import {
  findCaller,
  requireHost,
  applyWinIfReached,
  isBotName,
  isTriggerRole,
} from './helpers';
import { enterStep } from './night';
import {
  enqueueTriggersForDeaths,
  processTriggerQueue,
  TRIGGER_DWELL_MS,
} from './triggers';
import { NIGHT_STEPS } from '../src/data/nightOrder';

const DEFAULT_VOTE_TIMER_SEC = 5;

// ───── Mutations ────────────────────────────────────────────────────────────

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

    const target = await ctx.db.get(args.targetPlayerId);
    if (!target || target.gameId !== args.gameId) {
      throw new Error('Invalid target.');
    }
    if (!target.alive) throw new Error('Target is already eliminated.');

    const voteTimerSec = game.voteTimerSec ?? DEFAULT_VOTE_TIMER_SEC;
    const voteTimerMs = voteTimerSec * 1000;
    const nominationIndex = game.nominationsThisDay ?? 0;

    await ctx.db.patch(args.gameId, {
      currentNomination: {
        nominatedPlayerId: args.targetPlayerId,
        voteEndsAt: Date.now() + voteTimerMs,
        resultsRevealed: false,
        nominationIndex,
      },
      nominationsThisDay: nominationIndex + 1,
    });

    // Dev convenience: bots auto-vote DIES so the lynch flow is testable with
    // a single real player. Real games will never have bot players, so this
    // is harmless. The nominee is excluded — they don't vote on themselves.
    const players = await ctx.db
      .query('players')
      .withIndex('by_game', q => q.eq('gameId', args.gameId))
      .collect();
    const aliveBots = players.filter(
      p =>
        p.alive &&
        isBotName(p.name) &&
        p._id !== args.targetPlayerId,
    );
    const now = Date.now();
    for (const bot of aliveBots) {
      await ctx.db.insert('nominationVotes', {
        gameId: args.gameId,
        dayNumber: game.dayNumber,
        nominationIndex,
        voterPlayerId: bot._id,
        vote: 'dies',
        votedAt: now,
      });
    }

    await ctx.scheduler.runAfter(voteTimerMs, internal.day.tallyVote, {
      gameId: args.gameId,
      dayNumber: game.dayNumber,
      nominationIndex,
    });
  },
});

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
    if (nom.resultsRevealed) throw new Error('Voting has closed.');
    if (Date.now() > nom.voteEndsAt) throw new Error('Voting has closed.');

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

export const tallyVote = internalMutation({
  args: {
    gameId: v.id('games'),
    dayNumber: v.number(),
    nominationIndex: v.number(),
  },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game) return;
    if (game.phase !== 'day') return;
    const nom = game.currentNomination;
    if (!nom) return;
    if (nom.nominationIndex !== args.nominationIndex) return;
    if (game.dayNumber !== args.dayNumber) return;
    if (nom.resultsRevealed) return;

    // Compute lynch result. Aligned with the same math as
    // continueGameAfterVote (eligible = alive - 1, no-votes default to LIVES,
    // strict majority of DIES needed to lynch).
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

    // Reveal results + start the host's CONTINUE dwell. The dwell runs
    // regardless of lynch so the host can't infer "trigger role fired"
    // from a slow button-enable.
    await ctx.db.patch(args.gameId, {
      currentNomination: { ...nom, resultsRevealed: true },
      voteDwellEndsAt: Date.now() + TRIGGER_DWELL_MS,
    });

    if (!lynch) return;

    // Apply the lynch death immediately so the trigger actor (if any) can
    // act during the dwell. Their decision is private; host CONTINUE
    // remains locked until the dwell ends and any cascade triggers
    // resolve.
    const targetId = nom.nominatedPlayerId;
    const target = await ctx.db.get(targetId);
    if (!target) return;
    await ctx.db.patch(targetId, { alive: false });
    await ctx.db.insert('nightActions', {
      gameId: args.gameId,
      nightNumber: game.nightNumber,
      actorPlayerId: undefined,
      actionType: 'death',
      targetPlayerId: targetId,
      result: { cause: 'lynch' },
      resolvedAt: Date.now(),
    });

    if (target.role && isTriggerRole(target.role)) {
      // followUp='night' signals processTriggerQueue NOT to auto-finalize
      // on queue-empty — the host's CONTINUE is the gate to night.
      await ctx.db.patch(args.gameId, { triggersFollowUp: 'night' });
      await enqueueTriggersForDeaths(ctx, args.gameId, [targetId]);
      await processTriggerQueue(ctx, args.gameId);
    }
  },
});

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

    // Dwell lock: even on a no-lynch vote, we hold CONTINUE for the dwell
    // so the host can't tell from button-timing whether a trigger fired.
    // The lynch death + trigger queue (if any) were already applied in
    // tallyVote; we just gate the transition here.
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
    // Lynch is encoded in the nominee's alive=false state (set in
    // tallyVote). Trigger cascades during the day only kill OTHER players,
    // so the nominee can only have died here from the lynch itself.
    const wasLynched = !!nominee && !nominee.alive;

    await ctx.db.patch(args.gameId, {
      currentNomination: undefined,
      voteDwellEndsAt: undefined,
      triggersFollowUp: undefined,
      triggerAnnouncement: undefined,
    });

    if (!wasLynched) return;

    const won = await applyWinIfReached(ctx, args.gameId);
    if (won) return;

    await ctx.db.patch(args.gameId, {
      phase: 'night',
      nightNumber: game.nightNumber + 1,
    });
    await enterStep(ctx, args.gameId, NIGHT_STEPS[0]);
  },
});

// ───── Query ────────────────────────────────────────────────────────────────

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

    // Cascade deaths from THIS lynch (Hunter/HW shot, MD blast). The lynch
    // tally row uses cause='lynch' and is excluded — the lynchee is
    // already shown in the result pill above the votes. We filter by
    // resolvedAt >= the moment the lynch tally began (voteDwellEndsAt -
    // TRIGGER_DWELL_MS) to avoid pulling in earlier cascade rows from
    // the same nightNumber (e.g., a Hunter who died at night and shot
    // someone during the morning trigger phase on this same day).
    let cascadeDeaths: Array<{
      _id: Id<'players'>;
      name: string;
      cause: string;
    }> = [];
    if (
      game.currentNomination?.resultsRevealed &&
      game.voteDwellEndsAt != null
    ) {
      const lynchStart = game.voteDwellEndsAt - TRIGGER_DWELL_MS;
      const rows = await ctx.db
        .query('nightActions')
        .withIndex('by_game_night', q =>
          q.eq('gameId', args.gameId).eq('nightNumber', game.nightNumber),
        )
        .filter(q => q.eq(q.field('actionType'), 'death'))
        .collect();
      for (const r of rows) {
        if (r.resolvedAt < lynchStart) continue;
        const cause = (r.result?.cause as string | undefined) ?? '';
        if (cause === 'lynch' || cause === '') continue;
        if (!r.targetPlayerId) continue;
        const p = playerById.get(r.targetPlayerId);
        if (!p) continue;
        cascadeDeaths.push({ _id: p._id, name: p.name, cause });
      }
    }

    let nomination: {
      nominee: { _id: Id<'players'>; name: string } | null;
      voteEndsAt: number;
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
        // Alive non-voters defaulted to LIVES — but the nominee doesn't vote
        // and isn't counted on either side.
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
        voteEndsAt: nom.voteEndsAt,
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
        voteDwellEndsAt: game.voteDwellEndsAt ?? null,
        pendingTriggerCount: game.pendingDeathTriggers?.length ?? 0,
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
