import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from './_generated/server';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import {
  findCaller,
  requireHost,
  isBotName,
  recordWinIfReached,
  applyWinIfReached,
  initializeDayClock,
  flagCubDeathIfApplicable,
} from './helpers';
import {
  enqueueTriggersForDeaths,
  processTriggerQueue,
  applyMadBomberBlast,
} from './triggers';
import {
  isWolfTeam,
  seerSees,
  teamForRole,
  WOLF_TEAM_ROLES,
} from '../src/data/v1Roles';
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
//
// When an action lands AFTER the deadline (slow decider), the dwell would
// otherwise be exhausted and the step would advance instantly — leaving
// ghosts/spectators no time to observe what just happened. To prevent that,
// every action mutation calls `ensureReadingWindow` instead of `maybeAdvance`,
// which bumps the deadline forward by `REVEAL_WINDOW_MS` (only if needed).

const STEP_DWELL_MIN_MS = 6000;
const STEP_DWELL_MAX_MS = 12000;

// Guaranteed remaining dwell after any night action is submitted, so the
// acting player can read their own result (info roles) AND ghosts/spectators
// have time to observe what just happened on the table before the step
// advances. Only bumps the deadline when it would otherwise be sooner — fast
// actors still get the full original dwell, preserving cloak variance.
const REVEAL_WINDOW_MS = 5000;

// How long past the dwell deadline the host has to wait before the
// "Skip Ahead" override becomes available.
const SKIP_STALL_THRESHOLD_MS = 20_000;

function randomDwellMs(): number {
  return (
    STEP_DWELL_MIN_MS +
    Math.floor(Math.random() * (STEP_DWELL_MAX_MS - STEP_DWELL_MIN_MS))
  );
}

// ───── Step membership ──────────────────────────────────────────────────────

/**
 * Steps where a nightmared player (roleState.nightmaredOn === nightNumber)
 * is filtered out of the actor list — their picker is replaced with a
 * "you've been put to sleep" overlay client-side, the step dwells normally,
 * and isStepComplete sees a vacuously-empty actor list. Wolves /
 * nightmare_wolf / passive resolution steps are NOT in this set: NW puts
 * to sleep *active villager pickers*, not the pack's wake-up or the
 * passive-conversion machinery.
 */
const NIGHTMARE_BLOCKABLE_STEPS = new Set<NightStep>([
  'seer',
  'pi',
  'mentalist',
  'witch',
  'leprechaun',
  'bodyguard',
  'huntress',
  'revealer',
  'reviler',
]);

function isNightmared(p: Player, nightNumber: number): boolean {
  return p.roleState?.nightmaredOn === nightNumber;
}

function activePlayersForStep(
  step: NightStep,
  alive: Player[],
  nightNumber: number,
): Player[] {
  const dropNightmared = (xs: Player[]): Player[] =>
    NIGHTMARE_BLOCKABLE_STEPS.has(step)
      ? xs.filter(p => !isNightmared(p, nightNumber))
      : xs;
  switch (step) {
    case 'wolves':
      return alive.filter(p => p.role && isWolfTeam(p.role));
    case 'nightmare_wolf':
      // Two-charge night-action denier. Once both charges are spent the
      // step still dwells for cloak symmetry but auto-completes since
      // actors=[]. Skipping a night doesn't consume a charge.
      return alive.filter(
        p =>
          p.role === 'Nightmare Wolf' &&
          ((p.roleState?.nightmaresUsed as Id<'players'>[] | undefined) ?? [])
            .length < 2,
      );
    case 'seer':
      return dropNightmared(alive.filter(p => p.role === 'Seer'));
    case 'pi':
      // PI is one-time: once used, they're not an active actor anymore. The
      // step still dwells (cloaking) but auto-completes since actors=[].
      return dropNightmared(
        alive.filter(
          p => p.role === 'Paranormal Investigator' && !p.roleState?.piUsed,
        ),
      );
    case 'mentalist':
      return dropNightmared(alive.filter(p => p.role === 'Mentalist'));
    case 'witch':
      // Once both potions are spent the Witch has nothing left to decide.
      // Filter her out so she sleeps cleanly on subsequent nights — same
      // shape as spent PI / Huntress / Nightmare Wolf. The step still
      // dwells for cloak symmetry; isStepComplete sees actors=[] and
      // auto-completes when the dwell elapses.
      return dropNightmared(
        alive.filter(
          p =>
            p.role === 'Witch' &&
            !(p.roleState?.witchSaveUsed && p.roleState?.witchPoisonUsed),
        ),
      );
    case 'leprechaun':
      return dropNightmared(alive.filter(p => p.role === 'Leprechaun'));
    case 'bodyguard':
      return dropNightmared(alive.filter(p => p.role === 'Bodyguard'));
    case 'huntress':
      // One-time: once she's used her shot, she's no longer an active actor.
      // The step still dwells for cloaking but auto-completes since actors=[].
      return dropNightmared(
        alive.filter(
          p => p.role === 'Huntress' && !p.roleState?.huntressUsed,
        ),
      );
    case 'revealer':
      return dropNightmared(alive.filter(p => p.role === 'Revealer'));
    case 'reviler':
      return dropNightmared(alive.filter(p => p.role === 'Reviler'));
    case 'cursed_conversion':
      // No actor input. The step computes & writes conversion rows on
      // entry and just dwells so the converted Cursed can read the reveal.
      return [];
    case 'doppelganger_dawn':
    case 'doppelganger_dusk':
      // Same shape as cursed_conversion — no picker. Reveals are gated on
      // each converted Doppelganger acking via `submitDoppelgangerAck`,
      // which clears their `pendingDoppelgangerReveal` field.
      return [];
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
    case 'nightmare_wolf':
      return set.has('Nightmare Wolf');
    case 'seer':
      return set.has('Seer');
    case 'pi':
      return set.has('Paranormal Investigator');
    case 'mentalist':
      return set.has('Mentalist');
    case 'witch':
      return set.has('Witch');
    case 'leprechaun':
      return set.has('Leprechaun');
    case 'bodyguard':
      return set.has('Bodyguard');
    case 'huntress':
      return set.has('Huntress');
    case 'revealer':
      return set.has('Revealer');
    case 'reviler':
      return set.has('Reviler');
    case 'cursed_conversion':
      return set.has('Cursed');
    case 'doppelganger_dawn':
    case 'doppelganger_dusk':
      return set.has('Doppelganger');
  }
}

// ───── Step completion ──────────────────────────────────────────────────────

async function getNightActions(
  ctx: MutationCtx | QueryCtx,
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

/**
 * How many wolf kills the wolves step must record before completing.
 *
 * Normal night: 1. Wolf Cub vengeance night (cub died sometime before this
 * night's wolves step): 2. Clamped to the number of alive non-wolves so a
 * 1-target board doesn't hang. Diseased blocking is checked separately —
 * when blocked, the step uses a `wolf_blocked` row and this helper isn't
 * consulted.
 */
function computeRequiredKills(
  game: Doc<'games'>,
  alivePlayers: Player[],
): number {
  const aliveNonWolves = alivePlayers.filter(
    p => p.role && !isWolfTeam(p.role),
  ).length;
  if (aliveNonWolves === 0) return 0;
  const base = game.wolfCubVengeance ? 2 : 1;
  return Math.min(base, aliveNonWolves);
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
      // Defensive: if no wolves alive, the step is vacuously complete. In
      // practice this should be caught by the win-condition first.
      if (actors.length === 0) return true;
      // Diseased carryover: enterStep inserted a wolf_blocked row instead of
      // letting wolves pick — that also completes the step.
      const blocked = await getNightActions(
        ctx,
        gameId,
        nightNumber,
        'wolf_blocked',
      );
      if (blocked.length > 0) return true;
      const kills = await getNightActions(ctx, gameId, nightNumber, 'wolf_kill');
      const game = await ctx.db.get(gameId);
      if (!game) return kills.length > 0;
      const allPlayers = await ctx.db
        .query('players')
        .withIndex('by_game', q => q.eq('gameId', gameId))
        .collect();
      const required = computeRequiredKills(
        game,
        allPlayers.filter(p => p.alive),
      );
      return kills.length >= required;
    }
    case 'nightmare_wolf': {
      // Each NW either puts a player to sleep OR skips tonight. Step is
      // complete when every NW with a charge remaining has decided.
      const puts = await getNightActions(
        ctx,
        gameId,
        nightNumber,
        'nightmare_put_to_sleep',
      );
      const skips = await getNightActions(
        ctx,
        gameId,
        nightNumber,
        'nightmare_skip',
      );
      return puts.length + skips.length >= actors.length;
    }
    case 'seer': {
      const checks = await getNightActions(ctx, gameId, nightNumber, 'seer_check');
      return checks.length >= actors.length;
    }
    case 'pi': {
      // PI completes by either using their check or skipping the night.
      const checks = await getNightActions(ctx, gameId, nightNumber, 'pi_check');
      const skips = await getNightActions(ctx, gameId, nightNumber, 'pi_skip');
      return checks.length + skips.length >= actors.length;
    }
    case 'mentalist': {
      // Mentalist may also pass when they have fewer than 2 valid targets
      // for the night (self is never valid, and last night's two targets are
      // off-limits per house rules). The skip action signals "no eligible
      // pair tonight" without leaking the actor's situation.
      const checks = await getNightActions(
        ctx,
        gameId,
        nightNumber,
        'mentalist_check',
      );
      const skips = await getNightActions(
        ctx,
        gameId,
        nightNumber,
        'mentalist_skip',
      );
      return checks.length + skips.length >= actors.length;
    }
    case 'witch': {
      // Witch's step is complete when each witch has submitted a 'witch_done'
      // action — they may also have used a save and/or poison this night, but
      // the explicit done is the signal to advance.
      const dones = await getNightActions(ctx, gameId, nightNumber, 'witch_done');
      return dones.length >= actors.length;
    }
    case 'leprechaun': {
      // Leprechaun's step is complete when each leprechaun has submitted a
      // 'leprechaun_redirect' row — whether they moved the kill or left it,
      // or acknowledged a diseased-blocked night.
      const acts = await getNightActions(
        ctx,
        gameId,
        nightNumber,
        'leprechaun_redirect',
      );
      return acts.length >= actors.length;
    }
    case 'bodyguard': {
      const protects = await getNightActions(ctx, gameId, nightNumber, 'bg_protect');
      return protects.length >= actors.length;
    }
    case 'huntress': {
      // Either shoot or save the shot — both signals are completion.
      const shots = await getNightActions(ctx, gameId, nightNumber, 'huntress_shot');
      const skips = await getNightActions(ctx, gameId, nightNumber, 'huntress_skip');
      return shots.length + skips.length >= actors.length;
    }
    case 'revealer': {
      const shots = await getNightActions(ctx, gameId, nightNumber, 'revealer_shot');
      const skips = await getNightActions(ctx, gameId, nightNumber, 'revealer_skip');
      return shots.length + skips.length >= actors.length;
    }
    case 'reviler': {
      const shots = await getNightActions(ctx, gameId, nightNumber, 'reviler_shot');
      const skips = await getNightActions(ctx, gameId, nightNumber, 'reviler_skip');
      return shots.length + skips.length >= actors.length;
    }
    case 'cursed_conversion': {
      // Conversion rows are written inline in enterStep. Step is complete
      // only when every converted Cursed has acknowledged the reveal via
      // `submitCursedAck`. If no one converted this night, completes
      // immediately (acks=0 >= conversions=0). Dwell still gates advance
      // separately for cloak symmetry.
      const conversions = await getNightActions(
        ctx,
        gameId,
        nightNumber,
        'cursed_conversion',
      );
      const acks = await getNightActions(
        ctx,
        gameId,
        nightNumber,
        'cursed_conversion_ack',
      );
      return acks.length >= conversions.length;
    }
    case 'doppelganger_dawn':
    case 'doppelganger_dusk':
      // No ack required — the converted Doppelganger reads the modal during
      // the dwell window and the step auto-advances when the dwell elapses.
      // Cleanup of pendingDoppelgangerReveal happens in advanceFromCurrentStep
      // so the field is gone by the time the next step renders.
      return true;
  }
}

// ───── Bot auto-resolve ─────────────────────────────────────────────────────

function pickRandom<T>(items: readonly T[]): T | undefined {
  if (items.length === 0) return undefined;
  return items[Math.floor(Math.random() * items.length)];
}

/**
 * PI's trio check: target's seat plus the seats immediately clockwise and
 * counter-clockwise (wrapping around the circle). Returns 'wolf' if any of
 * the three are wolf-team (Wolf Man IS detected by PI, unlike the Seer's
 * blind spot). Dead neighbors still count toward the trio per house rules.
 */
function piTrioResult(
  target: Player,
  allPlayers: Player[],
  playerCount: number,
): 'wolf' | 'village' {
  const seat = target.seatPosition;
  if (typeof seat !== 'number') return 'village';
  const leftSeat = (seat - 1 + playerCount) % playerCount;
  const rightSeat = (seat + 1) % playerCount;
  const left = allPlayers.find(p => p.seatPosition === leftSeat);
  const right = allPlayers.find(p => p.seatPosition === rightSeat);
  const trio = [target, left, right].filter((p): p is Player => !!p);
  return trio.some(p => p.role && isWolfTeam(p.role)) ? 'wolf' : 'village';
}

/**
 * Walk seats from `startSeat` in `step` direction (skip-dead) and return the
 * id of the first alive seat encountered. Returns null if no other alive
 * seat exists. App convention (Mad Bomber, Leprechaun): right = step -1,
 * left = step +1.
 */
function nextAliveSeatId(
  startSeat: number,
  step: 1 | -1,
  total: number,
  bySeat: Map<number, Player>,
): Id<'players'> | null {
  let cursor = startSeat;
  for (let i = 0; i < total; i++) {
    cursor = ((cursor + step) % total + total) % total;
    if (cursor === startSeat) break;
    const p = bySeat.get(cursor);
    if (!p || !p.alive) continue;
    return p._id;
  }
  return null;
}

/**
 * Returns the players a mentalist may legally compare on a given night —
 * everyone alive except themselves and either of their two prior-night
 * targets (per house rule: no back-to-back picks).
 */
function mentalistValidPool(
  mentalist: Player,
  alivePlayers: Player[],
): Player[] {
  const lastTargets = (mentalist.roleState?.mentalistLastTargets ??
    []) as Id<'players'>[];
  const excluded = new Set<Id<'players'>>(lastTargets);
  return alivePlayers.filter(
    p => p._id !== mentalist._id && !excluded.has(p._id),
  );
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
      const game = await ctx.db.get(gameId);
      const required = game
        ? computeRequiredKills(game, alivePlayers)
        : 1;
      if (required === 0) return;
      const candidates = alivePlayers.filter(p => !isWolfTeam(p.role || ''));
      // Pick `required` distinct random victims. Shuffle by sort + random.
      const shuffled = [...candidates].sort(() => Math.random() - 0.5);
      const picks = shuffled.slice(0, required);
      if (picks.length === 0) return;
      // Bot wolf votes get pointed at the FIRST pick so the picker UI shows
      // a clean consensus snapshot if anyone refreshes mid-resolve. (The
      // second kill is recorded directly as a wolf_kill row.)
      for (const wolf of actors) {
        await ctx.db.patch(wolf._id, {
          roleState: { ...(wolf.roleState ?? {}), wolfVote: picks[0]._id },
        });
      }
      for (const victim of picks) {
        await ctx.db.insert('nightActions', {
          gameId,
          nightNumber,
          actorPlayerId: actors[0]._id,
          actionType: 'wolf_kill',
          targetPlayerId: victim._id,
          resolvedAt: now,
        });
      }
      return;
    }
    case 'nightmare_wolf': {
      // Bot NW saves the charges — same conservative path as Huntress.
      for (const nw of actors) {
        await ctx.db.insert('nightActions', {
          gameId,
          nightNumber,
          actorPlayerId: nw._id,
          actionType: 'nightmare_skip',
          resolvedAt: now,
        });
      }
      return;
    }
    case 'seer': {
      for (const seer of actors) {
        const candidates = alivePlayers.filter(p => p._id !== seer._id);
        const target = pickRandom(candidates);
        if (!target) continue;
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
      }
      return;
    }
    case 'pi': {
      // Bot PI uses their power on a random target so we exercise the result
      // pipeline in tests. Result is computed but not displayed (no UI for
      // bots) — it's still recorded for spectator history later.
      for (const pi of actors) {
        const target = pickRandom(alivePlayers);
        if (!target) continue;
        const result = piTrioResult(target, alivePlayers, alivePlayers.length);
        await ctx.db.insert('nightActions', {
          gameId,
          nightNumber,
          actorPlayerId: pi._id,
          actionType: 'pi_check',
          targetPlayerId: target._id,
          result: { team: result },
          resolvedAt: now,
        });
      }
      return;
    }
    case 'mentalist': {
      // Bot mentalist picks two random valid targets (excluding self and
      // last night's two targets per house rules). When the valid pool is
      // less than 2, the bot passes — same auto-pass path a human takes
      // when shorthanded.
      for (const m of actors) {
        const candidates = mentalistValidPool(m, alivePlayers);
        if (candidates.length < 2) {
          await ctx.db.insert('nightActions', {
            gameId,
            nightNumber,
            actorPlayerId: m._id,
            actionType: 'mentalist_skip',
            resolvedAt: now,
          });
          continue;
        }
        const first = pickRandom(candidates)!;
        const remaining = candidates.filter(p => p._id !== first._id);
        const second = pickRandom(remaining)!;
        const sameTeam =
          teamForRole(first.role || '') === teamForRole(second.role || '')
            ? 'same'
            : 'different';
        await ctx.db.insert('nightActions', {
          gameId,
          nightNumber,
          actorPlayerId: m._id,
          actionType: 'mentalist_check',
          targetPlayerId: first._id,
          result: {
            firstId: first._id,
            secondId: second._id,
            sameTeam,
          },
          resolvedAt: now,
        });
      }
      return;
    }
    case 'witch': {
      // Bot witch always passes — no save, no poison, just done. Real games
      // don't have bots, so this is a sane test default.
      for (const w of actors) {
        await ctx.db.insert('nightActions', {
          gameId,
          nightNumber,
          actorPlayerId: w._id,
          actionType: 'witch_done',
          resolvedAt: now,
        });
      }
      return;
    }
    case 'leprechaun': {
      // Bot leprechaun always leaves the kill in place — no move-off spend.
      // On diseased nights the row still records direction='leave' (no wolf
      // kill exists to redirect anyway).
      for (const lp of actors) {
        await ctx.db.insert('nightActions', {
          gameId,
          nightNumber,
          actorPlayerId: lp._id,
          actionType: 'leprechaun_redirect',
          result: { direction: 'leave' },
          resolvedAt: now,
        });
      }
      return;
    }
    case 'bodyguard': {
      for (const bg of actors) {
        const lastProtected = bg.roleState?.bgLastProtected as
          | Id<'players'>
          | undefined;
        const selfUsed = !!bg.roleState?.bgSelfProtectUsed;
        const candidates = alivePlayers.filter(p => {
          if (lastProtected && p._id === lastProtected) return false;
          if (p._id === bg._id && selfUsed) return false;
          return true;
        });
        const target = pickRandom(candidates);
        if (!target) continue;
        await ctx.db.insert('nightActions', {
          gameId,
          nightNumber,
          actorPlayerId: bg._id,
          actionType: 'bg_protect',
          targetPlayerId: target._id,
          resolvedAt: now,
        });
      }
      return;
    }
    case 'huntress': {
      // Bot huntress saves her shot — never burns a one-time power on a
      // random target in tests.
      for (const h of actors) {
        await ctx.db.insert('nightActions', {
          gameId,
          nightNumber,
          actorPlayerId: h._id,
          actionType: 'huntress_skip',
          resolvedAt: now,
        });
      }
      return;
    }
    case 'revealer': {
      // Bot revealer always passes — die-on-miss makes random targeting in
      // tests a guaranteed self-kill, which is rarely what we want.
      for (const r of actors) {
        await ctx.db.insert('nightActions', {
          gameId,
          nightNumber,
          actorPlayerId: r._id,
          actionType: 'revealer_skip',
          resolvedAt: now,
        });
      }
      return;
    }
    case 'reviler': {
      // Same reasoning as revealer — bot passes to avoid auto-suicide in tests.
      for (const r of actors) {
        await ctx.db.insert('nightActions', {
          gameId,
          nightNumber,
          actorPlayerId: r._id,
          actionType: 'reviler_skip',
          resolvedAt: now,
        });
      }
      return;
    }
    case 'cursed_conversion':
      // Conversion is computed inline in enterStep, not here.
      return;
    case 'doppelganger_dawn':
    case 'doppelganger_dusk':
      // Detection is inline in enterStep; bot acks are handled there too.
      return;
  }
}

// ───── Morning resolution ───────────────────────────────────────────────────

