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
  isBotName,
  recordWinIfReached,
} from './helpers';
import { isWolfTeam, seerSees, WOLF_TEAM_ROLES } from '../src/data/v1Roles';
import {
  NIGHT_STEPS,
  isNightStep,
  nextNightStep,
  nightStepLabel,
  type NightStep,
} from '../src/data/nightOrder';

type Player = Doc<'players'>;

// ───── Dwell timing ─────────────────────────────────────────────────────────
//
// Each night step is held in place for a randomized minimum duration before
// advancing. This cloaks dead actors (which would otherwise auto-skip
// instantly) and fast-acting alive actors (which would otherwise resolve in
// 1–2 seconds), making every step's wall-clock duration look similar.
//
// Dwell starts when the step is entered. If a real player's action lands
// before the deadline, the step still holds until the deadline. A scheduled
// `dwellTick` runs at the deadline and advances if conditions are met.

const STEP_DWELL_MIN_MS = 6000;
const STEP_DWELL_MAX_MS = 12000;

function randomDwellMs(): number {
  return (
    STEP_DWELL_MIN_MS +
    Math.floor(Math.random() * (STEP_DWELL_MAX_MS - STEP_DWELL_MIN_MS))
  );
}

// ───── Step membership ──────────────────────────────────────────────────────

function activePlayersForStep(step: NightStep, alive: Player[]): Player[] {
  switch (step) {
    case 'wolves':
      return alive.filter(p => p.role && isWolfTeam(p.role));
    case 'seer':
      return alive.filter(p => p.role === 'Seer');
  }
}

/**
 * Whether a given step's role(s) appear in the game's selected role list.
 * If not, the step is publicly known to be empty (the host's role choice is
 * not secret) and we skip immediately rather than fake-waking. If a role IS
 * picked but the actor has died, we still dwell — that's the case we cloak.
 */
function stepIsInGame(step: NightStep, selectedRoles: string[]): boolean {
  const set = new Set(selectedRoles);
  switch (step) {
    case 'wolves':
      return [...WOLF_TEAM_ROLES].some(r => set.has(r));
    case 'seer':
      return set.has('Seer');
  }
}

// ───── Step completion ──────────────────────────────────────────────────────

async function getNightActions(
  ctx: MutationCtx,
  gameId: Id<'games'>,
  nightNumber: number,
  actionType?: string,
) {
  const all = await ctx.db
    .query('nightActions')
    .withIndex('by_game_night', q =>
      q.eq('gameId', gameId).eq('nightNumber', nightNumber),
    )
    .collect();
  return actionType ? all.filter(a => a.actionType === actionType) : all;
}

async function isStepComplete(
  ctx: MutationCtx,
  gameId: Id<'games'>,
  step: NightStep,
  actors: Player[],
  nightNumber: number,
): Promise<boolean> {
  switch (step) {
    case 'wolves': {
      const kills = await getNightActions(ctx, gameId, nightNumber, 'wolf_kill');
      return kills.length > 0;
    }
    case 'seer': {
      const checks = await getNightActions(ctx, gameId, nightNumber, 'seer_check');
      return checks.length >= actors.length;
    }
  }
}

// ───── Bot auto-resolve ─────────────────────────────────────────────────────

function pickRandom<T>(items: readonly T[]): T | undefined {
  if (items.length === 0) return undefined;
  return items[Math.floor(Math.random() * items.length)];
}

async function autoResolveStep(
  ctx: MutationCtx,
  gameId: Id<'games'>,
  step: NightStep,
  actors: Player[],
  alivePlayers: Player[],
  nightNumber: number,
) {
  const now = Date.now();
  switch (step) {
    case 'wolves': {
      const candidates = alivePlayers.filter(p => !isWolfTeam(p.role || ''));
      const target = pickRandom(candidates);
      if (!target) return;
      for (const wolf of actors) {
        await ctx.db.patch(wolf._id, {
          roleState: { ...(wolf.roleState ?? {}), wolfVote: target._id },
        });
      }
      await ctx.db.insert('nightActions', {
        gameId,
        nightNumber,
        actorPlayerId: actors[0]._id,
        actionType: 'wolf_kill',
        targetPlayerId: target._id,
        resolvedAt: now,
      });
      return;
    }
    case 'seer': {
      const seer = actors[0];
      const candidates = alivePlayers.filter(p => p._id !== seer._id);
      const target = pickRandom(candidates);
      if (!target) return;
      const team = seerSees(target.role || '');
      await ctx.db.insert('nightActions', {
        gameId,
        nightNumber,
        actorPlayerId: seer._id,
        actionType: 'seer_check',
        targetPlayerId: target._id,
        result: { team },
        resolvedAt: now,
      });
      return;
    }
  }
}

