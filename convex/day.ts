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
} from './helpers';
import { enterStep } from './night';
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
    // is harmless. Without this, a 1-real + 3-bots game can never reach a
    // majority because bots default to LIVES.
    const players = await ctx.db
      .query('players')
      .withIndex('by_game', q => q.eq('gameId', args.gameId))
      .collect();
    const aliveBots = players.filter(p => p.alive && isBotName(p.name));
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

    await ctx.db.patch(args.gameId, {
      currentNomination: { ...nom, resultsRevealed: true },
    });
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

    // Tally votes. Alive players who didn't vote default to LIVES.
    const players = await ctx.db
      .query('players')
      .withIndex('by_game', q => q.eq('gameId', args.gameId))
      .collect();
    const aliveCount = players.filter(p => p.alive).length;

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
    const lives = aliveCount - dies; // unvoted treated as LIVES

    // Strict majority of DIES → lynch. Ties default to LIVES (per house rules).
    const lynch = dies > lives;

    if (!lynch) {
      // No lynch — day continues; clear the nomination so another can be
      // started.
      await ctx.db.patch(args.gameId, {
        currentNomination: undefined,
      });
      return;
    }

    // Lynch: nominee dies. Win check, then transition straight to night.
    const targetId = nom.nominatedPlayerId as Id<'players'>;
    await ctx.db.patch(targetId, { alive: false });
    await ctx.db.patch(args.gameId, {
      currentNomination: undefined,
    });

    const won = await applyWinIfReached(ctx, args.gameId);
    if (won) return; // phase already set to 'ended'

    // Lynch ends the day → night begins.
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

    let nomination: {
      nominee: { _id: Id<'players'>; name: string } | null;
      voteEndsAt: number;
      resultsRevealed: boolean;
      votedCount: number;
      aliveCount: number;
      livesVoters: string[];
      diesVoters: string[];
      myVote: 'lives' | 'dies' | null;
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
        // Alive non-voters defaulted to LIVES.
        const votedIds = new Set(allVotes.map(v => v.voterPlayerId));
        for (const p of alive) {
          if (!votedIds.has(p._id)) {
            livesVoters.push(`${p.name} (no vote)`);
          }
        }
      }

      nomination = {
        nominee: nominee
          ? { _id: nominee._id, name: nominee.name }
          : null,
        voteEndsAt: nom.voteEndsAt,
        resultsRevealed: nom.resultsRevealed,
        votedCount: allVotes.length,
        aliveCount: alive.length,
        livesVoters,
        diesVoters,
        myVote,
      };
    }

    return {
      game: {
        _id: game._id,
        phase: game.phase,
        dayNumber: game.dayNumber,
        nightNumber: game.nightNumber,
        winner: game.winner,
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
    };
  },
});
