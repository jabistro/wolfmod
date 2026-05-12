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

const STEP_DWELL_MIN_MS = 6000;
const STEP_DWELL_MAX_MS = 12000;

// Guaranteed remaining dwell after an info-role submits, so the result modal
// stays on-screen long enough to read even if the original dwell was about to
// expire.
const INFO_READING_WINDOW_MS = 4000;

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

function activePlayersForStep(step: NightStep, alive: Player[]): Player[] {
  switch (step) {
    case 'wolves':
      return alive.filter(p => p.role && isWolfTeam(p.role));
    case 'seer':
      return alive.filter(p => p.role === 'Seer');
    case 'pi':
      // PI is one-time: once used, they're not an active actor anymore. The
      // step still dwells (cloaking) but auto-completes since actors=[].
      return alive.filter(
        p => p.role === 'Paranormal Investigator' && !p.roleState?.piUsed,
      );
    case 'mentalist':
      return alive.filter(p => p.role === 'Mentalist');
    case 'witch':
      return alive.filter(p => p.role === 'Witch');
    case 'bodyguard':
      return alive.filter(p => p.role === 'Bodyguard');
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
    case 'pi':
      return set.has('Paranormal Investigator');
    case 'mentalist':
      return set.has('Mentalist');
    case 'witch':
      return set.has('Witch');
    case 'bodyguard':
      return set.has('Bodyguard');
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
      // Defensive: if no wolves alive, the step is vacuously complete. In
      // practice this should be caught by the win-condition first.
      if (actors.length === 0) return true;
      const kills = await getNightActions(ctx, gameId, nightNumber, 'wolf_kill');
      return kills.length > 0;
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
    case 'bodyguard': {
      const protects = await getNightActions(ctx, gameId, nightNumber, 'bg_protect');
      return protects.length >= actors.length;
    }
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
    case 'bodyguard': {
      const bg = actors[0];
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
      if (!target) return;
      await ctx.db.insert('nightActions', {
        gameId,
        nightNumber,
        actorPlayerId: bg._id,
        actionType: 'bg_protect',
        targetPlayerId: target._id,
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

  // Build a set of death candidates from every kill source recorded for the
  // night, then filter through protection (BG, future: Tough Guy, etc.) and
  // commit the survivors. Each new death source plugs into the candidates
  // map; each new protection source plugs into the protected set.
  const candidates = new Map<Id<'players'>, string>();

  const kills = await getNightActions(ctx, gameId, nightNumber, 'wolf_kill');
  for (const kill of kills) {
    if (kill.targetPlayerId) candidates.set(kill.targetPlayerId, 'wolf');
  }

  const witchPoisons = await getNightActions(ctx, gameId, nightNumber, 'witch_poison');
  for (const p of witchPoisons) {
    if (p.targetPlayerId) candidates.set(p.targetPlayerId, 'poison');
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

  for (const [targetId, cause] of candidates) {
    if (protectedTargets.has(targetId)) continue;
    const target = await ctx.db.get(targetId);
    if (!target || !target.alive) continue;
    await ctx.db.patch(targetId, { alive: false });
    await ctx.db.insert('nightActions', {
      gameId,
      nightNumber,
      actorPlayerId: undefined,
      actionType: 'death',
      targetPlayerId: targetId,
      result: { cause },
      resolvedAt: now,
    });
  }

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

  if (
    (actors.length > 0 && actors.every(a => isBotName(a.name))) ||
    witchHasNothingLeft ||
    mentalistShorthanded
  ) {
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

/**
 * After an info-role action (Seer/PI/Mentalist), make sure there's still
 * enough remaining dwell for the player to read their result before the step
 * advances. Bumps `nightStepEndsAt` only if it's about to expire — most of
 * the time this is a no-op, preserving the original cloaking variance.
 *
 * When we do bump, we also schedule a fresh `dwellTick` at the new deadline.
 * The original tick will still fire at the old time, but will no-op via the
 * dwell check; the new tick is the one that ultimately advances.
 */
async function ensureReadingWindow(
  ctx: MutationCtx,
  gameId: Id<'games'>,
  step: NightStep,
): Promise<void> {
  const game = await ctx.db.get(gameId);
  if (!game || game.phase !== 'night' || game.nightStep !== step) return;
  const minEndsAt = Date.now() + INFO_READING_WINDOW_MS;
  if ((game.nightStepEndsAt ?? 0) >= minEndsAt) return;
  await ctx.db.patch(gameId, { nightStepEndsAt: minEndsAt });
  await ctx.scheduler.runAfter(INFO_READING_WINDOW_MS, internal.night.dwellTick, {
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

    // pi_skip completes the PI's step contribution → try to advance now in
    // case the dwell deadline has already passed.
    await maybeAdvance(ctx, args.gameId);
  },
});

// ───── Mentalist ────────────────────────────────────────────────────────────
//
// Each night, picks two players. Server compares teamForRole(first) to
// teamForRole(second) and returns 'same' or 'different'. Wolf-team grouping
// includes Werewolf, Wolf Man, Hunter Wolf, AND Minion (different from the
// Seer's "true wolves only" wolf detection); Reviler is its own solo team.

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

    const sameTeam =
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

    // Try to advance — if the dwell deadline already passed (slow decider),
    // the scheduled `dwellTick` has already fired and won't fire again, so we
    // need this trigger. If dwell is still active, this is a no-op.
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

    // Save target = the wolf's chosen victim for tonight.
    const kills = await getNightActions(
      ctx,
      args.gameId,
      game.nightNumber,
      'wolf_kill',
    );
    const victimId = kills[0]?.targetPlayerId;
    if (!victimId) throw new Error('No victim to save tonight.');

    await ctx.db.insert('nightActions', {
      gameId: args.gameId,
      nightNumber: game.nightNumber,
      actorPlayerId: me._id,
      actionType: 'witch_save',
      targetPlayerId: victimId,
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

    // Same pattern as BG: covers the slow-decider case where the scheduled
    // `dwellTick` already fired before the player finished.
    await maybeAdvance(ctx, args.gameId);
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
  wolves: ['wolf_kill'],
  seer: ['seer_check'],
  pi: ['pi_check', 'pi_skip'],
  mentalist: ['mentalist_check'],
  witch: ['witch_save', 'witch_poison', 'witch_done'],
  bodyguard: ['bg_protect'],
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
    for (const a of actions) {
      if (types.has(a.actionType)) {
        await ctx.db.delete(a._id);
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
    const actors = activePlayersForStep(step, alive);
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
    if (
      (actors.length > 0 && actors.every(a => isBotName(a.name))) ||
      witchHasNothingLeft ||
      mentalistShorthanded
    ) {
      await autoResolveStep(ctx, args.gameId, step, actors, alive, game.nightNumber);
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
    if (me.role === 'Paranormal Investigator') {
      const playerById = new Map(players.map(p => [p._id, p]));
      const allActions = await ctx.db
        .query('nightActions')
        .withIndex('by_game_night', q => q.eq('gameId', args.gameId))
        .collect();
      const myCheckHistory = allActions
        .filter(
          a => a.actorPlayerId === me._id && a.actionType === 'pi_check',
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
          a.actorPlayerId === me._id &&
          a.nightNumber === game.nightNumber &&
          (a.actionType === 'pi_check' || a.actionType === 'pi_skip'),
      );
      piState = {
        piUsed: !!me.roleState?.piUsed,
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
    if (me.role === 'Mentalist') {
      const playerById = new Map(players.map(p => [p._id, p]));
      const allActions = await ctx.db
        .query('nightActions')
        .withIndex('by_game_night', q => q.eq('gameId', args.gameId))
        .collect();
      const myChecks = allActions
        .filter(
          a =>
            a.actorPlayerId === me._id && a.actionType === 'mentalist_check',
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
      const lastTargets = (me.roleState?.mentalistLastTargets ??
        []) as Id<'players'>[];
      const lockedTargets = lastTargets
        .map(id => playerById.get(id))
        .filter((p): p is Player => !!p)
        .map(p => ({ _id: p._id, name: p.name }));
      const hasActedThisNight = allActions.some(
        a =>
          a.actorPlayerId === me._id &&
          a.nightNumber === game.nightNumber &&
          (a.actionType === 'mentalist_check' ||
            a.actionType === 'mentalist_skip'),
      );
      const noValidTargets = mentalistValidPool(me, alive).length < 2;
      mentalistState = {
        hasActedThisNight,
        noValidTargets,
        lockedTargets,
        history,
      };
    }

    // Witch-only state. Tonight's victim is hidden once save has been used
    // (per house rules — after using save, witch no longer sees the wolf
    // victim). savedTonight/poisonedTonight track in-progress decisions so
    // the picker can hide each button independently.
    let witchState: {
      saveUsed: boolean;
      poisonUsed: boolean;
      savedTonight: boolean;
      poisonedTonight: boolean;
      hasActedThisNight: boolean;
      tonightVictim: { _id: Id<'players'>; name: string } | null;
    } | null = null;
    if (me.role === 'Witch') {
      const playerById = new Map(players.map(p => [p._id, p]));
      const saveUsed = !!me.roleState?.witchSaveUsed;
      const poisonUsed = !!me.roleState?.witchPoisonUsed;
      const myActions = await ctx.db
        .query('nightActions')
        .withIndex('by_game_night', q =>
          q.eq('gameId', args.gameId).eq('nightNumber', game.nightNumber),
        )
        .collect();
      const savedTonight = myActions.some(
        a => a.actorPlayerId === me._id && a.actionType === 'witch_save',
      );
      const poisonedTonight = myActions.some(
        a => a.actorPlayerId === me._id && a.actionType === 'witch_poison',
      );
      const hasActedThisNight = myActions.some(
        a => a.actorPlayerId === me._id && a.actionType === 'witch_done',
      );
      let tonightVictim: { _id: Id<'players'>; name: string } | null = null;
      if (!saveUsed) {
        const kills = myActions.filter(a => a.actionType === 'wolf_kill');
        const victimId = kills[0]?.targetPlayerId;
        if (victimId) {
          const victim = playerById.get(victimId);
          if (victim) tonightVictim = { _id: victim._id, name: victim.name };
        }
      }
      witchState = {
        saveUsed,
        poisonUsed,
        savedTonight,
        poisonedTonight,
        hasActedThisNight,
        tonightVictim,
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
    } | null = null;
    if (me.role === 'Bodyguard') {
      const lastProtected = me.roleState?.bgLastProtected as
        | Id<'players'>
        | undefined;
      const playerById = new Map(players.map(p => [p._id, p]));
      const myActions = await ctx.db
        .query('nightActions')
        .withIndex('by_game_night', q =>
          q.eq('gameId', args.gameId).eq('nightNumber', game.nightNumber),
        )
        .collect();
      bgState = {
        selfProtectUsed: !!me.roleState?.bgSelfProtectUsed,
        lastProtectedPlayerId: lastProtected ?? null,
        lastProtectedName: lastProtected
          ? playerById.get(lastProtected)?.name ?? null
          : null,
        hasActedThisNight: myActions.some(
          a => a.actorPlayerId === me._id && a.actionType === 'bg_protect',
        ),
      };
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
      } else if (step === 'pi') {
        // House rules: PI can pick anyone, including themselves (the trio
        // would still include their two neighbors). Just alive.
        pool = alive;
      } else if (step === 'mentalist') {
        // Mentalist cannot read themselves and cannot pick anyone they
        // compared last night (house rule: no back-to-back targets).
        pool = mentalistValidPool(me, alive);
      } else if (step === 'witch') {
        // Poison targets — alive, non-self.
        pool = alive.filter(p => p._id !== me._id);
      } else if (step === 'bodyguard') {
        const lastProtected = me.roleState?.bgLastProtected as
          | Id<'players'>
          | undefined;
        const selfUsed = !!me.roleState?.bgSelfProtectUsed;
        pool = alive.filter(p => {
          if (lastProtected && p._id === lastProtected) return false;
          if (p._id === me._id && selfUsed) return false;
          return true;
        });
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
      seerHistory,
      piState,
      mentalistState,
      witchState,
      bgState,
      targetables,
      alivePlayers: aliveSummaries,
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
