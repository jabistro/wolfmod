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
  recordWinIfReached,
  applyWinIfReached,
  triggerVisibility,
  type TriggerRole,
} from './helpers';
import { isWolfTeam } from '../src/data/v1Roles';
import { enterStep } from './night';
import { NIGHT_STEPS } from '../src/data/nightOrder';

type Player = Doc<'players'>;
type TriggerEntry = {
  playerId: Id<'players'>;
  role: TriggerRole;
  visibility: 'public' | 'silent';
};

// 10-second decision window per trigger head. Same value used as the lynch
// vote dwell so all "is a trigger acting?" cloaks share one feel.
export const TRIGGER_DWELL_MS = 10_000;

// How long a public trigger result (Hunter shot / MD cascade) stays on
// every phone before the queue advances. Long enough to read but short
// enough that the table doesn't lose momentum.
const ANNOUNCEMENT_MS = 4_000;

/**
 * Whether trigger results should be announced to the table in the current
 * context. The Case A pre-morning silent flow (`followUp === 'morning'`)
 * suppresses announcements — MD cascade victims appear in the upcoming
 * morning death list and the village figures it out from there. Every
 * other context (Case B post-morning, lynch dwell) does announce.
 */
function shouldAnnounce(followUp: string | null | undefined): boolean {
  return followUp !== 'morning';
}

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

function tierIndex(role: TriggerRole): number {
  // Hunter / Hunter Wolf act first (tier 0). Mad Destroyer acts last (tier 1).
  return role === 'Mad Destroyer' ? 1 : 0;
}

/**
 * Insert a new trigger in tier order: a public entry slots before any silent
 * entries, in the order it arrived; a silent entry goes to the end. Cascade
 * triggers from a kill follow the same rule (a Hunter killed by another
 * Hunter joins the back of the public tier, ahead of any waiting MD).
 */
function insertInTierOrder(
  queue: TriggerEntry[],
  entry: TriggerEntry,
): TriggerEntry[] {
  const newTier = tierIndex(entry.role);
  for (let i = 0; i < queue.length; i++) {
    if (tierIndex(queue[i].role) > newTier) {
      return [...queue.slice(0, i), entry, ...queue.slice(i)];
    }
  }
  return [...queue, entry];
}

/**
 * Append triggers for any of the given player IDs whose role is a trigger
 * role. Triggers go in tier order — Hunter/HW first, MD last. Does not
 * start processing; caller invokes `processTriggerQueue` after.
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
    const role = p.role;
    queue = insertInTierOrder(queue, {
      playerId: id,
      role,
      visibility: triggerVisibility(role),
    });
    mutated = true;
  }
  if (mutated) {
    await ctx.db.patch(gameId, { pendingDeathTriggers: queue });
  }
}

// ───── Mad Destroyer geometry ───────────────────────────────────────────────
//
// Seats are laid out clockwise on screen (seat 0 at top, indices increasing
// clockwise). Players face the center, so player POV:
//   right = seat (X-1+N) % N  → walking right = step -1
//   left  = seat (X+1)   % N  → walking left  = step +1
// MD walks in the chosen direction, skipping seats that are already empty
// (eliminated), taking the next `killCount` alive players.

function madDestroyerVictims(
  md: Player,
  allPlayers: Player[],
  totalSeats: number,
  direction: 'L' | 'R',
  killCount: number,
): Id<'players'>[] {
  if (killCount <= 0 || typeof md.seatPosition !== 'number') return [];
  const playersBySeat = new Map<number, Player>();
  for (const p of allPlayers) {
    if (typeof p.seatPosition === 'number') playersBySeat.set(p.seatPosition, p);
  }
  const step = direction === 'R' ? -1 : 1;
  const startSeat = md.seatPosition;
  const victims: Id<'players'>[] = [];
  let cursor = startSeat;
  // Cap iterations at totalSeats to guarantee termination even with sparse
  // seating; the loop exits early once we've collected enough victims or
  // wrapped back to MD's own seat.
  for (let i = 0; i < totalSeats; i++) {
    cursor = ((cursor + step) % totalSeats + totalSeats) % totalSeats;
    if (cursor === startSeat) break;
    const p = playersBySeat.get(cursor);
    if (!p || !p.alive) continue;
    victims.push(p._id);
    if (victims.length >= killCount) break;
  }
  return victims;
}

function aliveWolfCount(players: Player[]): number {
  return players.filter(p => p.alive && p.role && isWolfTeam(p.role)).length;
}

// ───── Kill resolution + cascade ────────────────────────────────────────────

/**
 * Mark a player dead from a trigger action, write a death row, and queue
 * their trigger if they're a trigger role themselves (cascade). Returns true
 * if the player was actually killed (i.e., they were alive). Hunter/MD kills
 * bypass BG and witch saves — those only apply to night-source deaths.
 */