// ───── Morning resolution ───────────────────────────────────────────────────

async function resolveMorning(
  ctx: MutationCtx,
  gameId: Id<'games'>,
  nightNumber: number,
) {
  const now = Date.now();

  // Phase 3a: only the wolf kill is a death source. Future phases layer in
  // BG protection, Diseased blocking, Witch save/poison, etc., before deaths
  // are committed.
  const kills = await getNightActions(ctx, gameId, nightNumber, 'wolf_kill');
  for (const kill of kills) {
    if (!kill.targetPlayerId) continue;
    const target = await ctx.db.get(kill.targetPlayerId);
    if (!target || !target.alive) continue;
    await ctx.db.patch(kill.targetPlayerId, { alive: false });
    await ctx.db.insert('nightActions', {
      gameId,
      nightNumber,
      actorPlayerId: undefined,
      actionType: 'death',
      targetPlayerId: kill.targetPlayerId,
      result: { cause: 'wolf' },
      resolvedAt: now,
    });
  }

  // Clear per-night ephemeral roleState so next night starts clean.
  const players = await ctx.db
    .query('players')
    .withIndex('by_game', q => q.eq('gameId', gameId))
    .collect();
  for (const p of players) {
    if (p.roleState && 'wolfVote' in p.roleState) {
      const next = { ...p.roleState };
      delete next.wolfVote;
      await ctx.db.patch(p._id, { roleState: next });
    }
  }

  // Record winner if a win has been reached, but always show morning so the
  // death announcement plays out narratively. The game-over transition
  // happens when the host taps BEGIN DAY (or VIEW RESULTS).
  await ctx.db.patch(gameId, {
    phase: 'morning',
    nightStep: undefined,
  });
  await recordWinIfReached(ctx, gameId);
}

// ───── Step engine ──────────────────────────────────────────────────────────
//
// The engine has three primitives:
//
//   enterStep(step)              — set up a step and start its dwell timer
//   maybeAdvance()               — advance now if step is complete + dwell over
//   advanceFromCurrentStep()     — move to next step or resolve morning
//
// Plus a scheduled internal mutation `dwellTick` that fires when each step's
// dwell deadline arrives. After every state change (action submitted, step
// entered, dwell elapsed), one of these checks runs, and whichever sees the
// "complete + elapsed" condition is the one that actually advances. The
// others are no-ops, so concurrent triggers don't double-advance.

export async function enterStep(
  ctx: MutationCtx,
  gameId: Id<'games'>,
  step: NightStep,
): Promise<void> {
  const game = await ctx.db.get(gameId);
  if (!game || game.phase !== 'night') return;

  // Roles not in the role list are publicly known to be empty — skip
  // immediately rather than fake-waking. Cloaking only matters when the role
  // *might* be present.
  if (!stepIsInGame(step, game.selectedRoles)) {
    const next = nextNightStep(step);
    if (next) {
      await enterStep(ctx, gameId, next);
    } else {
      await resolveMorning(ctx, gameId, game.nightNumber);
    }
    return;
  }

  const dwellMs = randomDwellMs();
  const endsAt = Date.now() + dwellMs;
  await ctx.db.patch(gameId, {
    nightStep: step,
    nightStepEndsAt: endsAt,
  });

  // If the active actors are all bots (or there are none), perform their
  // action immediately so the action is recorded by the time the dwell ends.
  // The dwell still has to elapse before the engine advances.
  const players = await ctx.db
    .query('players')
    .withIndex('by_game', q => q.eq('gameId', gameId))
    .collect();
  const alive = players.filter(p => p.alive);
  const actors = activePlayersForStep(step, alive);

  if (actors.length > 0 && actors.every(a => isBotName(a.name))) {
    await autoResolveStep(ctx, gameId, step, actors, alive, game.nightNumber);
  }

  // Schedule the dwell-end tick. If a real player acts before then, their
  // action triggers `maybeAdvance` directly — which will see dwell not yet
  // elapsed and defer to this scheduled tick.
  await ctx.scheduler.runAfter(dwellMs, internal.night.dwellTick, {
    gameId,
    expectedStep: step,
  });
}