async function resolveMorning(
  ctx: MutationCtx,
  gameId: Id<'games'>,
  nightNumber: number,
) {
  const now = Date.now();

  // Reset the Diseased-block carryover. The flag was honored when wolves
  // entered their step tonight (no picker, wolf_blocked row inserted); we
  // clear it here so the next wolves step runs normally. If a fresh Diseased
  // death lands tonight, the trigger near the end of this function flips it
  // back on for the following night.
  const gameAtStart = await ctx.db.get(gameId);
  if (gameAtStart?.wolvesBlockedNextNight) {
    await ctx.db.patch(gameId, { wolvesBlockedNextNight: false });
  }
  // Reset Wolf Cub vengeance. The flag was honored when wolves entered
  // their step tonight (requiredKills = 2); we consume it here whether or
  // not it was actually used. If the cub dies tonight (or via a death
  // trigger cascade in the same morning), `flagCubDeathIfApplicable`
  // below sets it back on for the following night.
  if (gameAtStart?.wolfCubVengeance) {
    await ctx.db.patch(gameId, { wolfCubVengeance: false });
  }

  // Build a set of death candidates from every kill source recorded for the
  // night, then filter through protection (BG, future: Tough Guy, etc.) and
  // commit the survivors. Each new death source plugs into the candidates
  // map; each new protection source plugs into the protected set.
  // `protectable: false` flags self-deaths (Revealer/Reviler miss) that BG
  // explicitly cannot save per house rules.
  type Candidate = { cause: string; protectable: boolean };
  const candidates = new Map<Id<'players'>, Candidate>();
  const addCandidate = (
    id: Id<'players'>,
    cause: string,
    protectable: boolean,
  ) => {
    const existing = candidates.get(id);
    if (!existing) {
      candidates.set(id, { cause, protectable });
      return;
    }
    // Once an entry is unprotectable, keep it that way — a self-death always
    // kills even if the same player is also a protectable target tonight.
    if (!existing.protectable) return;
    if (!protectable) candidates.set(id, { cause, protectable: false });
  };

  // Wounded Tough Guys die at this morning's resolution, regardless of any
  // protection (BG can't save twice from the same wound). Their flag was set
  // at the previous morning when they survived a wolf attack.
  const allPlayersForTG = await ctx.db
    .query('players')
    .withIndex('by_game', q => q.eq('gameId', gameId))
    .collect();
  for (const p of allPlayersForTG) {
    if (p.alive && p.role === 'Tough Guy' && p.roleState?.toughGuyWounded) {
      addCandidate(p._id, 'tough_guy', false);
    }
  }
  // Leprechaun in the game = plausible deniability for wolf-on-wolf kills.
  // Without a Leprechaun, wolves who target a fellow wolf are obviously
  // abusing the mechanic to farm their own death powers (Wolf Cub vengeance,
  // Hunter Wolf shot), so we suppress those benefits below. The Lep counts
  // even if dead — at the table the wolves don't necessarily know that, and
  // they may have been hoping for a redirect.
  const leprechaunInGame = allPlayersForTG.some(p => p.role === 'Leprechaun');
  const roleById = new Map(allPlayersForTG.map(p => [p._id, p.role ?? '']));

  const kills = await getNightActions(ctx, gameId, nightNumber, 'wolf_kill');
  // Leprechaun redirect: only applies to the FIRST wolf_kill row (oldest by
  // resolvedAt). A direction of 'L' or 'R' swaps that kill's effective
  // target to result.newTargetId; 'leave' is a no-op for resolution.
  // Downstream protections (BG, witch save, TG resist) and the Diseased
  // trigger all key off the EFFECTIVE target so the redirect propagates
  // naturally.
  const sortedKills = kills.slice().sort((a, b) => a.resolvedAt - b.resolvedAt);
  const redirects = await getNightActions(
    ctx,
    gameId,
    nightNumber,
    'leprechaun_redirect',
  );
  let firstKillOverride: Id<'players'> | null = null;
  for (const r of redirects) {
    const dir = r.result?.direction;
    if (dir === 'L' || dir === 'R') {
      const newId = r.result?.newTargetId as Id<'players'> | undefined;
      if (newId) firstKillOverride = newId;
      break;
    }
  }
  const effectiveKillTarget = (
    k: (typeof kills)[number],
  ): Id<'players'> | undefined => {
    if (firstKillOverride && sortedKills[0]?._id === k._id) {
      return firstKillOverride;
    }
    return k.targetPlayerId as Id<'players'> | undefined;
  };
  for (const kill of kills) {
    const id = effectiveKillTarget(kill);
    if (id) addCandidate(id, 'wolf', true);
  }

  const witchPoisons = await getNightActions(ctx, gameId, nightNumber, 'witch_poison');
  for (const p of witchPoisons) {
    if (p.targetPlayerId) addCandidate(p.targetPlayerId, 'poison', true);
  }

  const huntressShots = await getNightActions(ctx, gameId, nightNumber, 'huntress_shot');
  for (const h of huntressShots) {
    if (h.targetPlayerId) addCandidate(h.targetPlayerId, 'huntress', true);
  }

  // Revealer: wolf target → target dies (BG can save). Non-wolf target →
  // shooter dies (BG cannot save the shooter per house rules).
  const revealerShots = await getNightActions(ctx, gameId, nightNumber, 'revealer_shot');
  for (const rs of revealerShots) {
    if (!rs.targetPlayerId || !rs.actorPlayerId) continue;
    const target = await ctx.db.get(rs.targetPlayerId);
    if (!target) continue;
    if (target.role && isWolfTeam(target.role)) {
      addCandidate(rs.targetPlayerId, 'revealer', true);
    } else {
      addCandidate(rs.actorPlayerId, 'revealer-miss', false);
    }
  }

  // Reviler: special-villager target (village team minus plain Villager) →
  // target dies (BG can save). Anything else (plain Villager, wolves, Minion,
  // Reviler... — impossible since no self-shot) → shooter dies (BG cannot save).
  const revilerShots = await getNightActions(ctx, gameId, nightNumber, 'reviler_shot');
  for (const rs of revilerShots) {
    if (!rs.targetPlayerId || !rs.actorPlayerId) continue;
    const target = await ctx.db.get(rs.targetPlayerId);
    if (!target) continue;
    if (isSpecialVillager(target.role)) {
      addCandidate(rs.targetPlayerId, 'reviler', true);
    } else {
      addCandidate(rs.actorPlayerId, 'reviler-miss', false);
    }
  }

  const protectedTargets = new Set<Id<'players'>>();
  const bgProtects = await getNightActions(ctx, gameId, nightNumber, 'bg_protect');
  for (const bg of bgProtects) {
    if (bg.targetPlayerId) protectedTargets.add(bg.targetPlayerId);
  }
  const witchSaves = await getNightActions(ctx, gameId, nightNumber, 'witch_save');
  for (const s of witchSaves) {
    if (s.targetPlayerId) protectedTargets.add(s.targetPlayerId);
  }

  // Tracks every player who actually dies this morning resolution. Used at
  // the end to build the death-trigger queue from any Hunter/HW/MB among
  // them.
  const newDeadIds: Id<'players'>[] = [];

  // Tough Guy first-attack survival. For every TG attacked by wolves this
  // night who isn't already wounded and isn't BG-protected, drop the wolf
  // entry from candidates ONLY when wolf is their sole cause (poison,
  // huntress, etc. still kill them normally — TG resists wolf bite, not
  // poison or arrows). They get wounded and die at the next morning.
  const tgsToWound = new Set<Id<'players'>>();
  for (const k of kills) {
    const effId = effectiveKillTarget(k);
    if (!effId) continue;
    const tg = await ctx.db.get(effId);
    if (!tg || tg.role !== 'Tough Guy') continue;
    if (tg.roleState?.toughGuyWounded) continue;
    if (protectedTargets.has(tg._id)) continue; // BG cleanly saved, no wound
    const cand = candidates.get(tg._id);
    if (cand?.cause === 'wolf') {
      candidates.delete(tg._id);
      tgsToWound.add(tg._id);
    }
    // else: another death source (poison, huntress, etc.) — they die from
    // that; we deliberately don't burn the wound on a TG who's dying anyway.
  }

  // Cursed conversion. Any cursed_conversion row written this night already
  // verified (at the cursed_conversion step) that the wolves' effective
  // target was an unprotected Cursed who survived all other death sources.
  // Suppress the wolf death candidate so the Cursed lives, and flip their
  // role to 'Werewolf' so all downstream logic (win-condition parity,
  // tomorrow night's wolf wake, seer reads, etc.) treats them as wolf-team.
  // originalRole on the player still reads 'Cursed' so end-game can show
  // the conversion arc.
  const cursedConversions = await getNightActions(
    ctx,
    gameId,
    nightNumber,
    'cursed_conversion',
  );
  const convertedCursedIds = new Set<Id<'players'>>();
  for (const c of cursedConversions) {
    const cid = c.actorPlayerId as Id<'players'> | undefined;
    if (!cid) continue;
    convertedCursedIds.add(cid);
    candidates.delete(cid);
  }

  for (const [targetId, c] of candidates) {
    if (c.protectable && protectedTargets.has(targetId)) continue;
    const target = await ctx.db.get(targetId);
    if (!target || !target.alive) continue;
    await ctx.db.patch(targetId, { alive: false });
    await ctx.db.insert('nightActions', {
      gameId,
      nightNumber,
      actorPlayerId: undefined,
      actionType: 'death',
      targetPlayerId: targetId,
      result: { cause: c.cause },
      resolvedAt: now,
    });
    newDeadIds.push(targetId);
  }

  // Self-inflicted wolf-team deaths (wolves voted to kill one of their own)
  // forfeit their death powers when there's no Leprechaun in the game — see
  // the leprechaunInGame comment above. Cause === 'wolf' and dead player is
  // wolf-team is the signature. With a Lep present, this set stays empty
  // and all powers fire normally.
  const suppressedSelfWolfKills = new Set<Id<'players'>>();
  if (!leprechaunInGame) {
    for (const id of newDeadIds) {
      const cause = candidates.get(id)?.cause;
      if (cause !== 'wolf') continue;
      const role = roleById.get(id);
      if (role && isWolfTeam(role)) suppressedSelfWolfKills.add(id);
    }
  }

  // Tough Guy wound persistence. Only flag survivors — if a TG was in
  // tgsToWound but somehow died anyway (defensive: e.g., wound flag race),
  // we skip the patch. The `tough_guy_wounded` action row gives the
  // morning view a private "you survived" signal AND lets end-game show it.
  for (const tgId of tgsToWound) {
    const tg = await ctx.db.get(tgId);
    if (!tg || !tg.alive) continue;
    await ctx.db.patch(tgId, {
      roleState: { ...(tg.roleState ?? {}), toughGuyWounded: true },
    });
    await ctx.db.insert('nightActions', {
      gameId,
      nightNumber,
      actorPlayerId: tgId,
      actionType: 'tough_guy_wounded',
      targetPlayerId: tgId,
      resolvedAt: now,
    });
  }

  // Diseased trigger. If any Diseased player actually died from a wolf kill
  // this morning, set the carryover flag so the next wolves step inserts a
  // `wolf_blocked` action instead of a kill.
  for (const k of kills) {
    const effId = effectiveKillTarget(k);
    if (!effId) continue;
    const t = await ctx.db.get(effId);
    if (!t || t.role !== 'Diseased') continue;
    if (t.alive) continue; // saved by BG or witch — no trigger
    await ctx.db.patch(gameId, { wolvesBlockedNextNight: true });
    break;
  }

  // Wolf Cub trigger. If the cub died from any source this morning,
  // remaining wolves get 2 kills next night. The flag sits alongside the
  // Diseased flag — at the next wolves step, Diseased block takes priority
  // (vengeance is wasted in that case, per house rules). Self-inflicted
  // wolf-on-wolf cub kills are excluded when there's no Leprechaun (no
  // farming the vengeance bonus).
  await flagCubDeathIfApplicable(
    ctx,
    gameId,
    newDeadIds.filter(id => !suppressedSelfWolfKills.has(id)),
  );

  // Persist PI usage across nights — once they investigate, they're spent
  // for the rest of the game.
  const piChecks = await getNightActions(ctx, gameId, nightNumber, 'pi_check');
  for (const pc of piChecks) {
    if (!pc.actorPlayerId) continue;
    const pi = await ctx.db.get(pc.actorPlayerId);
    if (!pi) continue;
    await ctx.db.patch(pc.actorPlayerId, {
      roleState: { ...(pi.roleState ?? {}), piUsed: true },
    });
  }

  // Persist Huntress usage across nights — house rule: a shot consumes her
  // power even when BG blocks it, so we flip the flag on every shot row
  // (skip rows preserve the shot for later).
  for (const hs of huntressShots) {
    if (!hs.actorPlayerId) continue;
    const huntress = await ctx.db.get(hs.actorPlayerId);
    if (!huntress) continue;
    await ctx.db.patch(hs.actorPlayerId, {
      roleState: { ...(huntress.roleState ?? {}), huntressUsed: true },
    });
  }

  // Persist Nightmare Wolf charges across nights — append tonight's target
  // to nightmaresUsed at morning so the NW stays in stepActors during
  // the current night's locked "PUT TO SLEEP: X" confirmation view, but
  // gets cleanly filtered out next night once the charge is spent.
  const nightmareRows = await getNightActions(
    ctx,
    gameId,
    nightNumber,
    'nightmare_put_to_sleep',
  );
  for (const nm of nightmareRows) {
    if (!nm.actorPlayerId || !nm.targetPlayerId) continue;
    const nw = await ctx.db.get(nm.actorPlayerId);
    if (!nw) continue;
    const used =
      (nw.roleState?.nightmaresUsed as Id<'players'>[] | undefined) ?? [];
    if (used.some(id => id === nm.targetPlayerId)) continue; // defensive idempotency
    await ctx.db.patch(nm.actorPlayerId, {
      roleState: {
        ...(nw.roleState ?? {}),
        nightmaresUsed: [...used, nm.targetPlayerId],
      },
    });
  }

  // Persist Witch potion usage across nights. Save and poison are
  // independent one-time potions, so each is tracked separately.
  for (const s of witchSaves) {
    if (!s.actorPlayerId) continue;
    const witch = await ctx.db.get(s.actorPlayerId);
    if (!witch) continue;
    await ctx.db.patch(s.actorPlayerId, {
      roleState: { ...(witch.roleState ?? {}), witchSaveUsed: true },
    });
  }
  for (const p of witchPoisons) {
    if (!p.actorPlayerId) continue;
    const witch = await ctx.db.get(p.actorPlayerId);
    if (!witch) continue;
    await ctx.db.patch(p.actorPlayerId, {
      roleState: { ...(witch.roleState ?? {}), witchPoisonUsed: true },
    });
  }

  // Persist BG state across nights — this night's protected target becomes
  // bgLastProtected (used to forbid back-to-back), and self-protect is
  // marked used if the BG picked themselves.
  for (const bg of bgProtects) {
    if (!bg.actorPlayerId || !bg.targetPlayerId) continue;
    const bgPlayer = await ctx.db.get(bg.actorPlayerId);
    if (!bgPlayer) continue;
    const nextRoleState = { ...(bgPlayer.roleState ?? {}) };
    nextRoleState.bgLastProtected = bg.targetPlayerId;
    if (bg.targetPlayerId === bg.actorPlayerId) {
      nextRoleState.bgSelfProtectUsed = true;
    }
    await ctx.db.patch(bg.actorPlayerId, { roleState: nextRoleState });
  }

  // Persist Mentalist back-to-back lock. A real comparison records this
  // night's two targets; an auto-pass (no eligible pair) clears the lock so
  // they're not still excluded on the next night.
  const mentalistChecks = await getNightActions(
    ctx,
    gameId,
    nightNumber,
    'mentalist_check',
  );
  for (const mc of mentalistChecks) {
    if (!mc.actorPlayerId) continue;
    const mentalist = await ctx.db.get(mc.actorPlayerId);
    if (!mentalist) continue;
    const firstId = mc.result?.firstId as Id<'players'> | undefined;
    const secondId = mc.result?.secondId as Id<'players'> | undefined;
    if (!firstId || !secondId) continue;
    await ctx.db.patch(mc.actorPlayerId, {
      roleState: {
        ...(mentalist.roleState ?? {}),
        mentalistLastTargets: [firstId, secondId],
      },
    });
  }
  const mentalistSkips = await getNightActions(
    ctx,
    gameId,
    nightNumber,
    'mentalist_skip',
  );
  for (const ms of mentalistSkips) {
    if (!ms.actorPlayerId) continue;
    const mentalist = await ctx.db.get(ms.actorPlayerId);
    if (!mentalist) continue;
    const next = { ...(mentalist.roleState ?? {}) };
    delete next.mentalistLastTargets;
    await ctx.db.patch(ms.actorPlayerId, { roleState: next });
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

  // Mad Bomber detonations resolve INLINE — every bomber in the morning
  // death list immediately takes their alive neighbors with them. Night
  // protections (BG / witch) don't apply: those only block the bomber's
  // own night-source death; once the bomber is confirmed dead in morning
  // resolution, the explosion is unstoppable. Cascade victims who are
  // themselves bombers chain inside `applyMadBomberBlast`. Hunter/HW
  // among the cascade are picked up by the trigger walker below.
  const bomberIds = await filterRole(ctx, newDeadIds, 'Mad Bomber');
  for (const bomberId of bomberIds) {
    const blastDead = await applyMadBomberBlast(
      ctx,
      gameId,
      nightNumber,
      bomberId,
    );
    for (const id of blastDead) newDeadIds.push(id);
  }
  // MB cascade victims trigger 'day'-phase Doppelganger conversions
  // (deferred reveal at the next dawn step). Direct night-kill deaths
  // were already handled at the dusk step before morning resolution.
  // Hooked at applyTriggerDeath so every cascade death (including chains)
  // is covered without double-walking the list here.

  // Hunter / Hunter Wolf among the newly-dead each generate a queued
  // trigger. Two paths now:
  //
  //   * Any Hunter/HW died → morning is shown first (with the death),
  //     then host taps BEGIN DAY → engine enters 'triggers' phase and
  //     the actor decides.
  //   * No Hunter/HW died → straight to morning. The bomber's cascade
  //     (already applied above) folds into the morning death list.
  // Self-inflicted wolf-on-wolf Hunter Wolf deaths don't get to shoot when
  // there's no Leprechaun — see suppressedSelfWolfKills above.
  // Flip Cursed → Werewolf after deaths/cascades land but before the
  // win-condition check. This makes parity reflect the new pack size
  // immediately (1-wolf + freshly-converted-Cursed becomes 2 wolves for
  // counting). They wake with the pack starting next night via the
  // standard wolf-recognition path that reads current `role`.
  for (const cid of convertedCursedIds) {
    const cursed = await ctx.db.get(cid);
    if (!cursed || !cursed.alive) continue;
    await ctx.db.patch(cid, { role: 'Werewolf' });
  }

  const hunterDeaths = (
    await filterRoles(ctx, newDeadIds, ['Hunter', 'Hunter Wolf'])
  ).filter(id => !suppressedSelfWolfKills.has(id));
  if (hunterDeaths.length === 0) {
    await ctx.db.patch(gameId, { phase: 'morning', nightStep: undefined });
    await recordWinIfReached(ctx, gameId);
    return;
  }
  await ctx.db.patch(gameId, {
    phase: 'morning',
    nightStep: undefined,
    triggersFollowUp: 'day',
  });
  await enqueueTriggersForDeaths(ctx, gameId, hunterDeaths);
  // Don't recordWinIfReached yet — the triggers may shift the count
  // (Hunter cascade) before the game is officially over.
}

/**
 * Subset of `ids` whose player role exactly matches `role`. Death order
 * is preserved.
 */
async function filterRole(
  ctx: MutationCtx,
  ids: readonly Id<'players'>[],
  role: string,
): Promise<Id<'players'>[]> {
  const out: Id<'players'>[] = [];
  for (const id of ids) {
    const p = await ctx.db.get(id);
    if (p?.role === role) out.push(id);
  }
  return out;
}

/**
 * Subset of `ids` whose player role is in `roles`. Death order preserved.
 */
async function filterRoles(
  ctx: MutationCtx,
  ids: readonly Id<'players'>[],
  roles: readonly string[],
): Promise<Id<'players'>[]> {
  const out: Id<'players'>[] = [];
  for (const id of ids) {
    const p = await ctx.db.get(id);
    if (p?.role && roles.includes(p.role)) out.push(id);
  }
  return out;
}

// ───── Cursed conversion ───────────────────────────────────────────────────
//
// Runs at the cursed_conversion night step (the last step before morning),
// after every other role has acted and locked in its decisions. Walks every
// alive Cursed and writes a `cursed_conversion` action row for each one who:
//
//   - is the effective wolf-kill target (post-Leprechaun redirect), AND
//   - is not protected by Bodyguard or Witch save, AND
//   - is not going to die from another source tonight (Witch poison,
//     Huntress shot, Reviler hit, etc.) that BG didn't also protect from.
//
// The wolf_kill row stays pristine (Leprechaun-style). The `cursed_conversion`
// row is the trigger the reveal screen reads, and morning resolution consumes
// the row to suppress the wolf death AND patch the player's `role` from
// 'Cursed' to 'Werewolf'. Per house rule: BG protection on a Cursed blocks
// both the death AND the conversion — they stay village.

async function resolveCursedConversionsForNight(
  ctx: MutationCtx,
  gameId: Id<'games'>,
  nightNumber: number,
): Promise<void> {
  const players = await ctx.db
    .query('players')
    .withIndex('by_game', q => q.eq('gameId', gameId))
    .collect();
  const cursedPlayers = players.filter(
    p => p.alive && p.role === 'Cursed',
  );
  if (cursedPlayers.length === 0) return;

  // Effective wolf targets after the Leprechaun redirect on the first kill.
  const kills = await getNightActions(ctx, gameId, nightNumber, 'wolf_kill');
  const sortedKills = kills.slice().sort((a, b) => a.resolvedAt - b.resolvedAt);
  const redirects = await getNightActions(
    ctx,
    gameId,
    nightNumber,
    'leprechaun_redirect',
  );
  let firstKillOverride: Id<'players'> | null = null;
  for (const r of redirects) {
    const dir = r.result?.direction;
    if (dir === 'L' || dir === 'R') {
      const newId = r.result?.newTargetId as Id<'players'> | undefined;
      if (newId) firstKillOverride = newId;
      break;
    }
  }
  const effectiveTargets = new Set<Id<'players'>>();
  for (const k of kills) {
    if (firstKillOverride && sortedKills[0]?._id === k._id) {
      effectiveTargets.add(firstKillOverride);
    } else if (k.targetPlayerId) {
      effectiveTargets.add(k.targetPlayerId);
    }
  }

  // BG covers everything (including the conversion itself); Witch save
  // covers the wolf attack. A protected Cursed stays a villager.
  const protectedTargets = new Set<Id<'players'>>();
  const bgProtects = await getNightActions(ctx, gameId, nightNumber, 'bg_protect');
  const bgProtectedIds = new Set<Id<'players'>>();
  for (const bg of bgProtects) {
    if (bg.targetPlayerId) {
      protectedTargets.add(bg.targetPlayerId);
      bgProtectedIds.add(bg.targetPlayerId);
    }
  }
  const witchSaves = await getNightActions(ctx, gameId, nightNumber, 'witch_save');
  for (const s of witchSaves) {
    if (s.targetPlayerId) protectedTargets.add(s.targetPlayerId);
  }

  // Independent kill sources that would still kill the Cursed unless BG
  // also protected them. If any of these land, the Cursed dies — no
  // conversion (you can't convert a corpse).
  const otherKillTargets = new Set<Id<'players'>>();
  const witchPoisons = await getNightActions(ctx, gameId, nightNumber, 'witch_poison');
  for (const p of witchPoisons) {
    if (p.targetPlayerId && !bgProtectedIds.has(p.targetPlayerId)) {
      otherKillTargets.add(p.targetPlayerId);
    }
  }
  const huntressShots = await getNightActions(ctx, gameId, nightNumber, 'huntress_shot');
  for (const h of huntressShots) {
    if (h.targetPlayerId && !bgProtectedIds.has(h.targetPlayerId)) {
      otherKillTargets.add(h.targetPlayerId);
    }
  }
  const revealerShots = await getNightActions(ctx, gameId, nightNumber, 'revealer_shot');
  for (const rs of revealerShots) {
    if (!rs.targetPlayerId) continue;
    const target = players.find(p => p._id === rs.targetPlayerId);
    if (target?.role && isWolfTeam(target.role) && !bgProtectedIds.has(rs.targetPlayerId)) {
      otherKillTargets.add(rs.targetPlayerId);
    }
  }
  const revilerShots = await getNightActions(ctx, gameId, nightNumber, 'reviler_shot');
  for (const rs of revilerShots) {
    if (!rs.targetPlayerId) continue;
    const target = players.find(p => p._id === rs.targetPlayerId);
    if (target && isSpecialVillager(target.role) && !bgProtectedIds.has(rs.targetPlayerId)) {
      otherKillTargets.add(rs.targetPlayerId);
    }
  }

  const now = Date.now();
  for (const cursed of cursedPlayers) {
    if (!effectiveTargets.has(cursed._id)) continue;
    if (protectedTargets.has(cursed._id)) continue;
    if (otherKillTargets.has(cursed._id)) continue;
    await ctx.db.insert('nightActions', {
      gameId,
      nightNumber,
      actorPlayerId: cursed._id,
      actionType: 'cursed_conversion',
      targetPlayerId: cursed._id,
      result: { willConvert: true },
      resolvedAt: now,
    });
  }
}

// ───── Sasquatch conversion ────────────────────────────────────────────────
//
// Sasquatch starts on the village team. The village's bargain: lynch one
// player every day. The first day with no lynch, the Sasquatch flips to the
// wolf team out of spite — wakes with the pack from that very night, votes
// with consensus on a kill, reads as a wolf to Seer/PI/Mentalist.
//
// Conversion fires at `beginNight` (day → night transition) BEFORE the phase
// patch, so any post-flip parity win is recognized immediately and the seer
// step on the new night reads the patched role. Role-patch over flag — same
// pattern as Cursed — so isWolfTeam / seerSees / teamForRole / checkWinCondition
// just work without additional branching.
//
// The flipped Sasquatch's `roleState.pendingSasquatchReveal` is set; the
// wolves-step view renders an overlay on their phone announcing the team
// change and listing the pack. The flag is cleared when the wolves step
// advances (see advanceFromCurrentStep).

/**
 * Returns true if the just-ended day produced a lynch (any `death` row tagged
 * with cause = 'lynch' and the given dayNumber). Lynch rows are stamped under
 * the previous night's nightNumber index by `tallyVote`, so we use the
 * pre-beginNight nightNumber to look them up.
 */
async function dayHadLynch(
  ctx: MutationCtx,
  gameId: Id<'games'>,
  prevNightNumber: number,
  dayNumber: number,
): Promise<boolean> {
  const rows = await ctx.db
    .query('nightActions')
    .withIndex('by_game_night', q =>
      q.eq('gameId', gameId).eq('nightNumber', prevNightNumber),
    )
    .collect();
  return rows.some(
    r =>
      r.actionType === 'death' &&
      (r.result as { cause?: string; dayNumber?: number } | undefined)?.cause ===
        'lynch' &&
      (r.result as { cause?: string; dayNumber?: number } | undefined)
        ?.dayNumber === dayNumber,
  );
}

/**
 * Called inside `beginNight` while the game is still in 'day' phase. If the
 * day that just ended had no lynch and any alive Sasquatch(es) are still
 * unflipped, role-patches each to 'Werewolf', stamps a `sasquatch_conversion`
 * row at the upcoming nightNumber, and sets `pendingSasquatchReveal` so the
 * wolves step renders the conversion overlay on their phone.
 *
 * Day 1 with no lynch flips on N1 — same rule, no special case. Multiple
 * Sasquatches each flip independently.
 */
async function fireSasquatchConversionsIfDayHadNoLynch(
  ctx: MutationCtx,
  gameId: Id<'games'>,
  prevNightNumber: number,
  dayNumber: number,
  upcomingNightNumber: number,
): Promise<void> {
  const players = await ctx.db
    .query('players')
    .withIndex('by_game', q => q.eq('gameId', gameId))
    .collect();
  const aliveSasquatch = players.filter(
    p => p.alive && p.role === 'Sasquatch',
  );
  if (aliveSasquatch.length === 0) return;
  if (await dayHadLynch(ctx, gameId, prevNightNumber, dayNumber)) return;

  const now = Date.now();
  for (const s of aliveSasquatch) {
    await ctx.db.insert('nightActions', {
      gameId,
      nightNumber: upcomingNightNumber,
      actorPlayerId: s._id,
      actionType: 'sasquatch_conversion',
      targetPlayerId: s._id,
      result: { fromRole: 'Sasquatch', toRole: 'Werewolf' },
      resolvedAt: now,
    });
    await ctx.db.patch(s._id, {
      role: 'Werewolf',
      roleState: { ...(s.roleState ?? {}), pendingSasquatchReveal: true },
    });
  }
}

/**
 * Strips `pendingSasquatchReveal` from any player carrying it. Called from
 * `advanceFromCurrentStep` when leaving the wolves step — by then the overlay
 * has rendered for at least the wolves dwell window, and subsequent nights
 * shouldn't replay the modal.
 */
async function clearSasquatchReveals(
  ctx: MutationCtx,
  gameId: Id<'games'>,
): Promise<void> {
  const players = await ctx.db
    .query('players')
    .withIndex('by_game', q => q.eq('gameId', gameId))
    .collect();
  for (const p of players) {
    if (!p.roleState?.pendingSasquatchReveal) continue;
    const { pendingSasquatchReveal, ...rest } = p.roleState;
    void pendingSasquatchReveal;
    await ctx.db.patch(p._id, { roleState: rest });
  }
}

// ───── Doppelganger conversion ─────────────────────────────────────────────
//
// Doppelganger picks a target on the first night. When that target dies
// from any cause, the Doppelganger inherits the target's role at the moment
// of death (current role — so a Cursed that already converted reads as
// Werewolf, etc.) with a blank-slate state (fresh shots, fresh potions,
// fresh cub vengeance — every per-role counter resets because we replace
// roleState entirely with `{ pendingDoppelgangerReveal: {…} }`).
//
// Reveal timing depends on when the target died:
//   - night kills (wolves/poison/huntress/revealer/reviler): the dusk step
//     PREDICTS the death and applies the conversion + private reveal at
//     end-of-night, before morning is announced. They play the next day
//     as the new role.
//   - morning kills (Hunter/HW shot, Mad Bomber cascade): conversion is
//     applied during morning resolution / trigger handling and the reveal
//     is deferred to the dawn step of the next night, so onlookers can't
//     spot the new wolf at the table mid-day.
//   - day kills (lynch, post-lynch Hunter triggers, lynch cascades):
//     same deferred-to-dawn reveal as morning kills.

/**
 * Applies one Doppelganger conversion. Patches role to the victim's role at
 * death, blanks roleState, drops in the pending-reveal sentinel, clears
 * doppelgangerTarget so the same Doppelganger can't fire twice, and writes
 * a `doppelganger_conversion` action row for end-game history.
 */
async function applyDoppelgangerConversion(
  ctx: MutationCtx,
  gameId: Id<'games'>,
  nightNumber: number,
  doppelganger: Doc<'players'>,
  victim: Doc<'players'>,
  triggerPhase: 'night' | 'day',
): Promise<void> {
  const newRole = victim.role ?? 'Villager';
  await ctx.db.patch(doppelganger._id, {
    role: newRole,
    doppelgangerTarget: undefined,
    roleState: {
      pendingDoppelgangerReveal: {
        fromRole: doppelganger.role ?? 'Doppelganger',
        toRole: newRole,
        triggerPhase,
        atNight: nightNumber,
        victimId: victim._id,
        victimName: victim.name,
      },
    },
  });
  // Stamp the conversion row under nightNumber: 0 so it groups with the
  // pre-game pick — semantically, "Doppelganged X" is a pregame decision
  // even though the row gets written when X actually dies. The real
  // fire-night is preserved in `result.firedAtNight` so end-game's
  // "Doppelganger → X (nN)" subtitle still surfaces when conversion
  // actually landed.
  await ctx.db.insert('nightActions', {
    gameId,
    nightNumber: 0,
    actorPlayerId: doppelganger._id,
    actionType: 'doppelganger_conversion',
    targetPlayerId: victim._id,
    result: {
      fromRole: doppelganger.role ?? 'Doppelganger',
      toRole: newRole,
      triggerPhase,
      firedAtNight: nightNumber,
    },
    resolvedAt: Date.now(),
  });

  // Becoming the Leprechaun grants fresh save potential per house rules —
  // the lifetime move-off list on the game record holds the prior Lep's
  // exhausted targets and needs to clear so the new Lep can redirect kills
  // away from any of them again. (Wolf-cub vengeance stays on; it's a
  // wolf-team reaction to losing the original cub, not a per-cub power.)
  if (newRole === 'Leprechaun') {
    await ctx.db.patch(gameId, { leprechaunMovedOff: [] });
  }
}

/**
 * For each Doppelganger whose target ID is in `justDiedIds`, fire the
 * conversion. Called from morning resolution (MB cascades, triggerPhase
 * = 'day'), trigger death (Hunter/HW shots, 'day'), and lynch tally
 * ('day'). The dusk step has its own dedicated path that runs BEFORE
 * morning resolution.
 */
export async function fireDoppelgangerConversionsForDeaths(
  ctx: MutationCtx,
  gameId: Id<'games'>,
  nightNumber: number,
  justDiedIds: readonly Id<'players'>[],
  triggerPhase: 'night' | 'day',
): Promise<void> {
  if (justDiedIds.length === 0) return;
  const players = await ctx.db
    .query('players')
    .withIndex('by_game', q => q.eq('gameId', gameId))
    .collect();
  const playerById = new Map(players.map(p => [p._id, p]));
  const doppelgangers = players.filter(
    p =>
      p.alive &&
      p.doppelgangerTarget !== undefined &&
      justDiedIds.includes(p.doppelgangerTarget),
  );
  for (const d of doppelgangers) {
    if (!d.doppelgangerTarget) continue;
    const victim = playerById.get(d.doppelgangerTarget);
    if (!victim) continue;
    await applyDoppelgangerConversion(
      ctx,
      gameId,
      nightNumber,
      d,
      victim,
      triggerPhase,
    );
  }
}

/**
 * Predicts who will die from direct night actions this night, mirroring the
 * survival logic in `resolveMorning` (wolves + poison + huntress + revealer
 * + reviler, minus BG/witch protection, Cursed conversion survival, and
 * Tough Guy first-attack survival). Run at the dusk step BEFORE morning
 * resolution so Doppelganger reveals can fire end-of-night.
 *
 * Returns a map of victim ID → the role they hold at the moment of death.
 * The role is the player's CURRENT role field — i.e., a Cursed who dies
 * from poison (no conversion) reads as 'Cursed', not 'Werewolf'.
 *
 * Caller is expected to have already let cursed_conversion run earlier in
 * the same night so the `cursed_conversion` rows are in place.
 */
async function predictNightVictims(
  ctx: MutationCtx,
  gameId: Id<'games'>,
  nightNumber: number,
): Promise<Map<Id<'players'>, string>> {
  const players = await ctx.db
    .query('players')
    .withIndex('by_game', q => q.eq('gameId', gameId))
    .collect();
  const playerById = new Map(players.map(p => [p._id, p]));

  type Candidate = { cause: string; protectable: boolean };
  const candidates = new Map<Id<'players'>, Candidate>();
  const addCandidate = (
    id: Id<'players'>,
    cause: string,
    protectable: boolean,
  ) => {
    const existing = candidates.get(id);
    if (!existing) {
      candidates.set(id, { cause, protectable });
      return;
    }
    if (!existing.protectable) return;
    if (!protectable) candidates.set(id, { cause, protectable: false });
  };

  // Wounded Tough Guys die this morning regardless of protection.
  for (const p of players) {
    if (p.alive && p.role === 'Tough Guy' && p.roleState?.toughGuyWounded) {
      addCandidate(p._id, 'tough_guy', false);
    }
  }

  // Wolves + Leprechaun redirect — mirrors resolveMorning's effectiveKillTarget.
  const kills = await getNightActions(ctx, gameId, nightNumber, 'wolf_kill');
  const sortedKills = kills.slice().sort((a, b) => a.resolvedAt - b.resolvedAt);
  const redirects = await getNightActions(
    ctx,
    gameId,
    nightNumber,
    'leprechaun_redirect',
  );
  let firstKillOverride: Id<'players'> | null = null;
  for (const r of redirects) {
    const dir = r.result?.direction;
    if (dir === 'L' || dir === 'R') {
      const newId = r.result?.newTargetId as Id<'players'> | undefined;
      if (newId) firstKillOverride = newId;
      break;
    }
  }
  const effectiveKillTargetId = (
    k: (typeof kills)[number],
  ): Id<'players'> | undefined => {
    if (firstKillOverride && sortedKills[0]?._id === k._id) {
      return firstKillOverride;
    }
    return k.targetPlayerId as Id<'players'> | undefined;
  };
  for (const k of kills) {
    const id = effectiveKillTargetId(k);
    if (id) addCandidate(id, 'wolf', true);
  }

  const witchPoisons = await getNightActions(
    ctx,
    gameId,
    nightNumber,
    'witch_poison',
  );
  for (const p of witchPoisons) {
    if (p.targetPlayerId) addCandidate(p.targetPlayerId, 'poison', true);
  }

  const huntressShots = await getNightActions(
    ctx,
    gameId,
    nightNumber,
    'huntress_shot',
  );
  for (const h of huntressShots) {
    if (h.targetPlayerId) addCandidate(h.targetPlayerId, 'huntress', true);
  }

  const revealerShots = await getNightActions(
    ctx,
    gameId,
    nightNumber,
    'revealer_shot',
  );
  for (const rs of revealerShots) {
    if (!rs.targetPlayerId || !rs.actorPlayerId) continue;
    const target = playerById.get(rs.targetPlayerId);
    if (!target) continue;
    if (target.role && isWolfTeam(target.role)) {
      addCandidate(rs.targetPlayerId, 'revealer', true);
    } else {
      addCandidate(rs.actorPlayerId, 'revealer-miss', false);
    }
  }

  const revilerShots = await getNightActions(
    ctx,
    gameId,
    nightNumber,
    'reviler_shot',
  );
  for (const rs of revilerShots) {
    if (!rs.targetPlayerId || !rs.actorPlayerId) continue;
    const target = playerById.get(rs.targetPlayerId);
    if (!target) continue;
    if (isSpecialVillager(target.role)) {
      addCandidate(rs.targetPlayerId, 'reviler', true);
    } else {
      addCandidate(rs.actorPlayerId, 'reviler-miss', false);
    }
  }

  // Cursed who survive their wolf attack don't die — remove from candidates.
  const cursedConversions = await getNightActions(
    ctx,
    gameId,
    nightNumber,
    'cursed_conversion',
  );
  for (const c of cursedConversions) {
    const cid = c.actorPlayerId as Id<'players'> | undefined;
    if (cid) candidates.delete(cid);
  }

  // Protections.
  const protectedTargets = new Set<Id<'players'>>();
  const bgProtects = await getNightActions(
    ctx,
    gameId,
    nightNumber,
    'bg_protect',
  );
  for (const bg of bgProtects) {
    if (bg.targetPlayerId) protectedTargets.add(bg.targetPlayerId);
  }
  const witchSaves = await getNightActions(
    ctx,
    gameId,
    nightNumber,
    'witch_save',
  );
  for (const s of witchSaves) {
    if (s.targetPlayerId) protectedTargets.add(s.targetPlayerId);
  }

  // Tough Guy first-attack survival: dropped from candidates if their ONLY
  // pending cause is 'wolf' and they're not wounded yet and not BG-protected.
  for (const k of kills) {
    const effId = effectiveKillTargetId(k);
    if (!effId) continue;
    const tg = playerById.get(effId);
    if (!tg || tg.role !== 'Tough Guy') continue;
    if (tg.roleState?.toughGuyWounded) continue;
    if (protectedTargets.has(tg._id)) continue;
    const cand = candidates.get(tg._id);
    if (cand?.cause === 'wolf') {
      candidates.delete(tg._id);
    }
  }

  // Final filter: remove protected + already-dead.
  const victims = new Map<Id<'players'>, string>();
  for (const [targetId, c] of candidates) {
    if (c.protectable && protectedTargets.has(targetId)) continue;
    const target = playerById.get(targetId);
    if (!target || !target.alive) continue;
    victims.set(targetId, target.role ?? 'Villager');
  }
  return victims;
}

/**
 * Runs at the start of the dusk step. Predicts night-kill victims, then
 * fires Doppelganger conversions for any whose target appears among them.
 */
/**
 * Inserts a `doppelganger_conversion_reveal` action row for every converted
 * Doppelganger whose phase matches the active reveal step. End-game history
 * renders it as a "CONVERSION" marker on the night the player actually
 * learned their new role — separate from the conversion row that may have
 * been written on an earlier night when the target was lynched.
 */
async function stampDoppelgangerRevealMarkers(
  ctx: MutationCtx,
  gameId: Id<'games'>,
  nightNumber: number,
  step: 'doppelganger_dawn' | 'doppelganger_dusk',
): Promise<void> {
  const expectedPhase = step === 'doppelganger_dawn' ? 'day' : 'night';
  const players = await ctx.db
    .query('players')
    .withIndex('by_game', q => q.eq('gameId', gameId))
    .collect();
  const now = Date.now();
  for (const p of players) {
    if (!p.alive) continue;
    const pending = p.roleState?.pendingDoppelgangerReveal;
    if (pending?.triggerPhase !== expectedPhase) continue;
    await ctx.db.insert('nightActions', {
      gameId,
      nightNumber,
      actorPlayerId: p._id,
      actionType: 'doppelganger_conversion_reveal',
      resolvedAt: now,
    });
  }
}

async function resolveDoppelgangerDuskConversions(
  ctx: MutationCtx,
  gameId: Id<'games'>,
  nightNumber: number,
): Promise<void> {
  const victims = await predictNightVictims(ctx, gameId, nightNumber);
  if (victims.size === 0) return;
  const players = await ctx.db
    .query('players')
    .withIndex('by_game', q => q.eq('gameId', gameId))
    .collect();
  const doppelgangers = players.filter(
    p =>
      p.alive &&
      p.doppelgangerTarget !== undefined &&
      victims.has(p.doppelgangerTarget),
  );
  for (const d of doppelgangers) {
    if (!d.doppelgangerTarget) continue;
    const victim = players.find(p => p._id === d.doppelgangerTarget);
    if (!victim) continue;
    await applyDoppelgangerConversion(
      ctx,
      gameId,
      nightNumber,
      d,
      victim,
      'night',
    );
  }
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
  const actors = activePlayersForStep(step, alive, game.nightNumber);

  // A witch whose save AND poison are both spent has nothing left to decide,
  // so we pre-record their "done" — same path as a bot — and let the dwell
  // run normally. Outside observers see the step take a regular 6–12 s, with
  // no tell that the witch's potions were exhausted.
  const witchHasNothingLeft =
    step === 'witch' &&
    actors.length > 0 &&
    actors.every(
      a => !!a.roleState?.witchSaveUsed && !!a.roleState?.witchPoisonUsed,
    );

  // A mentalist who can't form a legal pair (self is never valid + last
  // night's two targets are off-limits) auto-passes. Same cloaking — the
  // step still dwells normally before advancing.
  const mentalistShorthanded =
    step === 'mentalist' &&
    actors.length > 0 &&
    actors.every(a => mentalistValidPool(a, alive).length < 2);

  // Wolves are blocked tonight because a Diseased was eaten last night.
  // Wolves DO see the blocked view (they need to know they can't act), but
  // nobody else hears about it — the village's mystery is preserved. The
  // flag stays set until the next morning's resolution clears it, which
  // makes refreshStep replay correctly.
  const wolvesBlocked = step === 'wolves' && !!game.wolvesBlockedNextNight;

  if (wolvesBlocked) {
    await ctx.db.insert('nightActions', {
      gameId,
      nightNumber: game.nightNumber,
      actorPlayerId: actors[0]?._id,
      actionType: 'wolf_blocked',
      resolvedAt: Date.now(),
    });
  } else if (step === 'cursed_conversion') {
    // No actor input — compute conversion eligibility inline so the dwell
    // window already has the row to read for the Cursed's private reveal.
    await resolveCursedConversionsForNight(ctx, gameId, game.nightNumber);
  } else if (step === 'doppelganger_dusk') {
    // Predict tonight's victims and fire any same-night Doppelganger
    // conversions before morning resolution runs. The step auto-advances
    // on dwell expiry — no ack required.
    await resolveDoppelgangerDuskConversions(ctx, gameId, game.nightNumber);
    await stampDoppelgangerRevealMarkers(ctx, gameId, game.nightNumber, step);
  } else if (step === 'doppelganger_dawn') {
    // Pending reveals were written earlier during the day/morning death
    // sites; this step just dwells so the converted player can read them.
    await stampDoppelgangerRevealMarkers(ctx, gameId, game.nightNumber, step);
  } else if (witchHasNothingLeft || mentalistShorthanded) {
    // Whole-step no-op: every actor (human or bot) gets a sleep-through row so
    // the step can advance with no UI interaction.
    await autoResolveStep(ctx, gameId, step, actors, alive, game.nightNumber);
  } else if (step === 'wolves') {
    // Wolves share a single kill row, so a single bot can't act on behalf of a
    // mixed pack — only auto-resolve when the whole pack is bots.
    if (actors.length > 0 && actors.every(a => isBotName(a.name))) {
      await autoResolveStep(ctx, gameId, step, actors, alive, game.nightNumber);
    }
  } else {
    // Independent-actor steps (bodyguard, huntress, witch, …): each bot
    // submits its own no-op so mixed games (e.g. 1 human BG + 1 bot BG)
    // don't hang waiting on the bot. Humans still submit via the picker UI.
    const botActors = actors.filter(a => isBotName(a.name));
    if (botActors.length > 0) {
      await autoResolveStep(ctx, gameId, step, botActors, alive, game.nightNumber);
    }
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
  const actors = activePlayersForStep(step, alive, game.nightNumber);

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
  // Doppelganger reveal steps auto-advance on dwell; clear the pending-reveal
  // flags here so the field is gone by the time the next step renders. If
  // the field stayed set, the dawn step on the FOLLOWING night would treat
  // these as a fresh batch and replay the modal.
  if (step === 'doppelganger_dawn' || step === 'doppelganger_dusk') {
    await clearDoppelgangerRevealsForStep(ctx, gameId, step);
  }
  // Sasquatch conversion reveal is rendered as an overlay during the wolves
  // step. Once that step advances, clear the flag so subsequent nights don't
  // replay it.
  if (step === 'wolves') {
    await clearSasquatchReveals(ctx, gameId);
  }
  const next = nextNightStep(step);
  if (next) {
    await enterStep(ctx, gameId, next);
  } else {
    await resolveMorning(ctx, gameId, game.nightNumber);
  }
}

/**
 * Removes `pendingDoppelgangerReveal` from every alive player whose phase
 * matches the just-completed reveal step. Called from advanceFromCurrentStep
 * when leaving a doppelganger_dawn / doppelganger_dusk step.
 */
async function clearDoppelgangerRevealsForStep(
  ctx: MutationCtx,
  gameId: Id<'games'>,
  step: 'doppelganger_dawn' | 'doppelganger_dusk',
): Promise<void> {
  const expectedPhase = step === 'doppelganger_dawn' ? 'day' : 'night';
  const players = await ctx.db
    .query('players')
    .withIndex('by_game', q => q.eq('gameId', gameId))
    .collect();
  for (const p of players) {
    const pending = p.roleState?.pendingDoppelgangerReveal;
    if (pending?.triggerPhase !== expectedPhase) continue;
    const { pendingDoppelgangerReveal, ...rest } = p.roleState ?? {};
    void pendingDoppelgangerReveal;
    await ctx.db.patch(p._id, { roleState: rest });
  }
}

/**
 * Called from every action-mutation right after the `nightActions` row is
 * inserted. Ensures there's still enough remaining dwell for:
 *   - the actor to read their own result (Seer/PI/Mentalist), and
 *   - ghosts/spectators to observe the new action row on the table
 * before the step advances. Bumps `nightStepEndsAt` only if it's about to
 * expire — most of the time this is a no-op, preserving the original
 * cloaking variance.
 *
 * When we do bump, we also schedule a fresh `dwellTick` at the new deadline.
 * The original tick will still fire at the old time, but will no-op via the
 * dwell check; the new tick is the one that ultimately advances.
 *
 * Use this in place of `maybeAdvance` from action mutations. It does not
 * itself attempt to advance — the scheduled tick (old or new) handles that.
 */
async function ensureReadingWindow(
  ctx: MutationCtx,
  gameId: Id<'games'>,
  step: NightStep,
): Promise<void> {
  const game = await ctx.db.get(gameId);
  if (!game || game.phase !== 'night' || game.nightStep !== step) return;
  const minEndsAt = Date.now() + REVEAL_WINDOW_MS;
  if ((game.nightStepEndsAt ?? 0) >= minEndsAt) return;
  await ctx.db.patch(gameId, { nightStepEndsAt: minEndsAt });
  await ctx.scheduler.runAfter(REVEAL_WINDOW_MS, internal.night.dwellTick, {
    gameId,
    expectedStep: step,
  });
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
    // Wolves may target each other (and themselves). The Leprechaun would
    // otherwise be able to confirm every wolf-kill target as a villager;
    // allowing wolf-on-wolf kills keeps the redirect's signal noisy.
    // On a Wolf Cub vengeance night the wolves pick TWO victims sequentially.
    // Reject voting for someone who was already locked in as kill #1, and
    // reject any vote once the night's kill quota has already been met (the
    // step is just waiting for its dwell to expire).
    const existingKills = await getNightActions(
      ctx,
      args.gameId,
      game.nightNumber,
      'wolf_kill',
    );
    const allPlayers = await ctx.db
      .query('players')
      .withIndex('by_game', q => q.eq('gameId', args.gameId))
      .collect();
    const requiredKillsNow = computeRequiredKills(
      game,
      allPlayers.filter(p => p.alive),
    );
    if (existingKills.length >= requiredKillsNow) {
      throw new Error("Tonight's kills are already sealed.");
    }
    const lockedTargets = new Set<string>(
      existingKills
        .map(k => k.targetPlayerId as Id<'players'> | undefined)
        .filter((id): id is Id<'players'> => !!id)
        .map(id => id as unknown as string),
    );
    if (lockedTargets.has(args.targetPlayerId as unknown as string)) {
      throw new Error('That player is already a kill target tonight.');
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
      // Wolf Cub vengeance: if more kills are still required, reset every
      // wolf's wolfVote so the picker re-prompts for the next target. Do
      // NOT advance the step. Otherwise (required kills satisfied), gate
      // the advance on a guaranteed reveal window so ghosts can see the
      // wolf_kill row before the step transitions.
      const required = computeRequiredKills(
        game,
        refreshed.filter(p => p.alive),
      );
      const killsNow = existingKills.length + 1;
      if (killsNow < required) {
        for (const w of wolvesNow) {
          if (w.roleState && 'wolfVote' in w.roleState) {
            const next = { ...w.roleState };
            delete next.wolfVote;
            await ctx.db.patch(w._id, { roleState: next });
          }
        }
        return;
      }
      await ensureReadingWindow(ctx, args.gameId, 'wolves');
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
    await ensureReadingWindow(ctx, args.gameId, 'seer');
    return { team };
  },
});

// ───── PI ───────────────────────────────────────────────────────────────────
//
// One-time night power: pick any player, learn whether the trio (target +
// left + right neighbors) contains a wolf. Pass on this night to save the
// power for later. After using `pi_check`, `piUsed` flips true at morning
// resolution and the PI is no longer an active actor on subsequent nights
// (their step still dwells for cloaking).

export const submitPICheck = mutation({
  args: {
    gameId: v.id('games'),
    callerDeviceClientId: v.string(),
    targetPlayerId: v.id('players'),
  },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game) throw new Error('Game not found.');
    if (game.phase !== 'night' || game.nightStep !== 'pi') {
      throw new Error('The PI is not currently awake.');
    }

    const me = await findCaller(ctx, args.gameId, args.callerDeviceClientId);
    if (!me?.alive || me.role !== 'Paranormal Investigator') {
      throw new Error('Only the PI can investigate.');
    }
    if (me.roleState?.piUsed) {
      throw new Error('You have already used your investigation.');
    }
    if (
      await findMyAction(ctx, args.gameId, game.nightNumber, me._id, 'pi_check')
    ) {
      throw new Error('Investigation already used tonight.');
    }
    if (
      await findMyAction(ctx, args.gameId, game.nightNumber, me._id, 'pi_skip')
    ) {
      throw new Error('You have already passed tonight.');
    }

    const target = await ctx.db.get(args.targetPlayerId);
    if (!target || target.gameId !== args.gameId) {
      throw new Error('Invalid target.');
    }
    if (!target.alive) throw new Error('Target is eliminated.');

    const players = await ctx.db
      .query('players')
      .withIndex('by_game', q => q.eq('gameId', args.gameId))
      .collect();
    const team = piTrioResult(target, players, game.playerCount);

    await ctx.db.insert('nightActions', {
      gameId: args.gameId,
      nightNumber: game.nightNumber,
      actorPlayerId: me._id,
      actionType: 'pi_check',
      targetPlayerId: args.targetPlayerId,
      result: { team },
      resolvedAt: Date.now(),
    });

    // Don't auto-advance — same as Seer, the PI needs to read the result
    // before the screen moves on. Client calls `tickNight` after OK.
    await ensureReadingWindow(ctx, args.gameId, 'pi');
    return { team };
  },
});

