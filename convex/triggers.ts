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
  isBotName,
  isTriggerRole,
  applyWinIfReached,
  initializeDayClock,
  flagCubDeathIfApplicable,
  type TriggerRole,
} from './helpers';
import { enterStep, fireDoppelgangerConversionsForDeaths } from './night';
import { NIGHT_STEPS } from '../src/data/nightOrder';

type Player = Doc<'players'>;
type TriggerEntry = {
  playerId: Id<'players'>;
  role: TriggerRole;
};

// 10-second decision window per trigger head. Same value used as the lynch
// vote dwell so all "is a trigger acting?" cloaks share one feel.
export const TRIGGER_DWELL_MS = 10_000;

// How long a public trigger result (Hunter shot) stays on every phone
// before the queue advances. Long enough to read but short enough that
// the table doesn't lose momentum.
const ANNOUNCEMENT_MS = 4_000;

async function setAnnouncementAndSchedule(
  ctx: MutationCtx,
  gameId: Id<'games'>,
  lines: readonly string[],
): Promise<void> {
  const endsAt = Date.now() + ANNOUNCEMENT_MS;
  await ctx.db.patch(gameId, {
    triggerAnnouncement: { lines: [...lines], endsAt },
    triggerEndsAt: undefined, // close the actor's decision window
  });
  await ctx.scheduler.runAfter(ANNOUNCEMENT_MS, internal.triggers.announcementTick, {
    gameId,
    expectedEndsAt: endsAt,
  });
}

// ───── Queue manipulation ───────────────────────────────────────────────────

/**
 * Append triggers for any of the given player IDs whose role is a trigger
 * role (Hunter / Hunter Wolf). Does not start processing; caller invokes
 * `processTriggerQueue` after.
 */
export async function enqueueTriggersForDeaths(
  ctx: MutationCtx,
  gameId: Id<'games'>,
  deadIds: readonly Id<'players'>[],
): Promise<void> {
  if (deadIds.length === 0) return;
  const game = await ctx.db.get(gameId);
  if (!game) return;
  let queue: TriggerEntry[] = [...(game.pendingDeathTriggers ?? [])];
  let mutated = false;
  for (const id of deadIds) {
    const p = await ctx.db.get(id);
    if (!p || !isTriggerRole(p.role)) continue;
    // De-dupe: defensive guard against the same player landing in the queue
    // twice if multiple kill sources hit them in the same pass.
    if (queue.some(q => q.playerId === id)) continue;
    queue.push({ playerId: id, role: p.role });
    mutated = true;
  }
  if (mutated) {
    await ctx.db.patch(gameId, { pendingDeathTriggers: queue });
  }
}

// ───── Mad Bomber blast ─────────────────────────────────────────────────────
//
// Seats are laid out clockwise on screen (seat 0 at top, indices increasing
// clockwise). From the player's POV (facing the center):
//   right = seat (X-1+N) % N  → walking right = step -1
//   left  = seat (X+1)   % N  → walking left  = step +1
// On the bomber's death, both adjacent alive players die (the bomb skips
// dead seats — nearest alive neighbor in each direction). Night
// protections (BG, witch) DO NOT save the neighbors: those protections
// only block night-source attacks, and the explosion is a fresh
// trigger-tier death at the moment the bomber goes down.

/**
 * Detonate a Mad Bomber. Kills the nearest alive seat-neighbor in each
 * direction (left + right, skipping dead seats), inserts a single
 * `mad_bomber_kill` action row for end-game history, and recursively
 * detonates any victim who is themselves a Mad Bomber. Returns the list
 * of players killed by this blast (and any cascading blasts).
 */