export async function maybeAdvance(
  ctx: MutationCtx,
  gameId: Id<'games'>,
): Promise<void> {
  const game = await ctx.db.get(gameId);
  if (!game || game.phase !== 'night') return;

  const step = isNightStep(game.nightStep) ? game.nightStep : undefined;
  if (!step) return;

  const players = await ctx.db
    .query('players')
    .withIndex('by_game', q => q.eq('gameId', gameId))
    .collect();
  const alive = players.filter(p => p.alive);
  const actors = activePlayersForStep(step, alive);

  if (!(await isStepComplete(ctx, gameId, step, actors, game.nightNumber))) {
    return;
  }

  if (Date.now() < (game.nightStepEndsAt ?? 0)) {
    return; // dwell still active
  }

  await advanceFromCurrentStep(ctx, gameId);
}

async function advanceFromCurrentStep(
  ctx: MutationCtx,
  gameId: Id<'games'>,
): Promise<void> {
  const game = await ctx.db.get(gameId);
  if (!game) return;
  const step = isNightStep(game.nightStep) ? game.nightStep : undefined;
  if (!step) return;
  const next = nextNightStep(step);
  if (next) {
    await enterStep(ctx, gameId, next);
  } else {
    await resolveMorning(ctx, gameId, game.nightNumber);
  }
}

export const dwellTick = internalMutation({
  args: {
    gameId: v.id('games'),
    expectedStep: v.string(),
  },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game || game.phase !== 'night') return;
    // Ignore stale ticks — if the step has already advanced (e.g., a fast
    // real-player action after the dwell), there's a phantom scheduled call
    // for the previous step that should be a no-op.
    if (game.nightStep !== args.expectedStep) return;
    await maybeAdvance(ctx, args.gameId);
  },
});

// ───── Mutations ────────────────────────────────────────────────────────────

export const submitWolfVote = mutation({
  args: {
    gameId: v.id('games'),
    callerDeviceClientId: v.string(),
    targetPlayerId: v.id('players'),
  },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game) throw new Error('Game not found.');
    if (game.phase !== 'night' || game.nightStep !== 'wolves') {
      throw new Error('Wolves are not currently awake.');
    }

    const me = await findCaller(ctx, args.gameId, args.callerDeviceClientId);
    if (!me) throw new Error('You are not in this game.');
    if (!me.alive) throw new Error('You are eliminated.');
    if (!me.role || !isWolfTeam(me.role)) {
      throw new Error('Only wolves can vote during the wolf phase.');
    }

    const target = await ctx.db.get(args.targetPlayerId);
    if (!target || target.gameId !== args.gameId) {
      throw new Error('Invalid target.');
    }
    if (!target.alive) throw new Error('Target is already eliminated.');
    if (isWolfTeam(target.role || '')) {
      throw new Error('Wolves cannot kill each other.');
    }

    await ctx.db.patch(me._id, {
      roleState: { ...(me.roleState ?? {}), wolfVote: args.targetPlayerId },
    });

    // Bot wolves follow the most recent real-wolf vote so single-tester games
    // can reach consensus without 5 humans.
    const players = await ctx.db
      .query('players')
      .withIndex('by_game', q => q.eq('gameId', args.gameId))
      .collect();
    const aliveWolves = players.filter(
      p => p.alive && p.role && isWolfTeam(p.role),
    );
    for (const w of aliveWolves) {
      if (w._id === me._id) continue;
      if (isBotName(w.name)) {
        await ctx.db.patch(w._id, {
          roleState: { ...(w.roleState ?? {}), wolfVote: args.targetPlayerId },
        });
      }
    }

    // Re-fetch wolves with updated state and check consensus.
    const refreshed = await ctx.db
      .query('players')
      .withIndex('by_game', q => q.eq('gameId', args.gameId))
      .collect();
    const wolvesNow = refreshed.filter(
      p => p.alive && p.role && isWolfTeam(p.role),
    );
    const votes = wolvesNow.map(w => w.roleState?.wolfVote as
      | Id<'players'>
      | undefined);
    const consensus =
      votes.length > 0 && votes.every(v => v && v === votes[0]);

    if (consensus) {
      await ctx.db.insert('nightActions', {
        gameId: args.gameId,
        nightNumber: game.nightNumber,
        actorPlayerId: me._id,
        actionType: 'wolf_kill',
        targetPlayerId: args.targetPlayerId,
        resolvedAt: Date.now(),
      });
      // Try to advance immediately. If the dwell hasn't elapsed yet,
      // maybeAdvance is a no-op and the scheduled dwellTick handles it.
      await maybeAdvance(ctx, args.gameId);
    }
  },
});