export const submitPISkip = mutation({
  args: {
    gameId: v.id('games'),
    callerDeviceClientId: v.string(),
  },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game) throw new Error('Game not found.');
    if (game.phase !== 'night' || game.nightStep !== 'pi') {
      throw new Error('The PI is not currently awake.');
    }

    const me = await findCaller(ctx, args.gameId, args.callerDeviceClientId);
    if (!me?.alive || me.role !== 'Paranormal Investigator') {
      throw new Error('Only the PI can pass tonight.');
    }
    if (
      await findMyAction(ctx, args.gameId, game.nightNumber, me._id, 'pi_check') ||
      await findMyAction(ctx, args.gameId, game.nightNumber, me._id, 'pi_skip')
    ) {
      return; // already decided
    }

    await ctx.db.insert('nightActions', {
      gameId: args.gameId,
      nightNumber: game.nightNumber,
      actorPlayerId: me._id,
      actionType: 'pi_skip',
      resolvedAt: Date.now(),
    });

    // pi_skip completes the PI's step contribution → ensure ghosts have a
    // moment to read "PI passed" before the step transitions.
    await ensureReadingWindow(ctx, args.gameId, 'pi');
  },
});

// ───── Mentalist ────────────────────────────────────────────────────────────
//
// Each night, picks two players. Server compares teamForRole(first) to
// teamForRole(second) and returns 'same' or 'different'. Wolf-team grouping
// includes Werewolf, Wolf Man, Hunter Wolf, Minion, AND Reviler (different
// from the Seer's "true wolves only" wolf detection — Minion and Reviler
// both win with the wolves and read same-team here even though Seer/PI
// don't see them as wolves).