export async function applyMadBomberBlast(
  ctx: MutationCtx,
  gameId: Id<'games'>,
  nightNumber: number,
  bomberId: Id<'players'>,
): Promise<Id<'players'>[]> {
  const bomber = await ctx.db.get(bomberId);
  if (!bomber || typeof bomber.seatPosition !== 'number') return [];
  const game = await ctx.db.get(gameId);
  if (!game) return [];

  const all = await ctx.db
    .query('players')
    .withIndex('by_game', q => q.eq('gameId', gameId))
    .collect();
  const bySeat = new Map<number, Player>();
  for (const p of all) {
    if (typeof p.seatPosition === 'number') bySeat.set(p.seatPosition, p);
  }

  const startSeat = bomber.seatPosition;
  const total = game.playerCount;
  const victimIds: Id<'players'>[] = [];

  // Nearest alive neighbor in each direction. 2-player edge case dedupes
  // below via Set — left and right resolve to the same player.
  for (const step of [-1, 1]) {
    let cursor = startSeat;
    for (let i = 0; i < total; i++) {
      cursor = ((cursor + step) % total + total) % total;
      if (cursor === startSeat) break;
      const p = bySeat.get(cursor);
      if (!p || !p.alive) continue;
      victimIds.push(p._id);
      break;
    }
  }
  const uniqueVictimIds = Array.from(new Set(victimIds));

  // Record the blast row up front (even if zero victims — useful for
  // end-game history to show the bomber detonated but nobody was left).
  await ctx.db.insert('nightActions', {
    gameId,
    nightNumber,
    actorPlayerId: bomberId,
    actionType: 'mad_bomber_kill',
    result: { victimIds: uniqueVictimIds },
    resolvedAt: Date.now(),
  });

  const newlyDead: Id<'players'>[] = [];
  for (const vid of uniqueVictimIds) {
    const killed = await applyTriggerDeath(
      ctx,
      gameId,
      nightNumber,
      vid,
      'mad-bomber',
    );
    if (killed) newlyDead.push(vid);
  }

  // Chain reaction: a victim who is themselves a bomber detonates too.
  // Iterate over a snapshot so the recursion's newlyDead can extend the
  // outer list.
  const snapshot = [...newlyDead];
  for (const vid of snapshot) {
    const p = await ctx.db.get(vid);
    if (p?.role === 'Mad Bomber') {
      const chainDead = await applyMadBomberBlast(ctx, gameId, nightNumber, vid);
      newlyDead.push(...chainDead);
    }
  }

  return newlyDead;
}

// ───── Kill resolution + cascade ────────────────────────────────────────────

/**
 * Mark a player dead from a trigger action, write a death row, and queue
 * their trigger if they're a trigger role themselves (cascade). Returns true
 * if the player was actually killed (i.e., they were alive). Hunter / Mad
 * Bomber kills bypass BG and witch saves — those only apply to night-source
 * deaths. Exported because `applyMadBomberBlast` reuses it.
 */
export async function applyTriggerDeath(
  ctx: MutationCtx,
  gameId: Id<'games'>,
  nightNumber: number,
  targetId: Id<'players'>,
  cause: string,
): Promise<boolean> {
  const target = await ctx.db.get(targetId);
  if (!target || !target.alive) return false;
  // followUp === 'night' means the trigger is cascading from a lynch on the
  // current day; everything else (morning / day) is a night-source cascade.
  const game = await ctx.db.get(gameId);
  const result: Record<string, unknown> = { cause };
  if (game?.triggersFollowUp === 'night') {
    result.phase = 'day';
    result.dayNumber = game.dayNumber;
  } else {
    result.phase = 'night';
  }
  await ctx.db.patch(targetId, { alive: false });
  await ctx.db.insert('nightActions', {
    gameId,
    nightNumber,
    actorPlayerId: undefined,
    actionType: 'death',
    targetPlayerId: targetId,
    result,
    resolvedAt: Date.now(),
  });
  // Wolf Cub vengeance: if the cub died from a Hunter/HW shot or an MB
  // cascade, remaining wolves get 2 kills on the next wolves step.
  await flagCubDeathIfApplicable(ctx, gameId, [targetId]);
  // Trigger-phase deaths always defer the Doppelganger reveal to the next
  // dawn step (per house rule, morning/day eliminations hide their tell
  // until everyone is asleep again).
  await fireDoppelgangerConversionsForDeaths(
    ctx,
    gameId,
    nightNumber,
    [targetId],
    'day',
  );
  return true;
}

// ───── Queue processing ─────────────────────────────────────────────────────