export const submitSeerCheck = mutation({
  args: {
    gameId: v.id('games'),
    callerDeviceClientId: v.string(),
    targetPlayerId: v.id('players'),
  },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game) throw new Error('Game not found.');
    if (game.phase !== 'night' || game.nightStep !== 'seer') {
      throw new Error('The Seer is not currently awake.');
    }

    const me = await findCaller(ctx, args.gameId, args.callerDeviceClientId);
    if (!me?.alive || me.role !== 'Seer') {
      throw new Error('Only the Seer can check.');
    }

    const target = await ctx.db.get(args.targetPlayerId);
    if (!target || target.gameId !== args.gameId) {
      throw new Error('Invalid target.');
    }
    if (target._id === me._id) throw new Error('Cannot check yourself.');
    if (!target.alive) throw new Error('Target is eliminated.');

    const team = seerSees(target.role || '');

    await ctx.db.insert('nightActions', {
      gameId: args.gameId,
      nightNumber: game.nightNumber,
      actorPlayerId: me._id,
      actionType: 'seer_check',
      targetPlayerId: args.targetPlayerId,
      result: { team },
      resolvedAt: Date.now(),
    });

    // Intentionally do NOT advance the step here — the Seer needs to read
    // their result before the screen swaps to Morning. The client calls
    // `tickNight` after the player taps OK on the result modal. Returning
    // the team lets the client display the result without a query roundtrip.
    return { team };
  },
});

/**
 * Idempotent advance — anyone can call it; the engine only moves forward
 * when the current step is complete AND the dwell deadline has passed.
 * Used after info-role acts (currently just the Seer) where the player
 * needs a moment to read the result before the night ends.
 */
export const tickNight = mutation({
  args: {
    gameId: v.id('games'),
    callerDeviceClientId: v.string(),
  },
  handler: async (ctx, args) => {
    const me = await findCaller(ctx, args.gameId, args.callerDeviceClientId);
    if (!me) throw new Error('You are not in this game.');
    await maybeAdvance(ctx, args.gameId);
  },
});

export const beginNight = mutation({
  args: {
    gameId: v.id('games'),
    callerDeviceClientId: v.string(),
  },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game) throw new Error('Game not found.');
    if (game.phase !== 'day') throw new Error('Not currently in day.');

    await requireHost(ctx, args.gameId, args.callerDeviceClientId);

    await ctx.db.patch(args.gameId, {
      phase: 'night',
      nightNumber: game.nightNumber + 1,
    });
    await enterStep(ctx, args.gameId, NIGHT_STEPS[0]);
  },
});

export const beginDay = mutation({
  args: {
    gameId: v.id('games'),
    callerDeviceClientId: v.string(),
  },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game) throw new Error('Game not found.');
    if (game.phase !== 'morning') throw new Error('Not currently in morning.');

    await requireHost(ctx, args.gameId, args.callerDeviceClientId);

    // If a winner was recorded during morning resolution, jump to the
    // end-game screen instead of starting the next day.
    if (game.winner) {
      await ctx.db.patch(args.gameId, {
        phase: 'ended',
        endedAt: Date.now(),
      });
      return;
    }

    await ctx.db.patch(args.gameId, {
      phase: 'day',
      dayNumber: game.dayNumber + 1,
    });
  },
});