export const submitMentalistCheck = mutation({
  args: {
    gameId: v.id('games'),
    callerDeviceClientId: v.string(),
    firstPlayerId: v.id('players'),
    secondPlayerId: v.id('players'),
  },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game) throw new Error('Game not found.');
    if (game.phase !== 'night' || game.nightStep !== 'mentalist') {
      throw new Error('The mentalist is not currently awake.');
    }

    const me = await findCaller(ctx, args.gameId, args.callerDeviceClientId);
    if (!me?.alive || me.role !== 'Mentalist') {
      throw new Error('Only the mentalist can compare.');
    }

    if (args.firstPlayerId === args.secondPlayerId) {
      throw new Error('Pick two different players.');
    }

    if (
      args.firstPlayerId === me._id ||
      args.secondPlayerId === me._id
    ) {
      throw new Error('You cannot read yourself.');
    }

    const lastTargets = (me.roleState?.mentalistLastTargets ??
      []) as Id<'players'>[];
    const lastSet = new Set<Id<'players'>>(lastTargets);
    if (lastSet.has(args.firstPlayerId) || lastSet.has(args.secondPlayerId)) {
      throw new Error(
        'You cannot pick someone you compared last night.',
      );
    }

    if (
      await findMyAction(
        ctx,
        args.gameId,
        game.nightNumber,
        me._id,
        'mentalist_check',
      )
    ) {
      throw new Error('Comparison already submitted tonight.');
    }

    const first = await ctx.db.get(args.firstPlayerId);
    const second = await ctx.db.get(args.secondPlayerId);
    if (!first || !second) throw new Error('Invalid target.');
    if (first.gameId !== args.gameId || second.gameId !== args.gameId) {
      throw new Error('Invalid target.');
    }
    if (!first.alive || !second.alive) {
      throw new Error('Targets must be alive.');
    }

    const sameTeam: 'same' | 'different' =
      teamForRole(first.role || '') === teamForRole(second.role || '')
        ? 'same'
        : 'different';

    await ctx.db.insert('nightActions', {
      gameId: args.gameId,
      nightNumber: game.nightNumber,
      actorPlayerId: me._id,
      actionType: 'mentalist_check',
      targetPlayerId: args.firstPlayerId, // First target indexed; second lives in result.
      result: {
        firstId: args.firstPlayerId,
        secondId: args.secondPlayerId,
        sameTeam,
      },
      resolvedAt: Date.now(),
    });

    // Don't advance — Seer pattern. Client calls tickNight after OK.
    await ensureReadingWindow(ctx, args.gameId, 'mentalist');
    return { sameTeam };
  },
});

export const submitBGProtect = mutation({
  args: {
    gameId: v.id('games'),
    callerDeviceClientId: v.string(),
    targetPlayerId: v.id('players'),
  },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game) throw new Error('Game not found.');
    if (game.phase !== 'night' || game.nightStep !== 'bodyguard') {
      throw new Error('The bodyguard is not currently awake.');
    }

    const me = await findCaller(ctx, args.gameId, args.callerDeviceClientId);
    if (!me?.alive || me.role !== 'Bodyguard') {
      throw new Error('Only the bodyguard can protect.');
    }

    const target = await ctx.db.get(args.targetPlayerId);
    if (!target || target.gameId !== args.gameId) {
      throw new Error('Invalid target.');
    }
    if (!target.alive) throw new Error('Cannot protect an eliminated player.');

    const lastProtected = me.roleState?.bgLastProtected as
      | Id<'players'>
      | undefined;
    if (lastProtected && lastProtected === args.targetPlayerId) {
      throw new Error('You cannot protect the same player two nights in a row.');
    }

    const selfProtectUsed = !!me.roleState?.bgSelfProtectUsed;
    if (args.targetPlayerId === me._id && selfProtectUsed) {
      throw new Error('You have already used your self-protect.');
    }

    // Replace any prior submission this night so the BG can change their pick
    // until the dwell ends.
    const priorAll = await ctx.db
      .query('nightActions')
      .withIndex('by_game_night', q =>
        q.eq('gameId', args.gameId).eq('nightNumber', game.nightNumber),
      )
      .collect();
    for (const a of priorAll) {
      if (a.actorPlayerId === me._id && a.actionType === 'bg_protect') {
        await ctx.db.delete(a._id);
      }
    }

    await ctx.db.insert('nightActions', {
      gameId: args.gameId,
      nightNumber: game.nightNumber,
      actorPlayerId: me._id,
      actionType: 'bg_protect',
      targetPlayerId: args.targetPlayerId,
      resolvedAt: Date.now(),
    });

    // Guaranteed reveal window so ghosts can read the protect target before
    // the step transitions, even if the BG took longer than the original
    // dwell to decide.
    await ensureReadingWindow(ctx, args.gameId, 'bodyguard');
  },
});

// ───── Huntress ─────────────────────────────────────────────────────────────
//
// One-time night shot. Hits land at morning resolution (cloaked with all
// other overnight deaths). BG can block the target — when blocked, the shot
// is still consumed per house rules. Pass keeps the shot for later.

export const submitHuntressShot = mutation({
  args: {
    gameId: v.id('games'),
    callerDeviceClientId: v.string(),
    targetPlayerId: v.id('players'),
  },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game) throw new Error('Game not found.');
    if (game.phase !== 'night' || game.nightStep !== 'huntress') {
      throw new Error('The huntress is not currently awake.');
    }

    const me = await findCaller(ctx, args.gameId, args.callerDeviceClientId);
    if (!me?.alive || me.role !== 'Huntress') {
      throw new Error('Only the huntress can shoot.');
    }
    if (me.roleState?.huntressUsed) {
      throw new Error('You have already used your shot.');
    }
    if (
      await findMyAction(
        ctx,
        args.gameId,
        game.nightNumber,
        me._id,
        'huntress_shot',
      )
    ) {
      throw new Error('Shot already taken tonight.');
    }
    if (
      await findMyAction(
        ctx,
        args.gameId,
        game.nightNumber,
        me._id,
        'huntress_skip',
      )
    ) {
      throw new Error('You have already passed tonight.');
    }

    const target = await ctx.db.get(args.targetPlayerId);
    if (!target || target.gameId !== args.gameId) {
      throw new Error('Invalid target.');
    }
    if (!target.alive) throw new Error('Target is already eliminated.');
    if (target._id === me._id) throw new Error('Cannot shoot yourself.');

    await ctx.db.insert('nightActions', {
      gameId: args.gameId,
      nightNumber: game.nightNumber,
      actorPlayerId: me._id,
      actionType: 'huntress_shot',
      targetPlayerId: args.targetPlayerId,
      resolvedAt: Date.now(),
    });

    await ensureReadingWindow(ctx, args.gameId, 'huntress');
  },
});

export const submitHuntressSkip = mutation({
  args: {
    gameId: v.id('games'),
    callerDeviceClientId: v.string(),
  },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game) throw new Error('Game not found.');
    if (game.phase !== 'night' || game.nightStep !== 'huntress') {
      throw new Error('The huntress is not currently awake.');
    }

    const me = await findCaller(ctx, args.gameId, args.callerDeviceClientId);
    if (!me?.alive || me.role !== 'Huntress') {
      throw new Error('Only the huntress can pass tonight.');
    }
    if (
      await findMyAction(
        ctx,
        args.gameId,
        game.nightNumber,
        me._id,
        'huntress_shot',
      ) ||
      await findMyAction(
        ctx,
        args.gameId,
        game.nightNumber,
        me._id,
        'huntress_skip',
      )
    ) {
      return; // already decided
    }

    await ctx.db.insert('nightActions', {
      gameId: args.gameId,
      nightNumber: game.nightNumber,
      actorPlayerId: me._id,
      actionType: 'huntress_skip',
      resolvedAt: Date.now(),
    });

    await ensureReadingWindow(ctx, args.gameId, 'huntress');
  },
});

// ───── Revealer ─────────────────────────────────────────────────────────────
//
// Every night, optional. Die-on-miss: if the target is not a wolf, the
// Revealer dies and the target lives. BG can save the target side; the
// shooter is never saved from a self-death (house rule).