/**
 * Walk the trigger queue: auto-skip bot heads, then either (a) stop on the
 * first real-player head, setting a fresh 10 s dwell and scheduling the
 * auto-tick, or (b) call `finalizeTriggerPhase` if the queue empties.
 */
export async function processTriggerQueue(
  ctx: MutationCtx,
  gameId: Id<'games'>,
): Promise<void> {
  while (true) {
    const game = await ctx.db.get(gameId);
    if (!game) return;
    // Trigger flow runs in 'triggers' phase (night context, Case B) and
    // 'day' phase (lynch context, during the vote dwell).
    if (game.phase !== 'triggers' && game.phase !== 'day') return;
    const queue = [...(game.pendingDeathTriggers ?? [])];
    if (queue.length === 0) {
      // Lynch context: don't auto-transition — the host's CONTINUE button
      // is the gate to night, and the dwell may still be running.
      if (game.triggersFollowUp === 'night') return;
      await finalizeTriggerPhase(ctx, gameId);
      return;
    }
    const head = queue[0];
    const player = await ctx.db.get(head.playerId);

    // Defensive: stale entry whose player vanished. Drop it and continue.
    if (!player) {
      await ctx.db.patch(gameId, { pendingDeathTriggers: queue.slice(1) });
      continue;
    }

    // Bots can't act. Insert a no-op action row for end-game history, pop,
    // continue. The dwell DOES NOT run for bots — they're skipped silently
    // in a single tick. With no real game ever using bots, this is just a
    // test convenience.
    if (isBotName(player.name)) {
      await ctx.db.insert('nightActions', {
        gameId,
        nightNumber: game.nightNumber,
        actorPlayerId: head.playerId,
        actionType: skipActionType(head.role),
        resolvedAt: Date.now(),
      });
      await ctx.db.patch(gameId, { pendingDeathTriggers: queue.slice(1) });
      continue;
    }

    // Real player at head — open the decision window.
    const deadline = Date.now() + TRIGGER_DWELL_MS;
    await ctx.db.patch(gameId, { triggerEndsAt: deadline });
    await ctx.scheduler.runAfter(TRIGGER_DWELL_MS, internal.triggers.triggerAutoTick, {
      gameId,
      expectedPlayerId: head.playerId,
    });
    return;
  }
}

function skipActionType(role: TriggerRole): string {
  return role === 'Hunter' ? 'hunter_skip' : 'hunter_wolf_skip';
}

function shotActionType(role: TriggerRole): string {
  return role === 'Hunter' ? 'hunter_shot' : 'hunter_wolf_shot';
}

function deathCauseForShot(role: TriggerRole): string {
  return role === 'Hunter' ? 'hunter' : 'hunter-wolf';
}

// ───── Finalization ─────────────────────────────────────────────────────────

async function finalizeTriggerPhase(
  ctx: MutationCtx,
  gameId: Id<'games'>,
): Promise<void> {
  const game = await ctx.db.get(gameId);
  if (!game) return;
  const followUp = game.triggersFollowUp ?? 'day';

  // Clear trigger state regardless of follow-up.
  await ctx.db.patch(gameId, {
    pendingDeathTriggers: undefined,
    triggersFollowUp: undefined,
    triggerEndsAt: undefined,
    triggerAnnouncement: undefined,
  });

  if (followUp === 'day') {
    // Case B path: morning was shown, host tapped BEGIN DAY, triggers ran.
    // If the trigger cascade sealed a win, end the game directly rather
    // than starting a day that no one's going to play.
    const won = await applyWinIfReached(ctx, gameId);
    if (won) return;
    await ctx.db.patch(gameId, { phase: 'day', dayNumber: game.dayNumber + 1 });
    await initializeDayClock(ctx, gameId);
    return;
  }
  // followUp === 'night': post-lynch trigger flow. End the day → next night.
  const won = await applyWinIfReached(ctx, gameId);
  if (won) return;
  await ctx.db.patch(gameId, {
    phase: 'night',
    nightNumber: game.nightNumber + 1,
  });
  await enterStep(ctx, gameId, NIGHT_STEPS[0]);
}

// ───── Mutations ────────────────────────────────────────────────────────────