// ───── Queries ──────────────────────────────────────────────────────────────

export const nightView = query({
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

    const alive = players.filter(p => p.alive);
    const step = isNightStep(game.nightStep) ? game.nightStep : undefined;

    let isMyStep = false;
    if (step && me.alive && me.role) {
      const actors = activePlayersForStep(step, alive);
      isMyStep = actors.some(a => a._id === me._id);
    }

    // Wolf-step live state: only visible to wolves (so non-wolves can't peek
    // at who's been chosen).
    let wolfState:
      | {
          wolves: Array<{
            _id: Id<'players'>;
            name: string;
            role: string;
            isMe: boolean;
            currentVote?: Id<'players'>;
          }>;
        }
      | null = null;
    if (step === 'wolves' && me.role && isWolfTeam(me.role)) {
      const aliveWolves = alive.filter(p => p.role && isWolfTeam(p.role));
      wolfState = {
        wolves: aliveWolves.map(w => ({
          _id: w._id,
          name: w.name,
          role: w.role!,
          isMe: w._id === me._id,
          currentVote: w.roleState?.wolfVote as Id<'players'> | undefined,
        })),
      };
    }

    // Seer's running history of checks (only visible to the Seer).
    let seerHistory: Array<{
      nightNumber: number;
      targetName: string;
      team: 'wolf' | 'villager';
    }> | null = null;
    if (me.role === 'Seer') {
      const checks = await ctx.db
        .query('nightActions')
        .withIndex('by_game_night', q => q.eq('gameId', args.gameId))
        .collect();
      const playerById = new Map(players.map(p => [p._id, p]));
      seerHistory = checks
        .filter(c => c.actorPlayerId === me._id && c.actionType === 'seer_check')
        .sort((a, b) => a.nightNumber - b.nightNumber)
        .map(c => ({
          nightNumber: c.nightNumber,
          targetName: c.targetPlayerId
            ? playerById.get(c.targetPlayerId)?.name ?? 'unknown'
            : 'unknown',
          team: (c.result?.team as 'wolf' | 'villager') ?? 'villager',
        }));
    }

    let targetables: Array<{
      _id: Id<'players'>;
      name: string;
      seatPosition?: number;
    }> = [];
    if (isMyStep && step) {
      let pool: Player[] = [];
      if (step === 'wolves') {
        pool = alive.filter(p => !isWolfTeam(p.role || ''));
      } else if (step === 'seer') {
        pool = alive.filter(p => p._id !== me._id);
      }
      targetables = pool
        .sort((a, b) => (a.seatPosition ?? 0) - (b.seatPosition ?? 0))
        .map(p => ({
          _id: p._id,
          name: p.name,
          seatPosition: p.seatPosition,
        }));
    }

    return {
      game: {
        _id: game._id,
        phase: game.phase,
        nightNumber: game.nightNumber,
        nightStep: step,
      },
      me: {
        _id: me._id,
        name: me.name,
        role: me.role,
        alive: me.alive,
        isHost: me.isHost,
        seatPosition: me.seatPosition,
      },
      isMyStep,
      stepLabel: step ? nightStepLabel(step) : null,
      wolfState,
      seerHistory,
      targetables,
    };
  },
});

export const morningView = query({
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

    const deathActions = await ctx.db
      .query('nightActions')
      .withIndex('by_game_night', q =>
        q.eq('gameId', args.gameId).eq('nightNumber', game.nightNumber),
      )
      .filter(q => q.eq(q.field('actionType'), 'death'))
      .collect();

    const playerById = new Map(players.map(p => [p._id, p]));
    const deaths = deathActions
      .map(a => (a.targetPlayerId ? playerById.get(a.targetPlayerId) : null))
      .filter((p): p is Player => !!p)
      .map(p => ({
        _id: p._id,
        name: p.name,
        seatPosition: p.seatPosition,
      }));

    return {
      game: {
        _id: game._id,
        phase: game.phase,
        nightNumber: game.nightNumber,
        dayNumber: game.dayNumber,
        winner: game.winner ?? null,
      },
      me: {
        _id: me._id,
        name: me.name,
        isHost: me.isHost,
      },
      deaths,
    };
  },
});