export const submitRevealerShot = mutation({
  args: {
    gameId: v.id('games'),
    callerDeviceClientId: v.string(),
    targetPlayerId: v.id('players'),
  },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game) throw new Error('Game not found.');
    if (game.phase !== 'night' || game.nightStep !== 'revealer') {
      throw new Error('The revealer is not currently awake.');
    }

    const me = await findCaller(ctx, args.gameId, args.callerDeviceClientId);
    if (!me?.alive || me.role !== 'Revealer') {
      throw new Error('Only the revealer can shoot.');
    }
    if (
      await findMyAction(
        ctx,
        args.gameId,
        game.nightNumber,
        me._id,
        'revealer_shot',
      )
    ) {
      throw new Error('Shot already taken tonight.');
    }
    if (
      await findMyAction(
        ctx,
        args.gameId,
        game.nightNumber,
        me._id,
        'revealer_skip',
      )
    ) {
      throw new Error('You have already passed tonight.');
    }

    const target = await ctx.db.get(args.targetPlayerId);
    if (!target || target.gameId !== args.gameId) {
      throw new Error('Invalid target.');
    }
    if (!target.alive) throw new Error('Target is already eliminated.');
    if (target._id === me._id) throw new Error('Cannot shoot yourself.');

    await ctx.db.insert('nightActions', {
      gameId: args.gameId,
      nightNumber: game.nightNumber,
      actorPlayerId: me._id,
      actionType: 'revealer_shot',
      targetPlayerId: args.targetPlayerId,
      resolvedAt: Date.now(),
    });

    await ensureReadingWindow(ctx, args.gameId, 'revealer');
  },
});

export const submitRevealerSkip = mutation({
  args: {
    gameId: v.id('games'),
    callerDeviceClientId: v.string(),
  },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game) throw new Error('Game not found.');
    if (game.phase !== 'night' || game.nightStep !== 'revealer') {
      throw new Error('The revealer is not currently awake.');
    }

    const me = await findCaller(ctx, args.gameId, args.callerDeviceClientId);
    if (!me?.alive || me.role !== 'Revealer') {
      throw new Error('Only the revealer can pass tonight.');
    }
    if (
      await findMyAction(
        ctx,
        args.gameId,
        game.nightNumber,
        me._id,
        'revealer_shot',
      ) ||
      await findMyAction(
        ctx,
        args.gameId,
        game.nightNumber,
        me._id,
        'revealer_skip',
      )
    ) {
      return;
    }

    await ctx.db.insert('nightActions', {
      gameId: args.gameId,
      nightNumber: game.nightNumber,
      actorPlayerId: me._id,
      actionType: 'revealer_skip',
      resolvedAt: Date.now(),
    });

    await ensureReadingWindow(ctx, args.gameId, 'revealer');
  },
});

// ───── Reviler ──────────────────────────────────────────────────────────────
//
// Wolf-team antagonist who wakes alone (doesn't see wolves and isn't seen by
// them). Wins with the wolves but is excluded from parity. Hit target = any
// village-team role that isn't plain Villager (Seer, BG, Witch, PI, etc.).
// Miss = shooter dies. BG saves the target side of a hit but not the shooter
// side of a miss.

function isSpecialVillager(role: string | undefined): boolean {
  if (!role) return false;
  return teamForRole(role) === 'village' && role !== 'Villager';
}

export const submitRevilerShot = mutation({
  args: {
    gameId: v.id('games'),
    callerDeviceClientId: v.string(),
    targetPlayerId: v.id('players'),
  },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game) throw new Error('Game not found.');
    if (game.phase !== 'night' || game.nightStep !== 'reviler') {
      throw new Error('The reviler is not currently awake.');
    }

    const me = await findCaller(ctx, args.gameId, args.callerDeviceClientId);
    if (!me?.alive || me.role !== 'Reviler') {
      throw new Error('Only the reviler can shoot.');
    }
    if (
      await findMyAction(
        ctx,
        args.gameId,
        game.nightNumber,
        me._id,
        'reviler_shot',
      )
    ) {
      throw new Error('Shot already taken tonight.');
    }
    if (
      await findMyAction(
        ctx,
        args.gameId,
        game.nightNumber,
        me._id,
        'reviler_skip',
      )
    ) {
      throw new Error('You have already passed tonight.');
    }

    const target = await ctx.db.get(args.targetPlayerId);
    if (!target || target.gameId !== args.gameId) {
      throw new Error('Invalid target.');
    }
    if (!target.alive) throw new Error('Target is already eliminated.');
    if (target._id === me._id) throw new Error('Cannot shoot yourself.');

    await ctx.db.insert('nightActions', {
      gameId: args.gameId,
      nightNumber: game.nightNumber,
      actorPlayerId: me._id,
      actionType: 'reviler_shot',
      targetPlayerId: args.targetPlayerId,
      resolvedAt: Date.now(),
    });

    await ensureReadingWindow(ctx, args.gameId, 'reviler');
  },
});

export const submitRevilerSkip = mutation({
  args: {
    gameId: v.id('games'),
    callerDeviceClientId: v.string(),
  },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game) throw new Error('Game not found.');
    if (game.phase !== 'night' || game.nightStep !== 'reviler') {
      throw new Error('The reviler is not currently awake.');
    }

    const me = await findCaller(ctx, args.gameId, args.callerDeviceClientId);
    if (!me?.alive || me.role !== 'Reviler') {
      throw new Error('Only the reviler can pass tonight.');
    }
    if (
      await findMyAction(
        ctx,
        args.gameId,
        game.nightNumber,
        me._id,
        'reviler_shot',
      ) ||
      await findMyAction(
        ctx,
        args.gameId,
        game.nightNumber,
        me._id,
        'reviler_skip',
      )
    ) {
      return;
    }

    await ctx.db.insert('nightActions', {
      gameId: args.gameId,
      nightNumber: game.nightNumber,
      actorPlayerId: me._id,
      actionType: 'reviler_skip',
      resolvedAt: Date.now(),
    });

    await ensureReadingWindow(ctx, args.gameId, 'reviler');
  },
});

// ───── Nightmare Wolf ───────────────────────────────────────────────────────
//
// Wakes with the pack to vote on the kill, then stays awake alone for their
// own step right after `wolves`. Twice per game total, puts a single non-wolf
// player to sleep: target's `roleState.nightmaredOn` is stamped with the
// current nightNumber, and every later picker step's `activePlayersForStep`
// filters that actor out, so their picker is replaced with a "put to sleep"
// overlay on their phone and the step auto-completes after dwell.
//
// Charges are per-NW (no global cap across multiple NWs); the same NW can't
// target the same player twice. Skipping a night preserves both charges.

export const submitNightmarePut = mutation({
  args: {
    gameId: v.id('games'),
    callerDeviceClientId: v.string(),
    targetPlayerId: v.id('players'),
  },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game) throw new Error('Game not found.');
    if (game.phase !== 'night' || game.nightStep !== 'nightmare_wolf') {
      throw new Error('The nightmare wolf is not currently awake.');
    }

    const me = await findCaller(ctx, args.gameId, args.callerDeviceClientId);
    if (!me?.alive || me.role !== 'Nightmare Wolf') {
      throw new Error('Only the nightmare wolf can act here.');
    }

    const used =
      (me.roleState?.nightmaresUsed as Id<'players'>[] | undefined) ?? [];
    if (used.length >= 2) {
      throw new Error('You have already used both nightmares.');
    }
    if (
      await findMyAction(
        ctx,
        args.gameId,
        game.nightNumber,
        me._id,
        'nightmare_put_to_sleep',
      )
    ) {
      throw new Error('You have already chosen tonight.');
    }
    if (
      await findMyAction(
        ctx,
        args.gameId,
        game.nightNumber,
        me._id,
        'nightmare_skip',
      )
    ) {
      throw new Error('You have already passed tonight.');
    }

    const target = await ctx.db.get(args.targetPlayerId);
    if (!target || target.gameId !== args.gameId) {
      throw new Error('Invalid target.');
    }
    if (!target.alive) throw new Error('Target is already eliminated.');
    if (target._id === me._id) throw new Error('Cannot nightmare yourself.');
    if (target.role && isWolfTeam(target.role)) {
      throw new Error('Cannot nightmare another wolf.');
    }
    if (used.some(id => id === target._id)) {
      throw new Error('You have already nightmared that player.');
    }

    await ctx.db.insert('nightActions', {
      gameId: args.gameId,
      nightNumber: game.nightNumber,
      actorPlayerId: me._id,
      actionType: 'nightmare_put_to_sleep',
      targetPlayerId: args.targetPlayerId,
      resolvedAt: Date.now(),
    });

    // Sleep flag on the target needs to take effect *this same night* so
    // subsequent picker steps filter them out. NW's own `nightmaresUsed`
    // update is deferred to morning resolution (mirrors Huntress/PI/Witch
    // — flipping the spent flag mid-step would yank the NW out of
    // `activePlayersForStep`, blanking their post-action confirmation
    // view and surfacing the WaitingView alongside it.
    await ctx.db.patch(args.targetPlayerId, {
      roleState: {
        ...(target.roleState ?? {}),
        nightmaredOn: game.nightNumber,
      },
    });

    await ensureReadingWindow(ctx, args.gameId, 'nightmare_wolf');
  },
});

export const submitNightmareSkip = mutation({
  args: {
    gameId: v.id('games'),
    callerDeviceClientId: v.string(),
  },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game) throw new Error('Game not found.');
    if (game.phase !== 'night' || game.nightStep !== 'nightmare_wolf') {
      throw new Error('The nightmare wolf is not currently awake.');
    }

    const me = await findCaller(ctx, args.gameId, args.callerDeviceClientId);
    if (!me?.alive || me.role !== 'Nightmare Wolf') {
      throw new Error('Only the nightmare wolf can pass tonight.');
    }
    if (
      await findMyAction(
        ctx,
        args.gameId,
        game.nightNumber,
        me._id,
        'nightmare_put_to_sleep',
      ) ||
      await findMyAction(
        ctx,
        args.gameId,
        game.nightNumber,
        me._id,
        'nightmare_skip',
      )
    ) {
      return; // already decided
    }

    await ctx.db.insert('nightActions', {
      gameId: args.gameId,
      nightNumber: game.nightNumber,
      actorPlayerId: me._id,
      actionType: 'nightmare_skip',
      resolvedAt: Date.now(),
    });

    await ensureReadingWindow(ctx, args.gameId, 'nightmare_wolf');
  },
});

// ───── Cursed conversion ack ────────────────────────────────────────────────
//
// Tapping OK on the reveal screen records a `cursed_conversion_ack` row.
// `isStepComplete` for cursed_conversion gates on every converted Cursed
// having an ack, so the step won't auto-advance on dwell expiry alone —
// the converted Cursed can't miss the screen by looking away briefly.
// Dwell still runs as the MINIMUM time (cloak symmetry). Host stall
// override remains the safety valve if a Cursed never taps.

export const submitCursedAck = mutation({
  args: {
    gameId: v.id('games'),
    callerDeviceClientId: v.string(),
  },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game) throw new Error('Game not found.');
    if (game.phase !== 'night' || game.nightStep !== 'cursed_conversion') {
      throw new Error('Not in the cursed conversion step.');
    }

    const me = await findCaller(ctx, args.gameId, args.callerDeviceClientId);
    if (!me?.alive || me.role !== 'Cursed') {
      throw new Error('Only a converted Cursed can acknowledge.');
    }
    // Caller must actually be one of tonight's converted Cursed.
    const myConversion = await findMyAction(
      ctx,
      args.gameId,
      game.nightNumber,
      me._id,
      'cursed_conversion',
    );
    if (!myConversion) {
      throw new Error('You were not converted tonight.');
    }
    // Idempotent — repeat taps from a flaky network shouldn't unblock
    // the step prematurely.
    const existingAck = await findMyAction(
      ctx,
      args.gameId,
      game.nightNumber,
      me._id,
      'cursed_conversion_ack',
    );
    if (existingAck) return;

    await ctx.db.insert('nightActions', {
      gameId: args.gameId,
      nightNumber: game.nightNumber,
      actorPlayerId: me._id,
      actionType: 'cursed_conversion_ack',
      resolvedAt: Date.now(),
    });

    await maybeAdvance(ctx, args.gameId);
  },
});

// ───── Witch ────────────────────────────────────────────────────────────────
//
// Three mutations: save (consumes the save potion to revive tonight's wolf
// victim), poison (consumes the poison potion to kill another player), and
// done (witch is finished — advance the step). Save and poison are
// independent one-time potions; witch can use one, both, or neither each
// night, and across nights as long as each is unused.

async function findMyAction(
  ctx: MutationCtx,
  gameId: Id<'games'>,
  nightNumber: number,
  actorPlayerId: Id<'players'>,
  actionType: string,
) {
  const actions = await ctx.db
    .query('nightActions')
    .withIndex('by_game_night', q =>
      q.eq('gameId', gameId).eq('nightNumber', nightNumber),
    )
    .collect();
  return actions.find(
    a => a.actorPlayerId === actorPlayerId && a.actionType === actionType,
  );
}

export const submitWitchSave = mutation({
  args: {
    gameId: v.id('games'),
    callerDeviceClientId: v.string(),
    // Which of tonight's wolf victims to save. On a normal night there's
    // only one, but on a Wolf Cub vengeance night there are two — the
    // potion saves exactly one (no two-for-one).
    targetPlayerId: v.id('players'),
  },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game) throw new Error('Game not found.');
    if (game.phase !== 'night' || game.nightStep !== 'witch') {
      throw new Error('The witch is not currently awake.');
    }

    const me = await findCaller(ctx, args.gameId, args.callerDeviceClientId);
    if (!me?.alive || me.role !== 'Witch') {
      throw new Error('Only the witch can use the save potion.');
    }
    if (me.roleState?.witchSaveUsed) {
      throw new Error('Save potion already used.');
    }
    if (
      await findMyAction(ctx, args.gameId, game.nightNumber, me._id, 'witch_save')
    ) {
      throw new Error('Save potion already cast tonight.');
    }
    if (
      await findMyAction(ctx, args.gameId, game.nightNumber, me._id, 'witch_done')
    ) {
      throw new Error('Your turn is already over.');
    }

    // Save target must be one of the wolves' chosen victims for tonight.
    const kills = await getNightActions(
      ctx,
      args.gameId,
      game.nightNumber,
      'wolf_kill',
    );
    const victimIds = new Set<string>(
      kills
        .map(k => k.targetPlayerId as Id<'players'> | undefined)
        .filter((id): id is Id<'players'> => !!id)
        .map(id => id as unknown as string),
    );
    if (victimIds.size === 0) {
      throw new Error('No victim to save tonight.');
    }
    if (!victimIds.has(args.targetPlayerId as unknown as string)) {
      throw new Error('Target is not a wolf victim tonight.');
    }

    await ctx.db.insert('nightActions', {
      gameId: args.gameId,
      nightNumber: game.nightNumber,
      actorPlayerId: me._id,
      actionType: 'witch_save',
      targetPlayerId: args.targetPlayerId,
      resolvedAt: Date.now(),
    });
  },
});

export const submitWitchPoison = mutation({
  args: {
    gameId: v.id('games'),
    callerDeviceClientId: v.string(),
    targetPlayerId: v.id('players'),
  },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game) throw new Error('Game not found.');
    if (game.phase !== 'night' || game.nightStep !== 'witch') {
      throw new Error('The witch is not currently awake.');
    }

    const me = await findCaller(ctx, args.gameId, args.callerDeviceClientId);
    if (!me?.alive || me.role !== 'Witch') {
      throw new Error('Only the witch can use the poison potion.');
    }
    if (me.roleState?.witchPoisonUsed) {
      throw new Error('Poison potion already used.');
    }
    if (
      await findMyAction(ctx, args.gameId, game.nightNumber, me._id, 'witch_poison')
    ) {
      throw new Error('Poison already cast tonight.');
    }
    if (
      await findMyAction(ctx, args.gameId, game.nightNumber, me._id, 'witch_done')
    ) {
      throw new Error('Your turn is already over.');
    }

    const target = await ctx.db.get(args.targetPlayerId);
    if (!target || target.gameId !== args.gameId) {
      throw new Error('Invalid target.');
    }
    if (!target.alive) throw new Error('Target is already eliminated.');
    if (target._id === me._id) throw new Error('Cannot poison yourself.');

    await ctx.db.insert('nightActions', {
      gameId: args.gameId,
      nightNumber: game.nightNumber,
      actorPlayerId: me._id,
      actionType: 'witch_poison',
      targetPlayerId: args.targetPlayerId,
      resolvedAt: Date.now(),
    });
  },
});

export const submitWitchDone = mutation({
  args: {
    gameId: v.id('games'),
    callerDeviceClientId: v.string(),
  },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game) throw new Error('Game not found.');
    if (game.phase !== 'night' || game.nightStep !== 'witch') {
      throw new Error('The witch is not currently awake.');
    }

    const me = await findCaller(ctx, args.gameId, args.callerDeviceClientId);
    if (!me?.alive || me.role !== 'Witch') {
      throw new Error('Only the witch can finish their turn.');
    }
    if (
      await findMyAction(ctx, args.gameId, game.nightNumber, me._id, 'witch_done')
    ) {
      return; // already done
    }

    await ctx.db.insert('nightActions', {
      gameId: args.gameId,
      nightNumber: game.nightNumber,
      actorPlayerId: me._id,
      actionType: 'witch_done',
      resolvedAt: Date.now(),
    });

    // Guaranteed reveal window so ghosts can read the witch's final state
    // (save/poison rows) before the step transitions, even if the witch
    // took longer than the original dwell to finish.
    await ensureReadingWindow(ctx, args.gameId, 'witch');
  },
});

// ───── Leprechaun ──────────────────────────────────────────────────────────
//
// After Witch, before Bodyguard. The Leprechaun sees the wolves' chosen
// kill target for tonight and chooses one of:
//   - LEAVE  : kill stays put (no cost)
//   - LEFT/R : move the kill to the next-alive seat L/R of the target
//
// "Move OFF" is a lifetime per-target limit. Once the kill has been moved
// off a given player, that player can never have a kill moved off them
// again later in the game. LEAVE never spends. The list grows monotonically
// on `games.leprechaunMovedOff`.
//
// Diseased-blocked night: Leprechaun is still woken and acknowledges that
// the wolves had no kill tonight. No move-off cost.
//
// Wolf Cub vengeance: Leprechaun sees only the FIRST wolf_kill row. The
// second kill resolves un-Leprechauned.
//
// resolveMorning honors the redirect by overriding the FIRST wolf_kill row's
// target via `effectiveKillTarget` — the wolf_kill row itself stays pristine
// so refreshStep can wipe leprechaun_redirect cleanly.

export const submitLeprechaunMove = mutation({
  args: {
    gameId: v.id('games'),
    callerDeviceClientId: v.string(),
    direction: v.union(v.literal('L'), v.literal('R'), v.literal('leave')),
  },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game) throw new Error('Game not found.');
    if (game.phase !== 'night' || game.nightStep !== 'leprechaun') {
      throw new Error('The leprechaun is not currently awake.');
    }

    const me = await findCaller(ctx, args.gameId, args.callerDeviceClientId);
    if (!me?.alive || me.role !== 'Leprechaun') {
      throw new Error('Only the leprechaun can act.');
    }
    if (
      await findMyAction(
        ctx,
        args.gameId,
        game.nightNumber,
        me._id,
        'leprechaun_redirect',
      )
    ) {
      throw new Error('Already acted tonight.');
    }

    // Diseased-blocked night: only an acknowledgement is meaningful. We
    // accept any direction submission but never patch a wolf_kill (there
    // isn't one) and never spend a move-off.
    const blockedRows = await getNightActions(
      ctx,
      args.gameId,
      game.nightNumber,
      'wolf_blocked',
    );
    if (blockedRows.length > 0) {
      await ctx.db.insert('nightActions', {
        gameId: args.gameId,
        nightNumber: game.nightNumber,
        actorPlayerId: me._id,
        actionType: 'leprechaun_redirect',
        result: { direction: 'leave', blocked: true },
        resolvedAt: Date.now(),
      });
      await ensureReadingWindow(ctx, args.gameId, 'leprechaun');
      return;
    }

    const kills = await getNightActions(
      ctx,
      args.gameId,
      game.nightNumber,
      'wolf_kill',
    );
    if (kills.length === 0) {
      throw new Error('No wolf kill recorded tonight.');
    }
    // Wolf Cub vengeance: leprechaun only acts on the wolves' FIRST kill.
    const firstKill = kills
      .slice()
      .sort((a, b) => a.resolvedAt - b.resolvedAt)[0];
    const originalTargetId = firstKill.targetPlayerId as
      | Id<'players'>
      | undefined;
    if (!originalTargetId) {
      throw new Error('Wolf kill has no target.');
    }

    if (args.direction === 'leave') {
      await ctx.db.insert('nightActions', {
        gameId: args.gameId,
        nightNumber: game.nightNumber,
        actorPlayerId: me._id,
        actionType: 'leprechaun_redirect',
        targetPlayerId: originalTargetId,
        result: { direction: 'leave', originalTargetId },
        resolvedAt: Date.now(),
      });
      await ensureReadingWindow(ctx, args.gameId, 'leprechaun');
      return;
    }

    // Move-off path. Check lifetime per-target limit on the ORIGINAL target.
    const movedOff = (game.leprechaunMovedOff ?? []) as Id<'players'>[];
    if (movedOff.includes(originalTargetId)) {
      throw new Error(
        'Already used your move on that target — only LEAVE is available.',
      );
    }

    const originalTarget = await ctx.db.get(originalTargetId);
    if (!originalTarget || typeof originalTarget.seatPosition !== 'number') {
      throw new Error('Original target has no seat.');
    }

    const all = await ctx.db
      .query('players')
      .withIndex('by_game', q => q.eq('gameId', args.gameId))
      .collect();
    const bySeat = new Map<number, Player>();
    for (const p of all) {
      if (typeof p.seatPosition === 'number') bySeat.set(p.seatPosition, p);
    }
    const stepDir: 1 | -1 = args.direction === 'L' ? 1 : -1;
    const newTargetId = nextAliveSeatId(
      originalTarget.seatPosition,
      stepDir,
      game.playerCount,
      bySeat,
    );
    if (!newTargetId) {
      throw new Error('No alive neighbor in that direction.');
    }

    await ctx.db.patch(args.gameId, {
      leprechaunMovedOff: [...movedOff, originalTargetId],
    });

    await ctx.db.insert('nightActions', {
      gameId: args.gameId,
      nightNumber: game.nightNumber,
      actorPlayerId: me._id,
      actionType: 'leprechaun_redirect',
      targetPlayerId: originalTargetId,
      result: {
        direction: args.direction,
        originalTargetId,
        newTargetId,
      },
      resolvedAt: Date.now(),
    });

    await ensureReadingWindow(ctx, args.gameId, 'leprechaun');
  },
});