async function requireHead(
  ctx: MutationCtx,
  gameId: Id<'games'>,
  callerDeviceClientId: string,
  expectedRoles: readonly TriggerRole[],
): Promise<{ game: Doc<'games'>; me: Player; head: TriggerEntry }> {
  const game = await ctx.db.get(gameId);
  if (!game) throw new Error('Game not found.');
  // Triggers can fire in either the 'triggers' phase (night context) or
  // the 'day' phase (lynch dwell). Reject anywhere else.
  if (game.phase !== 'triggers' && game.phase !== 'day') {
    throw new Error('No trigger is active.');
  }
  const queue = game.pendingDeathTriggers ?? [];
  const head = queue[0];
  if (!head) throw new Error('No trigger is active.');
  const me = await findCaller(ctx, gameId, callerDeviceClientId);
  if (!me) throw new Error('You are not in this game.');
  if (head.playerId !== me._id) throw new Error('It is not your trigger to take.');
  if (!expectedRoles.includes(head.role)) {
    throw new Error('Wrong trigger type.');
  }
  return { game, me, head };
}

async function popHead(ctx: MutationCtx, gameId: Id<'games'>): Promise<void> {
  const game = await ctx.db.get(gameId);
  if (!game) return;
  const queue = game.pendingDeathTriggers ?? [];
  await ctx.db.patch(gameId, { pendingDeathTriggers: queue.slice(1) });
}

export const submitHunterShot = mutation({
  args: {
    gameId: v.id('games'),
    callerDeviceClientId: v.string(),
    targetPlayerId: v.id('players'),
  },
  handler: async (ctx, args) => {
    const { game, me, head } = await requireHead(
      ctx,
      args.gameId,
      args.callerDeviceClientId,
      ['Hunter', 'Hunter Wolf'],
    );

    const target = await ctx.db.get(args.targetPlayerId);
    if (!target || target.gameId !== args.gameId) {
      throw new Error('Invalid target.');
    }
    if (!target.alive) throw new Error('Target is already eliminated.');
    if (target._id === me._id) throw new Error('Cannot shoot yourself.');

    const role = head.role;
    await ctx.db.insert('nightActions', {
      gameId: args.gameId,
      nightNumber: game.nightNumber,
      actorPlayerId: me._id,
      actionType: shotActionType(role),
      targetPlayerId: args.targetPlayerId,
      resolvedAt: Date.now(),
    });
    await applyTriggerDeath(
      ctx,
      args.gameId,
      game.nightNumber,
      args.targetPlayerId,
      deathCauseForShot(role),
    );
    // If the Hunter shot landed on a Mad Bomber, detonate immediately so
    // the bomb's victims are recorded as part of this same trigger window.
    // The blast may chain through more bombers; any Hunter/HW caught in
    // the chain is enqueued below via the cascade walker.
    let blastDead: Id<'players'>[] = [];
    if (target.role === 'Mad Bomber') {
      blastDead = await applyMadBomberBlast(
        ctx,
        args.gameId,
        game.nightNumber,
        args.targetPlayerId,
      );
    }
    await popHead(ctx, args.gameId);
    await enqueueTriggersForDeaths(
      ctx,
      args.gameId,
      [args.targetPlayerId, ...blastDead],
    );

    await setAnnouncementAndSchedule(ctx, args.gameId, [
      `${me.name.toUpperCase()} HAS SHOT ${target.name.toUpperCase()}`,
      `${target.name.toUpperCase()} HAS BEEN ELIMINATED`,
    ]);
    // announcementTick will resume the queue.
  },
});

export const submitHunterSkip = mutation({
  args: {
    gameId: v.id('games'),
    callerDeviceClientId: v.string(),
  },
  handler: async (ctx, args) => {
    const { game, me, head } = await requireHead(
      ctx,
      args.gameId,
      args.callerDeviceClientId,
      ['Hunter', 'Hunter Wolf'],
    );
    await ctx.db.insert('nightActions', {
      gameId: args.gameId,
      nightNumber: game.nightNumber,
      actorPlayerId: me._id,
      actionType: skipActionType(head.role),
      resolvedAt: Date.now(),
    });
    await popHead(ctx, args.gameId);
    await processTriggerQueue(ctx, args.gameId);
  },
});