async function applyTriggerDeath(
  ctx: MutationCtx,
  gameId: Id<'games'>,
  nightNumber: number,
  targetId: Id<'players'>,
  cause: string,
): Promise<boolean> {
  const target = await ctx.db.get(targetId);
  if (!target || !target.alive) return false;
  await ctx.db.patch(targetId, { alive: false });
  await ctx.db.insert('nightActions', {
    gameId,
    nightNumber,
    actorPlayerId: undefined,
    actionType: 'death',
    targetPlayerId: targetId,
    result: { cause },
    resolvedAt: Date.now(),
  });
  return true;
}

// ───── Queue processing ─────────────────────────────────────────────────────

/**
 * Walk the trigger queue: auto-skip bot heads (and MD heads with no kills
 * to make), then either (a) stop on the first real-player head, setting a
 * fresh 10 s dwell and scheduling the auto-tick, or (b) call
 * `finalizeTriggerPhase` if the queue empties.
 */
export async function processTriggerQueue(
  ctx: MutationCtx,
  gameId: Id<'games'>,
): Promise<void> {
  while (true) {
    const game = await ctx.db.get(gameId);
    if (!game) return;
    // Trigger flow runs in 'triggers' phase (night context, Cases A & B)
    // and 'day' phase (lynch context, during the vote dwell).
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

    // Case A (pre-morning silent context) escape hatch. If an MD cascade
    // kicks a public-visibility head onto the queue, those Hunter/HW
    // triggers must wait until *after* the morning announcement — they
    // learn of their death at the same time as the village. Transition
    // to morning now; queue persists for the BEGIN DAY handoff
    // (followUp flips to 'day').
    if (
      head.visibility === 'public' &&
      game.phase === 'triggers' &&
      game.triggersFollowUp === 'morning'
    ) {
      await ctx.db.patch(gameId, {
        phase: 'morning',
        nightStep: undefined,
        triggersFollowUp: 'day',
        triggerEndsAt: undefined,
      });
      return;
    }

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

    // Real player at head — open the decision window. We prompt the MD
    // even when wolves_remaining <= 1 (killCount = 0) so they know they
    // died; the picker shows "0 victims" and a single acknowledge button.
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
  switch (role) {
    case 'Hunter':
      return 'hunter_skip';
    case 'Hunter Wolf':
      return 'hunter_wolf_skip';
    case 'Mad Destroyer':
      return 'mad_destroyer_skip';
  }
}

function shotActionType(role: 'Hunter' | 'Hunter Wolf'): string {
  return role === 'Hunter' ? 'hunter_shot' : 'hunter_wolf_shot';
}

function deathCauseForShot(role: 'Hunter' | 'Hunter Wolf'): string {
  return role === 'Hunter' ? 'hunter' : 'hunter-wolf';
}

// ───── Finalization ─────────────────────────────────────────────────────────

async function finalizeTriggerPhase(
  ctx: MutationCtx,
  gameId: Id<'games'>,
): Promise<void> {
  const game = await ctx.db.get(gameId);
  if (!game) return;
  const followUp = game.triggersFollowUp ?? 'morning';

  // Clear trigger state regardless of follow-up.
  await ctx.db.patch(gameId, {
    pendingDeathTriggers: undefined,
    triggersFollowUp: undefined,
    triggerEndsAt: undefined,
    triggerAnnouncement: undefined,
  });

  if (followUp === 'morning') {
    // Case A path: silent MD ran pre-morning. Now reveal the morning.
    await ctx.db.patch(gameId, { phase: 'morning', nightStep: undefined });
    await recordWinIfReached(ctx, gameId);
    return;
  }
  if (followUp === 'day') {
    // Case B path: morning was shown, host tapped BEGIN DAY, triggers ran.
    // If the trigger cascade sealed a win (e.g., Hunter's shot left wolves
    // at parity, or killed the last wolf), end the game directly rather
    // than starting a day that no one's going to play.
    const won = await applyWinIfReached(ctx, gameId);
    if (won) return;
    await ctx.db.patch(gameId, { phase: 'day', dayNumber: game.dayNumber + 1 });
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

    const role = head.role as 'Hunter' | 'Hunter Wolf';
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
    await popHead(ctx, args.gameId);
    await enqueueTriggersForDeaths(ctx, args.gameId, [args.targetPlayerId]);

    if (shouldAnnounce(game.triggersFollowUp)) {
      await setAnnouncementAndSchedule(ctx, args.gameId, [
        `${me.name.toUpperCase()} HAS SHOT ${target.name.toUpperCase()}`,
        `${target.name.toUpperCase()} HAS BEEN ELIMINATED`,
      ]);
      return; // announcementTick will resume the queue
    }
    await processTriggerQueue(ctx, args.gameId);
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

export const submitMadDestroyerKill = mutation({
  args: {
    gameId: v.id('games'),
    callerDeviceClientId: v.string(),
    direction: v.union(v.literal('L'), v.literal('R')),
  },
  handler: async (ctx, args) => {
    const { game, me } = await requireHead(
      ctx,
      args.gameId,
      args.callerDeviceClientId,
      ['Mad Destroyer'],
    );
    await applyMadDestroyerDirection(ctx, args.gameId, game, me, args.direction);
  },
});

/**
 * Shared MD resolution path — used by the player-facing mutation and the
 * 10 s auto-default fallback. Computes victims from the current alive
 * state (so a Hunter shot that landed earlier this same trigger window
 * has already shifted MD's neighbors), kills them, cascades any trigger
 * roles, and advances the queue.
 */
async function applyMadDestroyerDirection(
  ctx: MutationCtx,
  gameId: Id<'games'>,
  game: Doc<'games'>,
  md: Player,
  direction: 'L' | 'R',
): Promise<void> {
  const all = await ctx.db
    .query('players')
    .withIndex('by_game', q => q.eq('gameId', gameId))
    .collect();
  const wolves = aliveWolfCount(all);
  const killCount = Math.max(0, wolves - 1);
  const victimIds = madDestroyerVictims(
    md,
    all,
    game.playerCount,
    direction,
    killCount,
  );
  await ctx.db.insert('nightActions', {
    gameId,
    nightNumber: game.nightNumber,
    actorPlayerId: md._id,
    actionType: 'mad_destroyer_kill',
    result: { direction, victimIds, killCount },
    resolvedAt: Date.now(),
  });
  const newlyDead: Id<'players'>[] = [];
  const victimNames: string[] = [];
  for (const vid of victimIds) {
    const victim = await ctx.db.get(vid);
    const killed = await applyTriggerDeath(
      ctx,
      gameId,
      game.nightNumber,
      vid,
      'mad-destroyer',
    );
    if (killed) {
      newlyDead.push(vid);
      if (victim) victimNames.push(victim.name);
    }
  }
  await popHead(ctx, gameId);
  await enqueueTriggersForDeaths(ctx, gameId, newlyDead);

  // MD's cascade is announced WITHOUT attributing the killer — per
  // house rule, MD's role stays hidden. Just stack the eliminations.
  if (victimNames.length > 0 && shouldAnnounce(game.triggersFollowUp)) {
    await setAnnouncementAndSchedule(
      ctx,
      gameId,
      victimNames.map(n => `${n.toUpperCase()} HAS BEEN ELIMINATED`),
    );
    return; // announcementTick will resume the queue
  }
  await processTriggerQueue(ctx, gameId);
}

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

// ───── Auto-tick (10 s deadline) ────────────────────────────────────────────

// ───── Query ────────────────────────────────────────────────────────────────

/**
 * Single read-through for the TriggersScreen (night context) and the
 * lynch-dwell overlay inside DayScreen. Exposes the head player + my role
 * within that head (with picker data when I'm the head), plus deadlines so
 * the UI can render countdowns. Silent-trigger heads are exposed by name
 * ONLY when the caller is the head themselves — non-actors get a generic
 * "resolving" view without a name so MD's death isn't telegraphed.
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
          visibility: 'public' | 'silent';
          isMe: boolean;
        }
      | null = null;
    if (headEntry) {
      const isMe = me._id === headEntry.playerId;
      const headPlayer = players.find(p => p._id === headEntry.playerId);
      head = {
        playerId: headEntry.playerId,
        // Silent triggers cloak the actor's identity from non-actors. The
        // actor themselves and the public-tier triggers (Hunter/HW) get
        // the real name. Role is also withheld from non-actors regardless
        // of visibility — they only need "someone is acting" feedback.
        name:
          isMe || headEntry.visibility === 'public'
            ? headPlayer?.name ?? null
            : null,
        role: isMe ? headEntry.role : null,
        visibility: headEntry.visibility,
        isMe,
      };
    }

    let targetables: Array<{
      _id: Id<'players'>;
      name: string;
      seatPosition?: number;
    }> = [];
    let mdState:
      | {
          mySeat: number | null;
          totalSeats: number;
          killCount: number;
          aliveSeats: Array<{
            _id: Id<'players'>;
            name: string;
            seatPosition: number;
          }>;
        }
      | null = null;

    if (head?.isMe && head.role) {
      const aliveOthers = players.filter(p => p.alive && p._id !== me._id);
      if (head.role === 'Hunter' || head.role === 'Hunter Wolf') {
        targetables = aliveOthers
          .slice()
          .sort(
            (a, b) => (a.seatPosition ?? 0) - (b.seatPosition ?? 0),
          )
          .map(p => ({
            _id: p._id,
            name: p.name,
            seatPosition: p.seatPosition,
          }));
      }
      if (head.role === 'Mad Destroyer') {
        const wolvesRemaining = players.filter(
          p => p.alive && p.role && isWolfTeam(p.role),
        ).length;
        const aliveSeats = aliveOthers
          .filter(p => typeof p.seatPosition === 'number')
          .slice()
          .sort((a, b) => a.seatPosition! - b.seatPosition!)
          .map(p => ({
            _id: p._id,
            name: p.name,
            seatPosition: p.seatPosition as number,
          }));
        mdState = {
          mySeat:
            typeof me.seatPosition === 'number' ? me.seatPosition : null,
          totalSeats: game.playerCount,
          killCount: Math.max(0, wolvesRemaining - 1),
          aliveSeats,
        };
      }
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
      mdState,
    };
  },
});

/**
 * Fires at the trigger dwell deadline. If the head hasn't changed since the
 * tick was scheduled, auto-default: Hunter/HW → skip, MD → LEFT (per house
 * choice; MD has no canonical skip option).
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

    if (head.role === 'Mad Destroyer') {
      // Default LEFT on timeout. The user can revisit if a different default
      // (random, or per-game pref) becomes preferable.
      await applyMadDestroyerDirection(ctx, args.gameId, game, me, 'L');
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