/**
 * Idempotent advance — anyone can call it; the engine only moves forward
 * when the current step is complete AND the dwell deadline has passed.
 * Used by clients after the result-modal dismissal on info-role screens
 * (Seer/PI/Mentalist) to nudge the engine, in case the scheduled dwell tick
 * hasn't yet fired.
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

/**
 * Host override. If a step has been stalled past the dwell deadline by more
 * than `SKIP_STALL_THRESHOLD_MS` (typically because a real player is AFK),
 * the host can force the engine to advance. Whatever actions have already
 * been recorded apply normally; anything missing simply doesn't happen
 * (e.g. no wolf_kill → no death from wolves that night). No random actions
 * are taken on anyone's behalf.
 */
export const forceAdvanceStep = mutation({
  args: {
    gameId: v.id('games'),
    callerDeviceClientId: v.string(),
    expectedStep: v.string(),
  },
  handler: async (ctx, args) => {
    await requireHost(ctx, args.gameId, args.callerDeviceClientId);
    const game = await ctx.db.get(args.gameId);
    if (!game) throw new Error('Game not found.');
    if (game.phase !== 'night') {
      throw new Error('Not currently in a night phase.');
    }
    // If the step has already moved on between the host tapping and the
    // mutation running, treat as success so the host doesn't see a confusing
    // error message.
    if (game.nightStep !== args.expectedStep) return;
    const eligibleAt =
      (game.nightStepEndsAt ?? 0) + SKIP_STALL_THRESHOLD_MS;
    if (Date.now() < eligibleAt) {
      throw new Error('This step has not stalled long enough to skip.');
    }
    await advanceFromCurrentStep(ctx, args.gameId);
  },
});

/**
 * Action types each step records on the `nightActions` table. Used by
 * `refreshStep` to wipe only the current step's worth of actions when the
 * host gives a stuck player a do-over.
 */
const STEP_ACTION_TYPES: Record<NightStep, readonly string[]> = {
  wolves: ['wolf_kill', 'wolf_blocked'],
  nightmare_wolf: ['nightmare_put_to_sleep', 'nightmare_skip'],
  seer: ['seer_check'],
  pi: ['pi_check', 'pi_skip'],
  mentalist: ['mentalist_check'],
  witch: ['witch_save', 'witch_poison', 'witch_done'],
  leprechaun: ['leprechaun_redirect'],
  bodyguard: ['bg_protect'],
  huntress: ['huntress_shot', 'huntress_skip'],
  revealer: ['revealer_shot', 'revealer_skip'],
  reviler: ['reviler_shot', 'reviler_skip'],
  cursed_conversion: ['cursed_conversion', 'cursed_conversion_ack'],
  doppelganger_dawn: ['doppelganger_conversion_reveal'],
  doppelganger_dusk: ['doppelganger_conversion', 'doppelganger_conversion_reveal'],
};

/**
 * Host override that gives the stuck actor a second chance. Wipes any
 * actions the current step has already recorded this night, clears any
 * step-scoped roleState (only wolves' `wolfVote` currently), and starts a
 * fresh dwell. The actor's `hasActedThisNight` flips back to false on the
 * next reactive tick, so their picker reappears and they can re-act.
 *
 * Eligibility is gated by the same stall threshold as `forceAdvanceStep`,
 * so it only surfaces after the step has genuinely stalled.
 */
