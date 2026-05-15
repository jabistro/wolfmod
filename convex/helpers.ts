import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { isWolfTeam } from '../src/data/v1Roles';

export type TriggerRole = 'Hunter' | 'Hunter Wolf' | 'Mad Destroyer';
export const TRIGGER_ROLES: ReadonlySet<string> = new Set<string>([
  'Hunter',
  'Hunter Wolf',
  'Mad Destroyer',
]);
export function isTriggerRole(role: string | undefined | null): role is TriggerRole {
  return !!role && TRIGGER_ROLES.has(role);
}
/**
 * Hunter / Hunter Wolf are "public" — their death is announced. Mad
 * Destroyer is "silent" — their death is never mentioned. The trigger
 * queue interleaves both kinds.
 */
export function triggerVisibility(role: TriggerRole): 'public' | 'silent' {
  return role === 'Mad Destroyer' ? 'silent' : 'public';
}

export async function findCaller(
  ctx: MutationCtx | QueryCtx,
  gameId: Id<'games'>,
  deviceClientId: string,
) {
  return ctx.db
    .query('players')
    .withIndex('by_game_device', q =>
      q.eq('gameId', gameId).eq('deviceClientId', deviceClientId),
    )
    .first();
}

export async function requireHost(
  ctx: MutationCtx,
  gameId: Id<'games'>,
  deviceClientId: string,
) {
  const caller = await findCaller(ctx, gameId, deviceClientId);
  if (!caller || !caller.isHost) {
    throw new Error('Only the host can perform this action.');
  }
  return caller;
}

export function isBotName(name: string): boolean {
  return /^Bot \d+$/.test(name);
}

/**
 * Returns the winning team if the game is over given current player state,
 * else null. House-rule parity: actual wolves vs (alive players minus Minion
 * minus Reviler). Minion/Reviler win with the wolves but don't count for
 * parity in either direction.
 */
export function checkWinCondition(
  players: Doc<'players'>[],
): 'village' | 'wolf' | null {
  const alive = players.filter(p => p.alive);
  const aliveActualWolves = alive.filter(p => p.role && isWolfTeam(p.role));
  const aliveCounted = alive.filter(
    p =>
      p.role &&
      !isWolfTeam(p.role) &&
      p.role !== 'Minion' &&
      p.role !== 'Reviler',
  );
  if (aliveActualWolves.length === 0) return 'village';
  if (aliveActualWolves.length >= aliveCounted.length) return 'wolf';
  return null;
}

/**
 * Records the winning team on the game if a win condition is reached, but
 * does not change phase. Returns the winner (or null). Use this when a death
 * occurs but you want the existing phase (e.g. 'morning') to continue
 * displaying narratively before the game-over transition.
 */
export async function recordWinIfReached(
  ctx: MutationCtx,
  gameId: Id<'games'>,
): Promise<'village' | 'wolf' | null> {
  const players = await ctx.db
    .query('players')
    .withIndex('by_game', q => q.eq('gameId', gameId))
    .collect();
  const winner = checkWinCondition(players);
  if (!winner) return null;
  await ctx.db.patch(gameId, { winner });
  return winner;
}

/**
 * If a win has been reached, transition the game to 'ended' and return true.
 * Call this when an immediate end-of-game transition is appropriate (lynch
 * resolution, where the day was about to end anyway).
 */
export async function applyWinIfReached(
  ctx: MutationCtx,
  gameId: Id<'games'>,
): Promise<boolean> {
  const winner = await recordWinIfReached(ctx, gameId);
  if (!winner) return false;
  await ctx.db.patch(gameId, {
    phase: 'ended',
    endedAt: Date.now(),
  });
  return true;
}
