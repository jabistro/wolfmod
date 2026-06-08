import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { isWolfTeam } from '../src/data/v1Roles';

/**
 * Wipe every `nomTaps` row for (gameId, dayNumber). Called on trial start
 * (inside `toggleNomTap`), trial cancel (`cancelNomination`), and at
 * `beginNight` so the table never accumulates across days. Bounded
 * per-day by the alive player count.
 */
export async function wipeNomTapsForDay(
  ctx: MutationCtx,
  gameId: Id<'games'>,
  dayNumber: number,
): Promise<void> {
  const rows = await ctx.db
    .query('nomTaps')
    .withIndex('by_game_day_target', q =>
      q.eq('gameId', gameId).eq('dayNumber', dayNumber),
    )
    .collect();
  for (const row of rows) {
    await ctx.db.delete(row._id);
  }
}

// Trigger roles are those whose death prompts an actor decision (shoot or
// hold fire) before the engine advances. Mad Bomber is NOT a trigger role
// — its detonation is automatic and applied at the moment of death by
// `applyMadBomberBlast`.
export type TriggerRole = 'Hunter' | 'Hunter Wolf';
export const TRIGGER_ROLES: ReadonlySet<string> = new Set<string>([
  'Hunter',
  'Hunter Wolf',
]);
export function isTriggerRole(role: string | undefined | null): role is TriggerRole {
  return !!role && TRIGGER_ROLES.has(role);
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
 * True when no player holds the host role — the host explicitly left
 * mid-game (leaveGame demoted isHost to false). A dead host is still
 * host and can still drive the game from spectator mode; the banner
 * fires only on explicit hand-off. Surfaced via each in-game view so
 * the client can render "HOST HAS LEFT — TAP TO CLAIM HOST".
 */
export async function isHostMissing(
  ctx: MutationCtx | QueryCtx,
  gameId: Id<'games'>,
): Promise<boolean> {
  const players = await ctx.db
    .query('players')
    .withIndex('by_game', q => q.eq('gameId', gameId))
    .collect();
  return !players.some(p => p.isHost);
}

/**
 * If any of the just-died player ids belonged to a Wolf Cub, flip the
 * `wolfCubVengeance` flag on the game. Called from every site that applies
 * deaths (morning resolution, lynch tally, trigger cascades) so the flag
 * fires regardless of how the cub died. The flag is honored at the next
 * wolves step (2 kills) and cleared at the start of the next morning
 * resolution.
 */
export async function flagCubDeathIfApplicable(
  ctx: MutationCtx,
  gameId: Id<'games'>,
  justDiedIds: Id<'players'>[],
): Promise<void> {
  if (justDiedIds.length === 0) return;
  for (const id of justDiedIds) {
    const p = await ctx.db.get(id);
    if (p?.role === 'Wolf Cub') {
      await ctx.db.patch(gameId, { wolfCubVengeance: true });
      return;
    }
  }
}

// ───── Day-phase config defaults ───────────────────────────────────────────
//
// All four are stored as optional fields on the game record so a host can
// adjust them per-game (lobby) and mid-game (settings cog). When unset,
// these defaults apply.

export type DayConfig = {
  dayDurationSec: number;
  accusationSec: number;
  defenseSec: number;
  voteTimerSec: number;
  maxNominationsPerDay: number;
  // Wolves' group kill-decision shot clock.
  wolfPickerSec: number;
  // Per-actor decision timer for every OTHER night role (Seer, Bodyguard,
  // Witch, …, including Nightmare Wolf). On expiry the engine auto-resolves
  // (random for can't-skip roles, skip for one-time/optional powers).
  nightActionSec: number;
  // Buffer between the defense ending and the vote opening (remote autopilot):
  // gives the village a beat to read the defense before LIVES/DIES appear.
  preVoteSec: number;
};

export const DAY_CONFIG_DEFAULTS: DayConfig = {
  dayDurationSec: 180,
  accusationSec: 30,
  defenseSec: 30,
  voteTimerSec: 5,
  maxNominationsPerDay: 3,
  wolfPickerSec: 60,
  nightActionSec: 30,
  preVoteSec: 15,
};

export function dayConfigOf(game: Doc<'games'>): DayConfig {
  return {
    dayDurationSec: game.dayDurationSec ?? DAY_CONFIG_DEFAULTS.dayDurationSec,
    accusationSec: game.accusationSec ?? DAY_CONFIG_DEFAULTS.accusationSec,
    defenseSec: game.defenseSec ?? DAY_CONFIG_DEFAULTS.defenseSec,
    voteTimerSec: game.voteTimerSec ?? DAY_CONFIG_DEFAULTS.voteTimerSec,
    maxNominationsPerDay:
      game.maxNominationsPerDay ?? DAY_CONFIG_DEFAULTS.maxNominationsPerDay,
    wolfPickerSec: game.wolfPickerSec ?? DAY_CONFIG_DEFAULTS.wolfPickerSec,
    nightActionSec:
      game.nightActionSec ?? DAY_CONFIG_DEFAULTS.nightActionSec,
    preVoteSec: game.preVoteSec ?? DAY_CONFIG_DEFAULTS.preVoteSec,
  };
}

/**
 * Resets the day clock for a fresh day: dayEndsAt = now + dayDurationMs,
 * clears any pause state, zeros the nomination counter, drops any stale
 * currentNomination. Used wherever the engine transitions into the day
 * phase (initial day 1 begin, beginDay from morning, finalizeTriggerPhase
 * Case B).
 */
/**
 * Remote-only: post the big WIN banner to the village chat the moment a win
 * condition is met. The caller sets `game.winner` first (applyWinIfReached /
 * recordWinIfReached) and re-reads the game before calling this.
 */
export async function postWinBanner(
  ctx: MutationCtx,
  game: Doc<'games'>,
): Promise<void> {
  if (game.mode !== 'remote' || !game.winner) return;
  await ctx.db.insert('messages', {
    gameId: game._id,
    channel: 'village',
    authorName: 'MODERATOR',
    body: '',
    phaseLabel: 'Game over',
    sentAt: Date.now(),
    system: true,
    winBanner: { winner: game.winner },
  });
}

export async function initializeDayClock(
  ctx: MutationCtx,
  gameId: Id<'games'>,
): Promise<void> {
  const game = await ctx.db.get(gameId);
  if (!game) return;
  const cfg = dayConfigOf(game);
  const dayMs = cfg.dayDurationSec * 1000;
  const endsAt = Date.now() + dayMs;
  await ctx.db.patch(gameId, {
    dayEndsAt: endsAt,
    dayPausedRemainingMs: undefined,
    nominationsThisDay: 0,
    currentNomination: undefined,
    nightFallsAt: undefined,
  });
  // Remote autopilot: when the day clock runs out with no trial in flight,
  // auto-warn + go to night (see day.ts dayClockExpiryTick).
  if (game.mode === 'remote') {
    await ctx.scheduler.runAfter(dayMs, internal.day.dayClockExpiryTick, {
      gameId,
      expectedEndsAt: endsAt,
    });
  }
}

/**
 * Returns the winning team if the game is over given current player state,
 * else null. Parity is measured between actual wolves and *everyone else*
 * who is still alive — including wolf-team non-wolves (Minion, Reviler).
 *
 * Those roles win alongside the wolves, but their living body still blocks
 * parity: the wolves must reduce the table until they meet-or-exceed every
 * remaining non-wolf. e.g. {1 Werewolf, 1 Reviler, 1 Villager} is NOT a wolf
 * win (1 wolf vs 2 others) — the wolves must first kill one of the other two.
 * Once all actual wolves are dead the village wins (Minion/Reviler lose).
 */
export function checkWinCondition(
  players: Doc<'players'>[],
): 'village' | 'wolf' | null {
  const alive = players.filter(p => p.alive);
  const aliveActualWolves = alive.filter(p => p.role && isWolfTeam(p.role));
  const aliveNonWolves = alive.filter(p => !(p.role && isWolfTeam(p.role)));
  if (aliveActualWolves.length === 0) return 'village';
  if (aliveActualWolves.length >= aliveNonWolves.length) return 'wolf';
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