export const refreshStep = mutation({
  args: {
    gameId: v.id('games'),
    callerDeviceClientId: v.string(),
    expectedStep: v.string(),
  },
  handler: async (ctx, args) => {
    await requireHost(ctx, args.gameId, args.callerDeviceClientId);
    const game = await ctx.db.get(args.gameId);
    if (!game) throw new Error('Game not found.');
    if (game.phase !== 'night') {
      throw new Error('Not currently in a night phase.');
    }
    if (game.nightStep !== args.expectedStep) return;
    if (!isNightStep(args.expectedStep)) {
      throw new Error('Unknown night step.');
    }
    const step: NightStep = args.expectedStep;

    const eligibleAt =
      (game.nightStepEndsAt ?? 0) + SKIP_STALL_THRESHOLD_MS;
    if (Date.now() < eligibleAt) {
      throw new Error('This step has not stalled long enough to refresh.');
    }

    // Wipe this step's recorded actions for the current night.
    const types = new Set<string>(STEP_ACTION_TYPES[step]);
    const actions = await ctx.db
      .query('nightActions')
      .withIndex('by_game_night', q =>
        q.eq('gameId', args.gameId).eq('nightNumber', game.nightNumber),
      )
      .collect();
    // Leprechaun: capture any move-off entries contributed by this night's
    // redirects BEFORE deleting them, so we can pop them off `leprechaunMovedOff`.
    const lepRevertIds = new Set<string>();
    if (step === 'leprechaun') {
      for (const a of actions) {
        if (a.actionType !== 'leprechaun_redirect') continue;
        const dir = a.result?.direction;
        if (dir === 'L' || dir === 'R') {
          const orig = a.result?.originalTargetId;
          if (orig) lepRevertIds.add(orig as unknown as string);
        }
      }
    }
    // Nightmare Wolf: collect tonight's sleep targets BEFORE deleting the
    // action rows, so we can clear their `nightmaredOn` flags below. The
    // NW's `nightmaresUsed` doesn't need a revert — it's only updated at
    // morning resolution, so deleting the action row alone is enough.
    const nwSleepTargets = new Set<Id<'players'>>();
    if (step === 'nightmare_wolf') {
      for (const a of actions) {
        if (a.actionType !== 'nightmare_put_to_sleep') continue;
        if (a.targetPlayerId) nwSleepTargets.add(a.targetPlayerId);
      }
    }
    for (const a of actions) {
      if (types.has(a.actionType)) {
        await ctx.db.delete(a._id);
      }
    }

    // Leprechaun: revert the lifetime move-off list to the state it was in
    // before this night's redirects landed. The list is monotonically
    // growing across the game, so popping only entries that match this
    // night's wiped redirect rows preserves prior-night history.
    if (step === 'leprechaun' && lepRevertIds.size > 0) {
      const current = (game.leprechaunMovedOff ?? []) as Id<'players'>[];
      const next = current.filter(
        id => !lepRevertIds.has(id as unknown as string),
      );
      await ctx.db.patch(args.gameId, { leprechaunMovedOff: next });
    }

    // Nightmare Wolf: clear `nightmaredOn` on every player who was put to
    // sleep this night, so their night ability un-blocks on the do-over.
    if (step === 'nightmare_wolf') {
      for (const targetId of nwSleepTargets) {
        const t = await ctx.db.get(targetId);
        if (t && t.roleState?.nightmaredOn === game.nightNumber) {
          const { nightmaredOn, ...rest } = t.roleState;
          void nightmaredOn;
          await ctx.db.patch(targetId, { roleState: rest });
        }
      }
    }

    // Clear step-scoped ephemeral roleState. Today this only matters for the
    // wolves step — each wolf's per-night vote lives on the player doc and
    // must be reset so a stale prior pick doesn't accidentally form a new
    // consensus.
    if (step === 'wolves') {
      const allPlayers = await ctx.db
        .query('players')
        .withIndex('by_game', q => q.eq('gameId', args.gameId))
        .collect();
      for (const p of allPlayers) {
        if (p.roleState && 'wolfVote' in p.roleState) {
          const next = { ...p.roleState };
          delete next.wolfVote;
          await ctx.db.patch(p._id, { roleState: next });
        }
      }
    }

    // Fresh dwell + new tick. Mirror enterStep's auto-resolve so bot actors
    // and "no decision left" witches re-record their no-op actions.
    const dwellMs = randomDwellMs();
    const endsAt = Date.now() + dwellMs;
    await ctx.db.patch(args.gameId, { nightStepEndsAt: endsAt });

    const players = await ctx.db
      .query('players')
      .withIndex('by_game', q => q.eq('gameId', args.gameId))
      .collect();
    const alive = players.filter(p => p.alive);
    const actors = activePlayersForStep(step, alive, game.nightNumber);
    const witchHasNothingLeft =
      step === 'witch' &&
      actors.length > 0 &&
      actors.every(
        a => !!a.roleState?.witchSaveUsed && !!a.roleState?.witchPoisonUsed,
      );
    const mentalistShorthanded =
      step === 'mentalist' &&
      actors.length > 0 &&
      actors.every(a => mentalistValidPool(a, alive).length < 2);
    // Refresh while the diseased-block carryover is still active replays the
    // wolf_blocked row that was just wiped. The flag stays set until morning,
    // so this branch fires whenever a refresh hits a blocked wolves step.
    const wolvesBlocked = step === 'wolves' && !!game.wolvesBlockedNextNight;
    if (wolvesBlocked) {
      await ctx.db.insert('nightActions', {
        gameId: args.gameId,
        nightNumber: game.nightNumber,
        actorPlayerId: actors[0]?._id,
        actionType: 'wolf_blocked',
        resolvedAt: Date.now(),
      });
    } else if (witchHasNothingLeft || mentalistShorthanded) {
      // Whole-step no-op: every actor (human or bot) gets a sleep-through row.
      await autoResolveStep(ctx, args.gameId, step, actors, alive, game.nightNumber);
    } else if (step === 'wolves') {
      // Wolves share a single kill row — auto-resolve only when the whole pack is bots.
      if (actors.length > 0 && actors.every(a => isBotName(a.name))) {
        await autoResolveStep(ctx, args.gameId, step, actors, alive, game.nightNumber);
      }
    } else {
      // Per-actor auto-resolve so mixed games (humans + bots in the same role)
      // don't hang on the bot's missing submission.
      const botActors = actors.filter(a => isBotName(a.name));
      if (botActors.length > 0) {
        await autoResolveStep(ctx, args.gameId, step, botActors, alive, game.nightNumber);
      }
    }

    await ctx.scheduler.runAfter(dwellMs, internal.night.dwellTick, {
      gameId: args.gameId,
      expectedStep: step,
    });
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

    // Sasquatch flip: if the day that just ended had no lynch, alive
    // Sasquatch(es) join the wolf team starting this very night. Fired
    // BEFORE the phase patch so the parity check below sees the new role
    // alignment, and so the seer step on the new night reads post-flip.
    const upcomingNightNumber = game.nightNumber + 1;
    await fireSasquatchConversionsIfDayHadNoLynch(
      ctx,
      args.gameId,
      game.nightNumber,
      game.dayNumber,
      upcomingNightNumber,
    );
    if (await applyWinIfReached(ctx, args.gameId)) return;

    await ctx.db.patch(args.gameId, {
      phase: 'night',
      nightNumber: upcomingNightNumber,
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

    // Case B from resolveMorning: morning was shown, but death-trigger
    // queue is still pending. Route through the 'triggers' phase first.
    // Day starts when the queue empties (see finalizeTriggerPhase).
    if ((game.pendingDeathTriggers?.length ?? 0) > 0) {
      await ctx.db.patch(args.gameId, { phase: 'triggers' });
      await processTriggerQueue(ctx, args.gameId);
      return;
    }

    await ctx.db.patch(args.gameId, {
      phase: 'day',
      dayNumber: game.dayNumber + 1,
    });
    await initializeDayClock(ctx, args.gameId);
  },
});

// ───── Queries ──────────────────────────────────────────────────────────────

// Color tokens for the ghost night log. Gold for action verbs, red for
// wolf-flavor results, blue for village-flavor results, muted grey for
// passes / system entries.
const LOG_COLOR_ACTION = '#D4A017';
const LOG_COLOR_WOLF = '#B03A2E';
const LOG_COLOR_VILLAGE = '#5BA0E5';
const LOG_COLOR_NEUTRAL = '#8A8590';
// Lavender used by NightmareWolfPicker (src/screens/NightScreen.tsx) — reused
// here so the "Has been nightmared." log line picks up the same theming.
const LOG_COLOR_NIGHTMARE = '#B68AD9';

type NightLogEntry = {
  id: string;
  roleLabel: string;
  actorName: string | null;
  statusLabel: string;
  statusColor: string;
  kind: 'action' | 'system';
};

const STEP_ROLE_LABEL: Record<NightStep, string> = {
  wolves: 'Wolves',
  nightmare_wolf: 'Nightmare Wolf',
  seer: 'Seer',
  pi: 'P.I.',
  mentalist: 'Mentalist',
  witch: 'Witch',
  leprechaun: 'Leprechaun',
  bodyguard: 'Bodyguard',
  huntress: 'Huntress',
  revealer: 'Revealer',
  reviler: 'Reviler',
  cursed_conversion: 'Cursed',
  doppelganger_dawn: 'Doppelganger',
  doppelganger_dusk: 'Doppelganger',
};

// Maps each actor-driven night step to the role name a player must hold to
// be an actor for it. Used to build the per-actor card list — for every
// player currently holding the role, we emit one card per night (acted /
// eliminated / nightmared / spent / waiting).
const STEP_TO_ROLE: Partial<Record<NightStep, string>> = {
  nightmare_wolf: 'Nightmare Wolf',
  seer: 'Seer',
  pi: 'Paranormal Investigator',
  mentalist: 'Mentalist',
  witch: 'Witch',
  leprechaun: 'Leprechaun',
  bodyguard: 'Bodyguard',
  huntress: 'Huntress',
  revealer: 'Revealer',
  reviler: 'Reviler',
};

/**
 * Build the single ghost-log card for one role-holder on one step. Returns
 * null if they're alive, eligible, and haven't acted yet (waiting state —
 * the wake-order header alone tells the ghost which role is up). Otherwise
 * folds the actor's state into one card: their action if they took it,
 * "Chooses not to use power" for active skips, or a system entry naming why
 * they can't act (eliminated / nightmared / power already used).
 */
function buildActorCardForStep(
  step: NightStep,
  actor: Player,
  allActions: Doc<'nightActions'>[],
  nightNumber: number,
  nameOf: (id?: Id<'players'>) => string,
  roleOf: (id?: Id<'players'>) => string,
): NightLogEntry | null {
  // Tag converted Doppelgangers in the role label so ghosts can distinguish
  // the original role-holder from the convert — e.g. two "P.I." cards become
  // "P.I." and "P.I. (Doppelganger)".
  const isConvertedDoppelganger =
    actor.originalRole === 'Doppelganger' && actor.role !== 'Doppelganger';
  const roleLabel = isConvertedDoppelganger
    ? `${STEP_ROLE_LABEL[step]} (Doppelganger)`
    : STEP_ROLE_LABEL[step];
  const findRow = (type: string) =>
    allActions.find(
      a => a.actorPlayerId === actor._id && a.actionType === type,
    );
  const eliminated = !actor.alive;
  const nightmared = !eliminated && isNightmared(actor, nightNumber);

  const entry = (
    statusLabel: string,
    statusColor: string,
    kind: 'action' | 'system' = 'action',
    overrideId?: string,
  ): NightLogEntry => ({
    id:
      overrideId ?? `${step}-${actor._id as unknown as string}-${nightNumber}`,
    roleLabel,
    actorName: actor.name,
    statusLabel,
    statusColor,
    kind,
  });

  const eliminatedEntry = () =>
    entry('This player has been eliminated.', LOG_COLOR_NEUTRAL, 'system');
  const nightmaredEntry = () =>
    entry('Has been nightmared.', LOG_COLOR_NIGHTMARE, 'system');
  const passEntry = (row: Doc<'nightActions'>) =>
    entry(
      'Chooses not to use power',
      LOG_COLOR_NEUTRAL,
      'action',
      row._id as unknown as string,
    );
  const spentEntry = (text: string) =>
    entry(text, LOG_COLOR_NEUTRAL, 'system');

  switch (step) {
    case 'nightmare_wolf': {
      const put = findRow('nightmare_put_to_sleep');
      if (put?.targetPlayerId) {
        return entry(
          `Put ${nameOf(put.targetPlayerId as Id<'players'>)} to sleep`,
          LOG_COLOR_ACTION,
          'action',
          put._id as unknown as string,
        );
      }
      const skip = findRow('nightmare_skip');
      if (skip) return passEntry(skip);
      if (eliminated) return eliminatedEntry();
      if (nightmared) return nightmaredEntry();
      const usedCount = ((actor.roleState?.nightmaresUsed as unknown[]) ?? [])
        .length;
      if (usedCount >= 2) return spentEntry('All charges used.');
      return null;
    }
    case 'seer': {
      const check = findRow('seer_check');
      if (check?.targetPlayerId) {
        const team = check.result?.team;
        const teamLabel = team === 'wolf' ? 'WOLF' : 'VILLAGE';
        return entry(
          `Investigated ${nameOf(check.targetPlayerId as Id<'players'>)} — ${teamLabel}`,
          team === 'wolf' ? LOG_COLOR_WOLF : LOG_COLOR_VILLAGE,
          'action',
          check._id as unknown as string,
        );
      }
      if (eliminated) return eliminatedEntry();
      if (nightmared) return nightmaredEntry();
      return null;
    }
    case 'pi': {
      const check = findRow('pi_check');
      if (check?.targetPlayerId) {
        const team = check.result?.team;
        const teamLabel = team === 'wolf' ? 'WOLF NEARBY' : 'NO WOLVES';
        return entry(
          `Trio-checked ${nameOf(check.targetPlayerId as Id<'players'>)} — ${teamLabel}`,
          team === 'wolf' ? LOG_COLOR_WOLF : LOG_COLOR_VILLAGE,
          'action',
          check._id as unknown as string,
        );
      }
      const skip = findRow('pi_skip');
      if (skip) return passEntry(skip);
      if (eliminated) return eliminatedEntry();
      if (nightmared) return nightmaredEntry();
      if (actor.roleState?.piUsed) return spentEntry('Power has been used.');
      return null;
    }
    case 'mentalist': {
      const check = findRow('mentalist_check');
      if (check?.result) {
        const firstId = check.result.firstId as Id<'players'>;
        const secondId = check.result.secondId as Id<'players'>;
        const same = check.result.sameTeam;
        const teamLabel = same === 'same' ? 'SAME TEAM' : 'DIFFERENT TEAMS';
        return entry(
          `Compared ${nameOf(firstId)} & ${nameOf(secondId)} — ${teamLabel}`,
          same === 'same' ? LOG_COLOR_VILLAGE : LOG_COLOR_WOLF,
          'action',
          check._id as unknown as string,
        );
      }
      const skip = findRow('mentalist_skip');
      if (skip) {
        // Mentalist skip = "no valid pair tonight" (forced by house rules,
        // not an active choice), keep its descriptive label.
        return entry(
          'No valid pair tonight',
          LOG_COLOR_NEUTRAL,
          'action',
          skip._id as unknown as string,
        );
      }
      if (eliminated) return eliminatedEntry();
      if (nightmared) return nightmaredEntry();
      return null;
    }
    case 'witch': {
      const save = findRow('witch_save');
      const poison = findRow('witch_poison');
      const done = findRow('witch_done');
      if (done) {
        const parts: string[] = [];
        if (save) parts.push('Used the save potion');
        if (poison?.targetPlayerId) {
          parts.push(
            `Poisoned ${nameOf(poison.targetPlayerId as Id<'players'>)}`,
          );
        }
        if (parts.length === 0) {
          // Done with neither save nor poison this night. Distinguish "chose
          // not to" from "had nothing left" using carryover flags.
          const saveSpentBefore = !!actor.roleState?.witchSaveUsed && !save;
          const poisonSpentBefore =
            !!actor.roleState?.witchPoisonUsed && !poison;
          if (saveSpentBefore && poisonSpentBefore) {
            return spentEntry('All potions used.');
          }
          return passEntry(done);
        }
        return entry(
          parts.join('  ·  '),
          poison ? LOG_COLOR_WOLF : LOG_COLOR_VILLAGE,
          'action',
          done._id as unknown as string,
        );
      }
      if (eliminated) return eliminatedEntry();
      if (nightmared) return nightmaredEntry();
      if (actor.roleState?.witchSaveUsed && actor.roleState?.witchPoisonUsed) {
        return spentEntry('All potions used.');
      }
      return null;
    }
    case 'leprechaun': {
      const redirect = findRow('leprechaun_redirect');
      if (redirect) {
        const dir = redirect.result?.direction;
        if (dir === 'L' || dir === 'R') {
          const arrow = dir === 'L' ? 'left' : 'right';
          const t = nameOf(redirect.result?.newTargetId as Id<'players'>);
          return entry(
            `Redirected the kill ${arrow} to ${t}`,
            LOG_COLOR_ACTION,
            'action',
            redirect._id as unknown as string,
          );
        }
        return passEntry(redirect);
      }
      if (eliminated) return eliminatedEntry();
      if (nightmared) return nightmaredEntry();
      return null;
    }
    case 'bodyguard': {
      const protect = findRow('bg_protect');
      if (protect?.targetPlayerId) {
        return entry(
          `Protected ${nameOf(protect.targetPlayerId as Id<'players'>)}`,
          LOG_COLOR_VILLAGE,
          'action',
          protect._id as unknown as string,
        );
      }
      if (eliminated) return eliminatedEntry();
      if (nightmared) return nightmaredEntry();
      return null;
    }
    case 'huntress': {
      const shot = findRow('huntress_shot');
      if (shot?.targetPlayerId) {
        return entry(
          `Shot ${nameOf(shot.targetPlayerId as Id<'players'>)}`,
          LOG_COLOR_WOLF,
          'action',
          shot._id as unknown as string,
        );
      }
      const skip = findRow('huntress_skip');
      if (skip) return passEntry(skip);
      if (eliminated) return eliminatedEntry();
      if (nightmared) return nightmaredEntry();
      if (actor.roleState?.huntressUsed)
        return spentEntry('Power has been used.');
      return null;
    }
    case 'revealer': {
      const shot = findRow('revealer_shot');
      if (shot?.targetPlayerId) {
        const tId = shot.targetPlayerId as Id<'players'>;
        const t = nameOf(tId);
        const r = roleOf(tId);
        return entry(
          r ? `Revealed ${t} — ${r}` : `Revealed ${t}`,
          LOG_COLOR_ACTION,
          'action',
          shot._id as unknown as string,
        );
      }
      const skip = findRow('revealer_skip');
      if (skip) return passEntry(skip);
      if (eliminated) return eliminatedEntry();
      if (nightmared) return nightmaredEntry();
      return null;
    }
    case 'reviler': {
      const shot = findRow('reviler_shot');
      if (shot?.targetPlayerId) {
        return entry(
          `Cursed ${nameOf(shot.targetPlayerId as Id<'players'>)}`,
          LOG_COLOR_WOLF,
          'action',
          shot._id as unknown as string,
        );
      }
      const skip = findRow('reviler_skip');
      if (skip) return passEntry(skip);
      if (eliminated) return eliminatedEntry();
      if (nightmared) return nightmaredEntry();
      return null;
    }
    default:
      return null;
  }
}

/**
 * Builds the per-actor / per-event ghost log. Walks NIGHT_STEPS up to and
 * including the current step:
 *
 * - For each *actor-driven* step in the game, emits one card per player
 *   currently holding the role (sorted by seat). The card either renders
 *   their action, "Chooses not to use power" for an active skip, or a
 *   system entry naming why they can't act ("This player has been
 *   eliminated.", "Has been nightmared.", "Power has been used.", etc.).
 *   Alive eligible actors who haven't acted yet emit no card — the
 *   wake-order header alone tells the ghost which role is up.
 *
 * - For the *wolves* step, emits "The pack" cards keyed off wolf_kill /
 *   wolf_blocked rows, plus standalone Sasquatch flip cards.
 *
 * - For *cursed_conversion* / *doppelganger_dawn* / *doppelganger_dusk*,
 *   emits cards only when an actual conversion event row exists. The step
 *   header is deliberately neutral (THE VILLAGE AWAITS DAWN) so the ghost
 *   isn't tipped off that a conversion might be in progress.
 */
async function buildNightLog(
  ctx: QueryCtx,
  gameId: Id<'games'>,
  nightNumber: number,
  currentStep: NightStep,
  selectedRoles: string[],
  players: Player[],
): Promise<NightLogEntry[]> {
  const allActions = await ctx.db
    .query('nightActions')
    .withIndex('by_game_night', q =>
      q.eq('gameId', gameId).eq('nightNumber', nightNumber),
    )
    .collect();
  const playerById = new Map(players.map(p => [p._id, p]));
  const nameOf = (id?: Id<'players'>) => {
    if (!id) return '';
    return playerById.get(id as Id<'players'>)?.name ?? 'unknown';
  };
  const roleOf = (id?: Id<'players'>) => {
    if (!id) return '';
    return playerById.get(id as Id<'players'>)?.role ?? '';
  };

  const currentIdx = NIGHT_STEPS.indexOf(currentStep);
  if (currentIdx < 0) return [];

  const log: NightLogEntry[] = [];
  let wolfKillSeen = 0;

  for (let i = 0; i <= currentIdx; i++) {
    const step = NIGHT_STEPS[i];
    if (!stepIsInGame(step, selectedRoles)) continue;

    if (step === 'wolves') {
      // Collective pack actions: kill rows + diseased-block + sasquatch flip.
      // Surface the wolves by name on the card so ghosts know exactly who
      // the pack is. Sasquatch / Cursed conversions that haven't fired yet
      // this night aren't yet in the wolf-team — they'll show on their
      // first night as wolves.
      const wolfNames =
        players
          .filter(p => p.alive && p.role && isWolfTeam(p.role))
          .sort((a, b) => (a.seatPosition ?? 0) - (b.seatPosition ?? 0))
          .map(p => p.name)
          .join(', ') || 'The pack';
      const wolfRows = allActions
        .filter(
          a =>
            a.actionType === 'wolf_kill' ||
            a.actionType === 'wolf_blocked' ||
            a.actionType === 'sasquatch_conversion',
        )
        .sort((a, b) => a.resolvedAt - b.resolvedAt);
      for (const action of wolfRows) {
        const id = action._id as unknown as string;
        if (action.actionType === 'wolf_kill') {
          wolfKillSeen++;
          const t = nameOf(action.targetPlayerId as Id<'players'>);
          log.push({
            id,
            roleLabel: 'Wolves',
            actorName: wolfNames,
            statusLabel:
              wolfKillSeen > 1 ? `Also targeted ${t}` : `Targeted ${t}`,
            statusColor: LOG_COLOR_WOLF,
            kind: 'action',
          });
        } else if (action.actionType === 'wolf_blocked') {
          log.push({
            id,
            roleLabel: 'Wolves',
            actorName: wolfNames,
            statusLabel: 'Blocked by a diseased meal — no kill tonight.',
            statusColor: LOG_COLOR_NEUTRAL,
            kind: 'action',
          });
        } else if (action.actionType === 'sasquatch_conversion') {
          const actor = action.actorPlayerId
            ? playerById.get(action.actorPlayerId)
            : undefined;
          const wasDopp =
            actor?.originalRole === 'Doppelganger' &&
            actor?.role !== 'Doppelganger';
          log.push({
            id,
            roleLabel: wasDopp ? 'Sasquatch (Doppelganger)' : 'Sasquatch',
            actorName: actor?.name ?? '',
            statusLabel: 'Joined the wolf pack',
            statusColor: LOG_COLOR_WOLF,
            kind: 'action',
          });
        }
      }
      continue;
    }

    if (step === 'cursed_conversion') {
      const rows = allActions.filter(a => a.actionType === 'cursed_conversion');
      for (const action of rows) {
        const actor = action.actorPlayerId
          ? playerById.get(action.actorPlayerId)
          : undefined;
        const wasDopp =
          actor?.originalRole === 'Doppelganger' &&
          actor?.role !== 'Doppelganger';
        log.push({
          id: action._id as unknown as string,
          roleLabel: wasDopp ? 'Cursed (Doppelganger)' : 'Cursed',
          actorName: actor?.name ?? '',
          statusLabel: 'Was bitten and is now a Werewolf',
          statusColor: LOG_COLOR_WOLF,
          kind: 'action',
        });
      }
      continue;
    }

    if (step === 'doppelganger_dawn' || step === 'doppelganger_dusk') {
      const rows = allActions.filter(
        a => a.actionType === 'doppelganger_conversion_reveal',
      );
      for (const action of rows) {
        const actor = action.actorPlayerId
          ? playerById.get(action.actorPlayerId)
          : undefined;
        // The conversion row stamped at nightNumber=0 carries toRole +
        // victim attribution — look it up.
        const conversionRows = await ctx.db
          .query('nightActions')
          .withIndex('by_game_night', q =>
            q.eq('gameId', gameId).eq('nightNumber', 0),
          )
          .filter(q =>
            q.and(
              q.eq(q.field('actionType'), 'doppelganger_conversion'),
              q.eq(q.field('actorPlayerId'), action.actorPlayerId),
            ),
          )
          .collect();
        const conversion = conversionRows[0];
        const toRole = conversion?.result?.toRole as string | undefined;
        const victimName = nameOf(
          conversion?.targetPlayerId as Id<'players'> | undefined,
        );
        log.push({
          id: action._id as unknown as string,
          roleLabel: 'Doppelganger',
          actorName: actor?.name ?? '',
          statusLabel: toRole
            ? `Took on ${victimName}'s role (${toRole})`
            : 'Took on a new role',
          statusColor: LOG_COLOR_ACTION,
          kind: 'action',
        });
      }
      continue;
    }

    // Actor-driven step: one card per role-holder, sorted by seat.
    const role = STEP_TO_ROLE[step];
    if (!role) continue;
    const rolePlayers = players
      .filter(p => p.role === role)
      .sort((a, b) => (a.seatPosition ?? 0) - (b.seatPosition ?? 0));
    for (const actor of rolePlayers) {
      const card = buildActorCardForStep(
        step,
        actor,
        allActions,
        nightNumber,
        nameOf,
        roleOf,
      );
      if (card) log.push(card);
    }
  }

  return log;
}

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
      const actors = activePlayersForStep(step, alive, game.nightNumber);
      isMyStep = actors.some(a => a._id === me._id);
    }

    // Ghost-spectator perspective: dead players mirror exactly what the alive
    // actor of the current step sees. `actorForRole` returns me when I'm the
    // alive actor for a role, or the alive actor when I'm dead and the step
    // matches. Returning undefined means this role's data is not visible to
    // this viewer.
    const stepActors: Player[] = step
      ? activePlayersForStep(step, alive, game.nightNumber)
      : [];
    const actorForRole = (
      roleName: string,
      stepName: NightStep,
    ): Player | undefined => {
      if (me.alive && me.role === roleName) {
        // On the role's own step, only return me if I'm still in the active
        // list — otherwise spent one-time roles (PI, Huntress, fully-used
        // Nightmare Wolf) and nightmared pickers would have their XState
        // populated and their picker would flash on-screen during the
        // step's natural cloaking dwell before it auto-advances. On any
        // other step, return me eagerly — the picker tree only renders
        // when nightStep matches the role, so populating XState elsewhere
        // is harmless and keeps spectator views consistent.
        if (step === stepName) {
          return stepActors.some(a => a._id === me._id) ? me : undefined;
        }
        return me;
      }
      if (!me.alive && step === stepName) {
        return stepActors.find(a => a.role === roleName);
      }
      return undefined;
    };

    // Wolf-step live state: visible to alive wolves and to dead spectators
    // during the wolves step. `blocked` is true when a Diseased was eaten
    // last night — wolves see a sickened-pack view in place of the picker.
    // `requiredKills` and `killsSoFar` together signal a Wolf Cub vengeance
    // night: when the cub died before this night, requiredKills is 2 and
    // the picker walks the wolves through two sequential targets.
    let wolfState:
      | {
          wolves: Array<{
            _id: Id<'players'>;
            name: string;
            role: string;
            isMe: boolean;
            currentVote?: Id<'players'>;
          }>;
          blocked: boolean;
          requiredKills: number;
          killsSoFar: Array<{ targetId: Id<'players'>; targetName: string }>;
        }
      | null = null;
    // Set on the caller's view when they're a freshly-flipped Sasquatch — the
    // wolves-step overlay reads this to show "YOU NOW JOIN THE WOLVES" once.
    // Cleared server-side when the wolves step advances.
    const sasquatchReveal =
      step === 'wolves' &&
      me.alive &&
      me.role === 'Werewolf' &&
      !!me.roleState?.pendingSasquatchReveal;
    const wolfPerspective =
      step === 'wolves' &&
      ((me.alive && me.role && isWolfTeam(me.role)) || !me.alive);
    if (wolfPerspective) {
      const aliveWolves = alive.filter(p => p.role && isWolfTeam(p.role));
      const required = computeRequiredKills(game, alive);
      const killRows = await getNightActions(
        ctx,
        args.gameId,
        game.nightNumber,
        'wolf_kill',
      );
      const killsSoFar: Array<{
        targetId: Id<'players'>;
        targetName: string;
      }> = [];
      for (const k of killRows) {
        const tid = k.targetPlayerId as Id<'players'> | undefined;
        if (!tid) continue;
        const t = players.find(p => p._id === tid);
        if (t) killsSoFar.push({ targetId: tid, targetName: t.name });
      }
      wolfState = {
        wolves: aliveWolves.map(w => ({
          _id: w._id,
          name: w.name,
          role: w.role!,
          isMe: w._id === me._id,
          currentVote: w.roleState?.wolfVote as Id<'players'> | undefined,
        })),
        blocked: !!game.wolvesBlockedNextNight,
        requiredKills: required,
        killsSoFar,
      };
    }

    // Seer's running history of checks. Visible to the alive Seer always,
    // and to dead spectators only during the seer step (so the ghost view
    // shows exactly what the Seer's screen shows right now).
    let seerHistory: Array<{
      nightNumber: number;
      targetName: string;
      team: 'wolf' | 'villager';
    }> | null = null;
    const seerActor = actorForRole('Seer', 'seer');
    if (seerActor) {
      const checks = await ctx.db
        .query('nightActions')
        .withIndex('by_game_night', q => q.eq('gameId', args.gameId))
        .collect();
      const playerById = new Map(players.map(p => [p._id, p]));
      seerHistory = checks
        .filter(
          c =>
            c.actorPlayerId === seerActor._id && c.actionType === 'seer_check',
        )
        .sort((a, b) => a.nightNumber - b.nightNumber)
        .map(c => ({
          nightNumber: c.nightNumber,
          targetName: c.targetPlayerId
            ? playerById.get(c.targetPlayerId)?.name ?? 'unknown'
            : 'unknown',
          team: (c.result?.team as 'wolf' | 'villager') ?? 'villager',
        }));
    }

    // PI-only state. piUsed flips at morning resolution; once true, this
    // player no longer has anything to do at night.
    let piState: {
      piUsed: boolean;
      hasActedThisNight: boolean;
      history: Array<{
        nightNumber: number;
        targetName: string;
        team: 'wolf' | 'village';
      }>;
    } | null = null;
    const piActor = actorForRole('Paranormal Investigator', 'pi');
    if (piActor) {
      const playerById = new Map(players.map(p => [p._id, p]));
      const allActions = await ctx.db
        .query('nightActions')
        .withIndex('by_game_night', q => q.eq('gameId', args.gameId))
        .collect();
      const myCheckHistory = allActions
        .filter(
          a => a.actorPlayerId === piActor._id && a.actionType === 'pi_check',
        )
        .sort((a, b) => a.nightNumber - b.nightNumber)
        .map(a => ({
          nightNumber: a.nightNumber,
          targetName: a.targetPlayerId
            ? playerById.get(a.targetPlayerId)?.name ?? 'unknown'
            : 'unknown',
          team: (a.result?.team as 'wolf' | 'village') ?? 'village',
        }));
      const hasActedThisNight = allActions.some(
        a =>
          a.actorPlayerId === piActor._id &&
          a.nightNumber === game.nightNumber &&
          (a.actionType === 'pi_check' || a.actionType === 'pi_skip'),
      );
      piState = {
        piUsed: !!piActor.roleState?.piUsed,
        hasActedThisNight,
        history: myCheckHistory,
      };
    }

    // Mentalist-only state. History of prior comparisons with both target
    // names; hasActedThisNight gates the locked waiting view. `lockedTargets`
    // is last night's pair (off-limits this night). `noValidTargets` is true
    // when the valid pool drops below 2, in which case the engine auto-passes
    // the step and the picker shows a "shorthanded — passing" explanation.
    let mentalistState: {
      hasActedThisNight: boolean;
      noValidTargets: boolean;
      lockedTargets: Array<{ _id: Id<'players'>; name: string }>;
      history: Array<{
        nightNumber: number;
        firstName: string;
        secondName: string;
        sameTeam: 'same' | 'different';
      }>;
    } | null = null;
    const mentalistActor = actorForRole('Mentalist', 'mentalist');
    if (mentalistActor) {
      const playerById = new Map(players.map(p => [p._id, p]));
      const allActions = await ctx.db
        .query('nightActions')
        .withIndex('by_game_night', q => q.eq('gameId', args.gameId))
        .collect();
      const myChecks = allActions
        .filter(
          a =>
            a.actorPlayerId === mentalistActor._id &&
            a.actionType === 'mentalist_check',
        )
        .sort((a, b) => a.nightNumber - b.nightNumber);
      const history = myChecks.map(a => {
        const firstId = a.result?.firstId as Id<'players'> | undefined;
        const secondId = a.result?.secondId as Id<'players'> | undefined;
        return {
          nightNumber: a.nightNumber,
          firstName: firstId
            ? playerById.get(firstId)?.name ?? 'unknown'
            : 'unknown',
          secondName: secondId
            ? playerById.get(secondId)?.name ?? 'unknown'
            : 'unknown',
          sameTeam: (a.result?.sameTeam as 'same' | 'different') ?? 'different',
        };
      });
      const lastTargets = (mentalistActor.roleState?.mentalistLastTargets ??
        []) as Id<'players'>[];
      const lockedTargets = lastTargets
        .map(id => playerById.get(id))
        .filter((p): p is Player => !!p)
        .map(p => ({ _id: p._id, name: p.name }));
      const hasActedThisNight = allActions.some(
        a =>
          a.actorPlayerId === mentalistActor._id &&
          a.nightNumber === game.nightNumber &&
          (a.actionType === 'mentalist_check' ||
            a.actionType === 'mentalist_skip'),
      );
      const noValidTargets =
        mentalistValidPool(mentalistActor, alive).length < 2;
      mentalistState = {
        hasActedThisNight,
        noValidTargets,
        lockedTargets,
        history,
      };
    }

    // Witch-only state. Tonight's victims are hidden once save has been used
    // (per house rules — after using save, witch no longer sees the wolf
    // victim). On a Wolf Cub vengeance night there are TWO victims; the
    // potion saves exactly one. savedTonight/poisonedTonight track
    // in-progress decisions so the picker can hide each button independently.
    let witchState: {
      saveUsed: boolean;
      poisonUsed: boolean;
      savedTonight: boolean;
      poisonedTonight: boolean;
      hasActedThisNight: boolean;
      tonightVictims: Array<{ _id: Id<'players'>; name: string }>;
      tonightSaveTarget: { _id: Id<'players'>; name: string } | null;
      tonightPoisonTarget: { _id: Id<'players'>; name: string } | null;
    } | null = null;
    const witchActor = actorForRole('Witch', 'witch');
    if (witchActor) {
      const playerById = new Map(players.map(p => [p._id, p]));
      const saveUsed = !!witchActor.roleState?.witchSaveUsed;
      const poisonUsed = !!witchActor.roleState?.witchPoisonUsed;
      const myActions = await ctx.db
        .query('nightActions')
        .withIndex('by_game_night', q =>
          q.eq('gameId', args.gameId).eq('nightNumber', game.nightNumber),
        )
        .collect();
      const savedTonight = myActions.some(
        a =>
          a.actorPlayerId === witchActor._id && a.actionType === 'witch_save',
      );
      const poisonedTonight = myActions.some(
        a =>
          a.actorPlayerId === witchActor._id && a.actionType === 'witch_poison',
      );
      const hasActedThisNight = myActions.some(
        a =>
          a.actorPlayerId === witchActor._id && a.actionType === 'witch_done',
      );
      const tonightVictims: Array<{ _id: Id<'players'>; name: string }> = [];
      if (!saveUsed) {
        const kills = myActions.filter(a => a.actionType === 'wolf_kill');
        for (const k of kills) {
          const victimId = k.targetPlayerId as Id<'players'> | undefined;
          if (!victimId) continue;
          const victim = playerById.get(victimId);
          if (victim) {
            tonightVictims.push({ _id: victim._id, name: victim.name });
          }
        }
      }
      let tonightSaveTarget:
        | { _id: Id<'players'>; name: string }
        | null = null;
      if (savedTonight) {
        const saveAction = myActions.find(
          a =>
            a.actorPlayerId === witchActor._id &&
            a.actionType === 'witch_save',
        );
        const targetId = saveAction?.targetPlayerId;
        if (targetId) {
          const target = playerById.get(targetId);
          if (target) {
            tonightSaveTarget = { _id: target._id, name: target.name };
          }
        }
      }
      let tonightPoisonTarget:
        | { _id: Id<'players'>; name: string }
        | null = null;
      if (poisonedTonight) {
        const poisonAction = myActions.find(
          a =>
            a.actorPlayerId === witchActor._id &&
            a.actionType === 'witch_poison',
        );
        const targetId = poisonAction?.targetPlayerId;
        if (targetId) {
          const target = playerById.get(targetId);
          if (target) {
            tonightPoisonTarget = { _id: target._id, name: target.name };
          }
        }
      }
      witchState = {
        saveUsed,
        poisonUsed,
        savedTonight,
        poisonedTonight,
        hasActedThisNight,
        tonightVictims,
        tonightSaveTarget,
        tonightPoisonTarget,
      };
    }

    // Leprechaun-only state. Sees the wolves' first kill target (or the
    // diseased-blocked signal); picks LEFT / LEAVE / RIGHT. LEFT/RIGHT are
    // greyed when the target has previously been moved off (lifetime limit).
    // Post-action, `tonightRedirect` captures the choice for the locked
    // waiting view.
    let leprechaunState: {
      blocked: boolean;
      hasActedThisNight: boolean;
      wolfTarget: { _id: Id<'players'>; name: string } | null;
      leftNeighbor: { _id: Id<'players'>; name: string } | null;
      rightNeighbor: { _id: Id<'players'>; name: string } | null;
      canMoveOff: boolean;
      tonightRedirect: {
        direction: 'L' | 'R' | 'leave';
        originalTargetName: string | null;
        newTargetName: string | null;
        blocked: boolean;
      } | null;
    } | null = null;
    const lepActor = actorForRole('Leprechaun', 'leprechaun');
    if (lepActor) {
      const playerById = new Map(players.map(p => [p._id, p]));
      const bySeat = new Map<number, Player>();
      for (const p of players) {
        if (typeof p.seatPosition === 'number') bySeat.set(p.seatPosition, p);
      }
      const myActions = await ctx.db
        .query('nightActions')
        .withIndex('by_game_night', q =>
          q.eq('gameId', args.gameId).eq('nightNumber', game.nightNumber),
        )
        .collect();
      const lepRedirect = myActions.find(
        a =>
          a.actorPlayerId === lepActor._id &&
          a.actionType === 'leprechaun_redirect',
      );
      const hasActedThisNight = !!lepRedirect;
      const blocked = myActions.some(a => a.actionType === 'wolf_blocked');

      let wolfTarget: { _id: Id<'players'>; name: string } | null = null;
      let leftNeighbor: { _id: Id<'players'>; name: string } | null = null;
      let rightNeighbor: { _id: Id<'players'>; name: string } | null = null;
      let canMoveOff = true;
      if (!blocked) {
        const killRows = myActions
          .filter(a => a.actionType === 'wolf_kill')
          .slice()
          .sort((a, b) => a.resolvedAt - b.resolvedAt);
        const firstKill = killRows[0];
        const targetId = firstKill?.targetPlayerId as
          | Id<'players'>
          | undefined;
        if (targetId) {
          const t = playerById.get(targetId);
          if (t) wolfTarget = { _id: t._id, name: t.name };
          const movedOff = (game.leprechaunMovedOff ?? []) as Id<'players'>[];
          canMoveOff = !movedOff.includes(targetId);
          if (t && typeof t.seatPosition === 'number') {
            const leftId = nextAliveSeatId(
              t.seatPosition,
              1,
              game.playerCount,
              bySeat,
            );
            if (leftId) {
              const lp = playerById.get(leftId);
              if (lp) leftNeighbor = { _id: lp._id, name: lp.name };
            }
            const rightId = nextAliveSeatId(
              t.seatPosition,
              -1,
              game.playerCount,
              bySeat,
            );
            if (rightId) {
              const rp = playerById.get(rightId);
              if (rp) rightNeighbor = { _id: rp._id, name: rp.name };
            }
          }
        }
      }

      let tonightRedirect:
        | {
            direction: 'L' | 'R' | 'leave';
            originalTargetName: string | null;
            newTargetName: string | null;
            blocked: boolean;
          }
        | null = null;
      if (lepRedirect) {
        const result = (lepRedirect.result ?? {}) as {
          direction?: 'L' | 'R' | 'leave';
          originalTargetId?: Id<'players'>;
          newTargetId?: Id<'players'>;
          blocked?: boolean;
        };
        const origId = result.originalTargetId;
        const newId = result.newTargetId;
        tonightRedirect = {
          direction: result.direction ?? 'leave',
          originalTargetName: origId
            ? playerById.get(origId)?.name ?? null
            : null,
          newTargetName: newId ? playerById.get(newId)?.name ?? null : null,
          blocked: !!result.blocked,
        };
      }

      leprechaunState = {
        blocked,
        hasActedThisNight,
        wolfTarget,
        leftNeighbor,
        rightNeighbor,
        canMoveOff,
        tonightRedirect,
      };
    }

    // Nightmare Wolf state. Visible to the alive NW always, and to dead
    // spectators during the nightmare_wolf step (ghost mirror). `charges`
    // counts down from 2; `prevTargetIds` tracks the same-target restriction;
    // `hasActedThisNight` drives the locked waiting view after the pick.
    let nightmareWolfState: {
      charges: number;
      prevTargets: Array<{ _id: Id<'players'>; name: string }>;
      hasActedThisNight: boolean;
      tonightTarget: { _id: Id<'players'>; name: string } | null;
      tonightSkipped: boolean;
    } | null = null;
    const nwActor = actorForRole('Nightmare Wolf', 'nightmare_wolf');
    if (nwActor) {
      const playerById = new Map(players.map(p => [p._id, p]));
      const usedIds =
        (nwActor.roleState?.nightmaresUsed as Id<'players'>[] | undefined) ?? [];
      const prevTargets = usedIds
        .map(id => playerById.get(id))
        .filter((p): p is Player => !!p)
        .map(p => ({ _id: p._id, name: p.name }));
      const myActions = await ctx.db
        .query('nightActions')
        .withIndex('by_game_night', q =>
          q.eq('gameId', args.gameId).eq('nightNumber', game.nightNumber),
        )
        .collect();
      const putAction = myActions.find(
        a =>
          a.actorPlayerId === nwActor._id &&
          a.actionType === 'nightmare_put_to_sleep',
      );
      const skipAction = myActions.find(
        a =>
          a.actorPlayerId === nwActor._id && a.actionType === 'nightmare_skip',
      );
      let tonightTarget: { _id: Id<'players'>; name: string } | null = null;
      if (putAction?.targetPlayerId) {
        const t = playerById.get(putAction.targetPlayerId);
        if (t) tonightTarget = { _id: t._id, name: t.name };
      }
      nightmareWolfState = {
        charges: Math.max(0, 2 - usedIds.length),
        prevTargets,
        hasActedThisNight: !!(putAction || skipAction),
        tonightTarget,
        tonightSkipped: !!skipAction,
      };
    }

    // True only when the *living* caller would be the actor for the current
    // step but was filtered out because they were nightmared this night. The
    // NightScreen replaces their normal picker with a "you've been put to
    // sleep" overlay during the step's dwell. Wolves / nightmare_wolf /
    // resolution steps are never blocked.
    const nightmaredBlocking =
      me.alive &&
      step !== undefined &&
      NIGHTMARE_BLOCKABLE_STEPS.has(step) &&
      isNightmared(me, game.nightNumber) &&
      ((step === 'seer' && me.role === 'Seer') ||
        (step === 'pi' && me.role === 'Paranormal Investigator') ||
        (step === 'mentalist' && me.role === 'Mentalist') ||
        (step === 'witch' && me.role === 'Witch') ||
        (step === 'leprechaun' && me.role === 'Leprechaun') ||
        (step === 'bodyguard' && me.role === 'Bodyguard') ||
        (step === 'huntress' && me.role === 'Huntress') ||
        (step === 'revealer' && me.role === 'Revealer') ||
        (step === 'reviler' && me.role === 'Reviler'));

    // Reviler-only state. Solo antagonist; same shape as revealerState.
    let revilerState: {
      hasActedThisNight: boolean;
      tonightShot: { _id: Id<'players'>; name: string } | null;
      tonightSkipped: boolean;
    } | null = null;
    const revilerActor = actorForRole('Reviler', 'reviler');
    if (revilerActor) {
      const playerById = new Map(players.map(p => [p._id, p]));
      const myActions = await ctx.db
        .query('nightActions')
        .withIndex('by_game_night', q =>
          q.eq('gameId', args.gameId).eq('nightNumber', game.nightNumber),
        )
        .collect();
      const shotAction = myActions.find(
        a =>
          a.actorPlayerId === revilerActor._id &&
          a.actionType === 'reviler_shot',
      );
      const skipAction = myActions.find(
        a =>
          a.actorPlayerId === revilerActor._id &&
          a.actionType === 'reviler_skip',
      );
      let tonightShot: { _id: Id<'players'>; name: string } | null = null;
      if (shotAction?.targetPlayerId) {
        const t = playerById.get(shotAction.targetPlayerId);
        if (t) tonightShot = { _id: t._id, name: t.name };
      }
      revilerState = {
        hasActedThisNight: !!(shotAction || skipAction),
        tonightShot,
        tonightSkipped: !!skipAction,
      };
    }

    // Cursed conversion reveal. Populated only when the cursed_conversion
    // step is active AND tonight produced a conversion. Visible to:
    //   - the alive Cursed whose conversion fired (`isMine: true`), OR
    //   - dead spectators during the cursed_conversion step (ghost mirror).
    // An unconverted living Cursed sees the generic WaitingView — they have
    // no way to tell whether the wolves targeted them tonight.
    let cursedConversionState: {
      isMine: boolean;
      acknowledged: boolean;
      convertedNames: string[];
    } | null = null;
    if (step === 'cursed_conversion') {
      const conversions = await getNightActions(
        ctx,
        args.gameId,
        game.nightNumber,
        'cursed_conversion',
      );
      if (conversions.length > 0) {
        const playerById = new Map(players.map(p => [p._id, p]));
        const convertedNames = conversions
          .map(c =>
            c.actorPlayerId ? playerById.get(c.actorPlayerId)?.name ?? null : null,
          )
          .filter((n): n is string => !!n);
        const isMine =
          me.alive &&
          me.role === 'Cursed' &&
          conversions.some(c => c.actorPlayerId === me._id);
        if (isMine || !me.alive) {
          const acks = await getNightActions(
            ctx,
            args.gameId,
            game.nightNumber,
            'cursed_conversion_ack',
          );
          const acknowledged =
            isMine && acks.some(a => a.actorPlayerId === me._id);
          cursedConversionState = { isMine, acknowledged, convertedNames };
        }
      }
    }

    // Doppelganger reveal state. Populated during the dawn / dusk steps.
    // Visible to:
    //   - the converted Doppelganger themselves (`isMine: true`, includes
    //     fromRole/toRole so the modal can say "you were X, you are now Y")
    //   - dead spectators during these steps (ghost mirror — sees the
    //     converted name + the new role, per the "ghosts get full night
    //     info" house rule)
    let doppelgangerRevealState: {
      isMine: boolean;
      fromRole?: string;
      toRole?: string;
      conversions: Array<{ name: string; toRole: string }>;
    } | null = null;
    if (step === 'doppelganger_dawn' || step === 'doppelganger_dusk') {
      const expectedPhase = step === 'doppelganger_dawn' ? 'day' : 'night';
      const convertedPlayers = players.filter(
        p =>
          p.alive &&
          p.roleState?.pendingDoppelgangerReveal?.triggerPhase ===
            expectedPhase,
      );
      if (convertedPlayers.length > 0 || !me.alive) {
        const conversions = convertedPlayers.map(p => ({
          name: p.name,
          toRole: (p.roleState?.pendingDoppelgangerReveal?.toRole ??
            p.role ??
            'Villager') as string,
        }));
        const mine = convertedPlayers.find(p => p._id === me._id);
        const isMine = !!mine;
        if (isMine || !me.alive) {
          const pending = mine?.roleState?.pendingDoppelgangerReveal;
          doppelgangerRevealState = {
            isMine,
            fromRole: pending?.fromRole,
            toRole: pending?.toRole,
            conversions,
          };
        }
      }
    }

    // Revealer-only state. No usage flag (every night, optional);
    // hasActedThisNight drives the locked waiting view.
    let revealerState: {
      hasActedThisNight: boolean;
      tonightShot: { _id: Id<'players'>; name: string } | null;
      tonightSkipped: boolean;
    } | null = null;
    const revealerActor = actorForRole('Revealer', 'revealer');
    if (revealerActor) {
      const playerById = new Map(players.map(p => [p._id, p]));
      const myActions = await ctx.db
        .query('nightActions')
        .withIndex('by_game_night', q =>
          q.eq('gameId', args.gameId).eq('nightNumber', game.nightNumber),
        )
        .collect();
      const shotAction = myActions.find(
        a =>
          a.actorPlayerId === revealerActor._id &&
          a.actionType === 'revealer_shot',
      );
      const skipAction = myActions.find(
        a =>
          a.actorPlayerId === revealerActor._id &&
          a.actionType === 'revealer_skip',
      );
      let tonightShot: { _id: Id<'players'>; name: string } | null = null;
      if (shotAction?.targetPlayerId) {
        const t = playerById.get(shotAction.targetPlayerId);
        if (t) tonightShot = { _id: t._id, name: t.name };
      }
      revealerState = {
        hasActedThisNight: !!(shotAction || skipAction),
        tonightShot,
        tonightSkipped: !!skipAction,
      };
    }

    // Huntress-only state. huntressUsed flips at morning resolution (a shot
    // is consumed even if BG blocked it). hasActedThisNight drives the locked
    // waiting view post-decision.
    let huntressState: {
      huntressUsed: boolean;
      hasActedThisNight: boolean;
      tonightShot: { _id: Id<'players'>; name: string } | null;
      tonightSkipped: boolean;
    } | null = null;
    const huntressActor = actorForRole('Huntress', 'huntress');
    if (huntressActor) {
      const playerById = new Map(players.map(p => [p._id, p]));
      const myActions = await ctx.db
        .query('nightActions')
        .withIndex('by_game_night', q =>
          q.eq('gameId', args.gameId).eq('nightNumber', game.nightNumber),
        )
        .collect();
      const shotAction = myActions.find(
        a =>
          a.actorPlayerId === huntressActor._id &&
          a.actionType === 'huntress_shot',
      );
      const skipAction = myActions.find(
        a =>
          a.actorPlayerId === huntressActor._id &&
          a.actionType === 'huntress_skip',
      );
      let tonightShot: { _id: Id<'players'>; name: string } | null = null;
      if (shotAction?.targetPlayerId) {
        const t = playerById.get(shotAction.targetPlayerId);
        if (t) tonightShot = { _id: t._id, name: t.name };
      }
      huntressState = {
        huntressUsed: !!huntressActor.roleState?.huntressUsed,
        hasActedThisNight: !!(shotAction || skipAction),
        tonightShot,
        tonightSkipped: !!skipAction,
      };
    }

    // Bodyguard-only state: which players are off-limits this night, and
    // whether we've already submitted a protect (drives the locked waiting
    // view, mirroring the Seer's post-action UX).
    let bgState: {
      selfProtectUsed: boolean;
      lastProtectedPlayerId: Id<'players'> | null;
      lastProtectedName: string | null;
      hasActedThisNight: boolean;
      tonightProtected: { _id: Id<'players'>; name: string } | null;
    } | null = null;
    const bgActor = actorForRole('Bodyguard', 'bodyguard');
    if (bgActor) {
      const lastProtected = bgActor.roleState?.bgLastProtected as
        | Id<'players'>
        | undefined;
      const playerById = new Map(players.map(p => [p._id, p]));
      const myActions = await ctx.db
        .query('nightActions')
        .withIndex('by_game_night', q =>
          q.eq('gameId', args.gameId).eq('nightNumber', game.nightNumber),
        )
        .collect();
      let tonightProtected:
        | { _id: Id<'players'>; name: string }
        | null = null;
      const protectAction = myActions.find(
        a => a.actorPlayerId === bgActor._id && a.actionType === 'bg_protect',
      );
      if (protectAction?.targetPlayerId) {
        const t = playerById.get(protectAction.targetPlayerId);
        if (t) tonightProtected = { _id: t._id, name: t.name };
      }
      bgState = {
        selfProtectUsed: !!bgActor.roleState?.bgSelfProtectUsed,
        lastProtectedPlayerId: lastProtected ?? null,
        lastProtectedName: lastProtected
          ? playerById.get(lastProtected)?.name ?? null
          : null,
        hasActedThisNight: !!protectAction,
        tonightProtected,
      };
    }

    let targetables: Array<{
      _id: Id<'players'>;
      name: string;
      seatPosition?: number;
    }> = [];
    // Ghost spectators see the same targetable pool the step's actor sees.
    const targetablesViewer: Player | undefined = isMyStep
      ? me
      : !me.alive
        ? stepActors[0]
        : undefined;
    if (targetablesViewer && step) {
      const v = targetablesViewer;
      let pool: Player[] = [];
      if (step === 'wolves') {
        // Wolves may target each other (and themselves) — see submitWolfVote
        // for the Leprechaun-signaling rationale.
        pool = alive;
      } else if (step === 'nightmare_wolf') {
        // Non-wolves only; no self. Previously-targeted players are excluded
        // here so the picker never offers an illegal pick.
        const used =
          (v.roleState?.nightmaresUsed as Id<'players'>[] | undefined) ?? [];
        const usedSet = new Set<string>(used.map(id => id as unknown as string));
        pool = alive.filter(
          p =>
            p._id !== v._id &&
            !(p.role && isWolfTeam(p.role)) &&
            !usedSet.has(p._id as unknown as string),
        );
      } else if (step === 'seer') {
        pool = alive.filter(p => p._id !== v._id);
      } else if (step === 'pi') {
        // House rules: PI can pick anyone, including themselves (the trio
        // would still include their two neighbors). Just alive.
        pool = alive;
      } else if (step === 'mentalist') {
        // Mentalist cannot read themselves and cannot pick anyone they
        // compared last night (house rule: no back-to-back targets).
        pool = mentalistValidPool(v, alive);
      } else if (step === 'witch') {
        // Poison targets — alive, non-self.
        pool = alive.filter(p => p._id !== v._id);
      } else if (step === 'bodyguard') {
        const lastProtected = v.roleState?.bgLastProtected as
          | Id<'players'>
          | undefined;
        const selfUsed = !!v.roleState?.bgSelfProtectUsed;
        pool = alive.filter(p => {
          if (lastProtected && p._id === lastProtected) return false;
          if (p._id === v._id && selfUsed) return false;
          return true;
        });
      } else if (step === 'huntress') {
        // House rule: no self-shot.
        pool = alive.filter(p => p._id !== v._id);
      } else if (step === 'revealer') {
        // House rule: no self-shot.
        pool = alive.filter(p => p._id !== v._id);
      } else if (step === 'reviler') {
        // House rule: no self-shot. Reviler is blind to roles — they may
        // pick anyone alive, and the morning resolves whether it's a hit.
        pool = alive.filter(p => p._id !== v._id);
      }
      targetables = pool
        .sort((a, b) => (a.seatPosition ?? 0) - (b.seatPosition ?? 0))
        .map(p => ({
          _id: p._id,
          name: p.name,
          seatPosition: p.seatPosition,
        }));
    }

    const aliveSummaries = alive
      .slice()
      .sort((a, b) => (a.seatPosition ?? 0) - (b.seatPosition ?? 0))
      .map(p => ({
        _id: p._id,
        name: p.name,
        seatPosition: p.seatPosition,
      }));

    // Chronological + per-actor ghost log. Walks NIGHT_STEPS up to the
    // current step and emits one card per role-holder (actor-driven steps)
    // or per event row (wolves, conversions). Alive viewers get null —
    // they see the live picker UX instead.
    let nightLog: NightLogEntry[] | null = null;
    if (!me.alive && step) {
      nightLog = await buildNightLog(
        ctx,
        args.gameId,
        game.nightNumber,
        step,
        game.selectedRoles,
        players,
      );
    }

    return {
      game: {
        _id: game._id,
        phase: game.phase,
        nightNumber: game.nightNumber,
        nightStep: step,
        playerCount: game.playerCount,
        nightStepEndsAt: game.nightStepEndsAt ?? null,
        // Wall-clock time at which the host's "skip ahead" override unlocks.
        // The client computes "now > this" locally on a 1-second tick so
        // the button surfaces without needing a server roundtrip.
        skipEligibleAt:
          game.nightStepEndsAt != null
            ? game.nightStepEndsAt + SKIP_STALL_THRESHOLD_MS
            : null,
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
      sasquatchReveal,
      seerHistory,
      piState,
      mentalistState,
      witchState,
      leprechaunState,
      bgState,
      huntressState,
      revealerState,
      revilerState,
      cursedConversionState,
      doppelgangerRevealState,
      nightmareWolfState,
      nightmaredBlocking,
      targetables,
      alivePlayers: aliveSummaries,
      nightLog,
      hostMissing: !players.some(p => p.isHost),
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
    // Morning announces every overnight death. Role identities aren't
    // surfaced — only names — so MB's mechanic stays hidden even though
    // their death is reported. (Hiding the death entirely was a worse
    // cloak: their seat empties in the day phase anyway, and in 1-wolf
    // games with no MB cascade victims it created a "no one died but a
    // seat is gone" contradiction.)
    const deaths = deathActions
      .map(a => (a.targetPlayerId ? playerById.get(a.targetPlayerId) : null))
      .filter((p): p is Player => !!p)
      .map(p => ({
        _id: p._id,
        name: p.name,
        seatPosition: p.seatPosition,
      }));
    const triggersPending = (game.pendingDeathTriggers?.length ?? 0) > 0;

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
        alive: me.alive,
      },
      deaths,
      triggersPending,
      hostMissing: !players.some(p => p.isHost),
    };
  },
});