// ───── Announcement tick ────────────────────────────────────────────────────

/**
 * Fires after a public trigger announcement has been displayed for
 * `ANNOUNCEMENT_MS`. Clears the announcement and resumes queue processing.
 * Stale ticks (the announcement was overwritten by a fresh one before the
 * deadline) are recognized by the `expectedEndsAt` check and no-op.
 */
export const announcementTick = internalMutation({
  args: {
    gameId: v.id('games'),
    expectedEndsAt: v.number(),
  },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game) return;
    const ann = game.triggerAnnouncement;
    // Stale tick — a newer announcement replaced this one (e.g., cascade
    // chain produced more public results). Let the newer tick handle it.
    if (!ann || ann.endsAt !== args.expectedEndsAt) return;
    await ctx.db.patch(args.gameId, { triggerAnnouncement: undefined });
    await processTriggerQueue(ctx, args.gameId);
  },
});

// ───── Query ────────────────────────────────────────────────────────────────

/**
 * Single read-through for the TriggersScreen (night context) and the
 * lynch-dwell overlay inside DayScreen. Exposes the head player + my role
 * within that head (with picker data when I'm the head), plus deadlines so
 * the UI can render countdowns.
 */
export const triggerView = query({
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

    const queue = game.pendingDeathTriggers ?? [];
    const headEntry = queue[0] ?? null;

    let head:
      | {
          playerId: Id<'players'>;
          name: string | null;
          role: TriggerRole | null;
          isMe: boolean;
        }
      | null = null;
    if (headEntry) {
      const isMe = me._id === headEntry.playerId;
      const headPlayer = players.find(p => p._id === headEntry.playerId);
      head = {
        playerId: headEntry.playerId,
        name: headPlayer?.name ?? null,
        role: isMe ? headEntry.role : null,
        isMe,
      };
    }

    let targetables: Array<{
      _id: Id<'players'>;
      name: string;
      seatPosition?: number;
    }> = [];

    if (head?.isMe && head.role) {
      const aliveOthers = players.filter(p => p.alive && p._id !== me._id);
      targetables = aliveOthers
        .slice()
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
        dayNumber: game.dayNumber,
        playerCount: game.playerCount,
        triggersFollowUp: game.triggersFollowUp ?? null,
        triggerEndsAt: game.triggerEndsAt ?? null,
        voteDwellEndsAt: game.voteDwellEndsAt ?? null,
        announcement: game.triggerAnnouncement ?? null,
      },
      me: {
        _id: me._id,
        name: me.name,
        role: me.role,
        alive: me.alive,
        isHost: me.isHost,
        seatPosition: me.seatPosition,
      },
      head,
      queueLength: queue.length,
      targetables,
      hostMissing: !players.some(p => p.isHost),
    };
  },
});

/**
 * Fires at the trigger dwell deadline. If the head hasn't changed since the
 * tick was scheduled, auto-default Hunter/HW → skip.
 */
export const triggerAutoTick = internalMutation({
  args: {
    gameId: v.id('games'),
    expectedPlayerId: v.id('players'),
  },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game) return;
    if (game.phase !== 'triggers' && game.phase !== 'day') return;
    const queue = game.pendingDeathTriggers ?? [];
    const head = queue[0];
    if (!head) return;
    // Stale tick — the player already submitted and the queue moved on.
    if (head.playerId !== args.expectedPlayerId) return;
    if (Date.now() < (game.triggerEndsAt ?? 0)) return; // shouldn't happen

    const me = await ctx.db.get(head.playerId);
    if (!me) {
      // Lost player — drop and continue.
      await popHead(ctx, args.gameId);
      await processTriggerQueue(ctx, args.gameId);
      return;
    }

    // Hunter/HW timeout → skip.
    await ctx.db.insert('nightActions', {
      gameId: args.gameId,
      nightNumber: game.nightNumber,
      actorPlayerId: head.playerId,
      actionType: skipActionType(head.role),
      result: { reason: 'timeout' },
      resolvedAt: Date.now(),
    });
    await popHead(ctx, args.gameId);
    await processTriggerQueue(ctx, args.gameId);
  },
});
