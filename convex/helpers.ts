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

/**
 * Alpha Wolf one-time conversion arming. The FIRST time another (non-Alpha)
 * wolf dies — by any cause, day or night — while an Alpha Wolf is still alive,
 * flip `alphaConvert` from 'unused' to 'armed'. The next wolves step then
 * converts a villager into a wolf instead of killing (resolved at
 * `beginNightWaves` / morning). Set once and never re-armed: a no-op if
 * `alphaConvert` isn't 'unused' (no Alpha in game, or already armed/spent).
 *
 * Called beside every `flagCubDeathIfApplicable` site. At the morning
 * resolution site, pass the suppressed-self-wolf-kill-filtered list (same as
 * Cub vengeance) so wolves can't farm the conversion by eating their own with
 * no redirector present.
 */
export async function flagAlphaConvertIfApplicable(
  ctx: MutationCtx,
  gameId: Id<'games'>,
  justDiedIds: Id<'players'>[],
): Promise<void> {
  if (justDiedIds.length === 0) return;
  const game = await ctx.db.get(gameId);
  if (!game) return;
  // Already armed or spent → never re-arm (one-time). Anything else
  // ('unused' or, defensively, an uninitialized undefined) can arm — the
  // living-Alpha check below still gates on an Alpha actually being in play.
  if (game.alphaConvert === 'armed' || game.alphaConvert === 'spent') return;

  // A non-Alpha wolf must have just died.
  let packMemberDied = false;
  for (const id of justDiedIds) {
    const p = await ctx.db.get(id);
    if (p?.role && isWolfTeam(p.role) && p.role !== 'Alpha Wolf') {
      packMemberDied = true;
      break;
    }
  }
  if (!packMemberDied) return;

  // ...and an Alpha Wolf must still be alive to lead the conversion.
  const players = await ctx.db
    .query('players')
    .withIndex('by_game', q => q.eq('gameId', gameId))
    .collect();
  if (!players.some(p => p.alive && p.role === 'Alpha Wolf')) return;

  await ctx.db.patch(gameId, { alphaConvert: 'armed' });
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
    // Morning roll call: list who's still in the game as the day opens, so
    // players can answer "who's left?" without leaving the chat. This is the
    // single day-start chokepoint for every path (normal + post-Hunter
    // cascade), so the list reflects the FINAL alive set once all night deaths
    // and any Hunter shot have resolved. Day 1 has no preceding night — the
    // lobby already showed the full table — so it's skipped.
    if (game.dayNumber > 1) {
      const players = await ctx.db
        .query('players')
        .withIndex('by_game', q => q.eq('gameId', gameId))
        .collect();
      const remaining = players
        .filter(p => p.alive)
        .sort((a, b) => (a.seatPosition ?? 0) - (b.seatPosition ?? 0))
        .map(p => ({ name: p.name, id: p._id as string }));
      await ctx.db.insert('messages', {
        gameId,
        channel: 'village',
        authorName: 'MODERATOR',
        body: '',
        phaseLabel: `Day ${game.dayNumber}`,
        sentAt: Date.now(),
        system: true,
        roster: remaining,
      });
    }
  }
}

/**
 * Returns the winning side if the game is over given current player state,
 * else null. Three possible winners: 'village', 'wolf', and 'chupacabra'
 * (the solo third party).
 *
 * Resolution order:
 *
 *  1. Wolves still alive → standard parity over *every* other living body,
 *     including wolf-team non-wolves (Minion, Reviler) AND the Chupacabra.
 *     Those bodies all block parity: the wolves must reduce the table until
 *     they meet-or-exceed every remaining non-wolf. So a final two of
 *     {1 wolf, 1 Chupacabra} is a WOLF win — the Chupacabra failed to clear
 *     the pack. e.g. {1 Werewolf, 1 Reviler, 1 Villager} is NOT yet a wolf
 *     win (1 wolf vs 2 others).
 *
 *  2. No wolves left, but a Chupacabra is alive → the village does NOT win;
 *     the Chupacabra is the last remaining threat and keeps killing nightly.
 *     It wins once it reaches parity over everyone else — i.e. once at most
 *     one other player remains (final two with a villager, or last one
 *     standing). Minion/Reviler count as bodies it must still clear.
 *
 *  3. No wolves and no Chupacabra alive → the village wins (Minion/Reviler
 *     lose alongside the dead wolves).
 *
 * A dormant Spawn (role still 'Spawn') counts as a non-wolf body here, exactly
 * like Minion/Reviler. It never reaches this function still dormant when the
 * pack has just fallen, though: `recordWinIfReached` runs
 * `awakenSpawnIfPackFallen` first, flipping it to 'Werewolf' before the count —
 * so a lone Spawn keeps the game alive rather than handing the village a win.
 */
export function checkWinCondition(
  players: Doc<'players'>[],
): 'village' | 'wolf' | 'chupacabra' | null {
  const alive = players.filter(p => p.alive);
  const aliveActualWolves = alive.filter(p => p.role && isWolfTeam(p.role));
  const aliveChupacabras = alive.filter(p => p.role === 'Chupacabra');
  // Everyone alive who is neither an actual wolf nor a Chupacabra.
  const aliveOthers = alive.filter(
    p => !(p.role && isWolfTeam(p.role)) && p.role !== 'Chupacabra',
  );

  if (aliveActualWolves.length >= 1) {
    const nonWolves = aliveOthers.length + aliveChupacabras.length;
    if (aliveActualWolves.length >= nonWolves) return 'wolf';
    return null;
  }

  // No actual wolves remain.
  if (aliveChupacabras.length >= 1) {
    if (aliveChupacabras.length >= aliveOthers.length) return 'chupacabra';
    return null;
  }

  return 'village';
}

/**
 * The Spawn is a dormant backup wolf: wolf-team for win attribution but, like
 * the Minion/Reviler, NOT counted for parity and asleep during the wolves' kill
 * while any real wolf lives. The instant the last real wolf is eliminated
 * (lynch OR night death) with the Spawn still alive, it rises as the last wolf
 * — role-patched to 'Werewolf' so `isWolfTeam` / `seerSees` / parity / the
 * wolves night step all just work, and it wakes to pick the kill from then on.
 *
 * Called at the TOP of `recordWinIfReached` — the single choke point every
 * game-ending win check funnels through (directly, or via `applyWinIfReached`).
 * Running it here guarantees the flip lands BEFORE the village is ever credited
 * a wolves-eliminated victory, in every path (day lynch, night resolution,
 * Hunter triggers, drunk sober-up, beginNight), without scattering the call.
 * This is the same "flip-then-count" ordering Cursed/Alpha/Sasquatch rely on;
 * because it runs inside the win check (after those conversions have already
 * patched their villager→wolf), a same-tick Cursed/Alpha conversion keeps a
 * real wolf alive and correctly leaves the Spawn dormant.
 *
 * `pendingSpawnReveal` cloaks the new wolf from the (empty) pack chat/roster and
 * drives the private "the pack has fallen" overlay shown at the next wolves
 * step; it's cleared when that step advances (see `clearSpawnReveals`).
 */
export async function awakenSpawnIfPackFallen(
  ctx: MutationCtx,
  gameId: Id<'games'>,
): Promise<void> {
  const players = await ctx.db
    .query('players')
    .withIndex('by_game', q => q.eq('gameId', gameId))
    .collect();
  const alive = players.filter(p => p.alive);
  // A real wolf still lives → the Spawn stays dormant.
  if (alive.some(p => p.role && isWolfTeam(p.role))) return;
  const dormantSpawn = alive.filter(p => p.role === 'Spawn');
  if (dormantSpawn.length === 0) return;
  for (const s of dormantSpawn) {
    await ctx.db.patch(s._id, {
      role: 'Werewolf',
      roleState: { ...(s.roleState ?? {}), pendingSpawnReveal: true },
    });
  }
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
): Promise<'village' | 'wolf' | 'chupacabra' | null> {
  // Give a dormant Spawn its chance to rise before we ever count a wolves-
  // eliminated village win. Patches the DB, so the re-query below sees the
  // flipped role.
  await awakenSpawnIfPackFallen(ctx, gameId);
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
