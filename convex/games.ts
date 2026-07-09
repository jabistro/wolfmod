import { mutation, query, type MutationCtx } from './_generated/server';
import { v, ConvexError } from 'convex/values';
import type { Id } from './_generated/dataModel';
import {
  isWolfTeam,
  teamForRole,
  SINGLETON_ROLES,
  incompatibleRolesInBuild,
} from '../src/data/v1Roles';
import {
  findCaller,
  requireHost,
  isBotName,
  isHostMissing,
  initializeDayClock,
  DAY_CONFIG_DEFAULTS,
} from './helpers';

const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I, O
const ROOM_CODE_LENGTH = 4;
const MIN_PLAYERS = 3;
const MAX_PLAYERS = 40;

/**
 * Roles whose nighttime ability is *blockable* by a Nightmare Wolf — kept in
 * sync with NIGHTMARE_BLOCKABLE_STEPS in convex/night.ts. Used by the
 * end-game history builder to decide whether a nightmared target's row
 * should display the "NIGHTMARED" badge: passive roles (Tough Guy, Diseased,
 * Villager, etc.) had nothing to block, so the badge would be misleading.
 */
const NIGHTMARE_BLOCKABLE_ROLES = new Set<string>([
  'Seer',
  'Paranormal Investigator',
  'Mentalist',
  'Witch',
  'Leprechaun',
  'Bodyguard',
  'Huntress',
  'Revealer',
  'Reviler',
]);

function shuffle<T>(items: readonly T[]): T[] {
  const result = items.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function generateRoomCode(): string {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
  }
  return code;
}

async function allocateRoomCode(ctx: MutationCtx): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const candidate = generateRoomCode();
    const existing = await ctx.db
      .query('games')
      .withIndex('by_room_code', q => q.eq('roomCode', candidate))
      .first();
    if (!existing) return candidate;
  }
  throw new Error('Could not allocate a unique room code. Try again.');
}

export const createGame = mutation({
  args: {
    playerCount: v.number(),
    hostName: v.string(),
    deviceClientId: v.string(),
    // 'local' (in-room, default) or 'remote' (players apart, in-app chat).
    // Chosen on the Play menu; falls back to 'local' if omitted.
    mode: v.optional(v.union(v.literal('local'), v.literal('remote'))),
    // Per-host timer defaults, persisted locally on the host's device and passed
    // in at create time. Omitted fields fall back to DAY_CONFIG_DEFAULTS via
    // dayConfigOf, so this is purely a seed — the host can still retune in-game.
    dayDurationSec: v.optional(v.number()),
    accusationSec: v.optional(v.number()),
    defenseSec: v.optional(v.number()),
    voteTimerSec: v.optional(v.number()),
    preVoteSec: v.optional(v.number()),
    maxNominationsPerDay: v.optional(v.number()),
    wolfPickerSec: v.optional(v.number()),
    nightActionSec: v.optional(v.number()),
    // "Role reveal" variant, seeded from the host's local prefs. Snapshotted
    // onto the game doc so every remote phone shares one value for the game.
    revealOnLynch: v.optional(v.boolean()),
    revealOnNightDeath: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    if (args.playerCount < MIN_PLAYERS || args.playerCount > MAX_PLAYERS) {
      throw new Error(`Player count must be ${MIN_PLAYERS}-${MAX_PLAYERS}.`);
    }
    const trimmedName = args.hostName.trim();
    if (!trimmedName) throw new Error('Name is required.');

    const roomCode = await allocateRoomCode(ctx);
    const now = Date.now();

    // Only persist timer fields the client actually sent; let dayConfigOf supply
    // defaults for the rest. Clamp to the same floors setDayConfig enforces.
    const timerSeed: Record<string, number> = {};
    if (args.dayDurationSec !== undefined)
      timerSeed.dayDurationSec = Math.max(30, args.dayDurationSec);
    if (args.accusationSec !== undefined)
      timerSeed.accusationSec = Math.max(5, args.accusationSec);
    if (args.defenseSec !== undefined)
      timerSeed.defenseSec = Math.max(5, args.defenseSec);
    if (args.voteTimerSec !== undefined)
      timerSeed.voteTimerSec = Math.max(1, args.voteTimerSec);
    if (args.preVoteSec !== undefined)
      timerSeed.preVoteSec = Math.max(5, args.preVoteSec);
    if (args.maxNominationsPerDay !== undefined)
      timerSeed.maxNominationsPerDay = Math.max(1, args.maxNominationsPerDay);
    if (args.wolfPickerSec !== undefined)
      timerSeed.wolfPickerSec = Math.min(180, Math.max(10, args.wolfPickerSec));
    if (args.nightActionSec !== undefined)
      timerSeed.nightActionSec = Math.min(180, Math.max(10, args.nightActionSec));

    const gameId = await ctx.db.insert('games', {
      roomCode,
      mode: args.mode ?? 'local',
      playerCount: args.playerCount,
      phase: 'lobby',
      nightNumber: 0,
      dayNumber: 0,
      selectedRoles: [],
      createdAt: now,
      revealOnLynch: args.revealOnLynch ?? false,
      revealOnNightDeath: args.revealOnNightDeath ?? false,
      ...timerSeed,
    });

    const playerId = await ctx.db.insert('players', {
      gameId,
      name: trimmedName,
      alive: true,
      isHost: true,
      deviceClientId: args.deviceClientId,
      joinedAt: now,
    });

    return { gameId, roomCode, playerId };
  },
});

export const joinGame = mutation({
  args: {
    roomCode: v.string(),
    name: v.string(),
    deviceClientId: v.string(),
  },
  handler: async (ctx, args) => {
    const code = args.roomCode.toUpperCase().trim();
    const game = await ctx.db
      .query('games')
      .withIndex('by_room_code', q => q.eq('roomCode', code))
      .first();
    if (!game)
      throw new ConvexError("No game with that code. Double-check it with the host.");

    // Rejoin path 1 — same device already has a player record in this game.
    // This works in any phase: pre-start (re-open the app) AND mid-game
    // (player closed the app or hit back, comes back to keep playing).
    const sameDevice = await ctx.db
      .query('players')
      .withIndex('by_game_device', q =>
        q.eq('gameId', game._id).eq('deviceClientId', args.deviceClientId),
      )
      .first();
    if (sameDevice) {
      return { gameId: game._id, playerId: sameDevice._id, rejoined: true };
    }

    const trimmedName = args.name.trim();
    if (!trimmedName) throw new ConvexError('Name is required.');

    // Rejoin path 2 — different device (broken phone / reinstall). Match by
    // name on the active player roster: if there's an existing player with
    // this name and the device id slot is now stale, claim it by swapping in
    // the new deviceClientId. Names are unique per-game so this is unambig.
    // Friend-group trust model: knowing the room code + the player's name
    // is enough to reclaim the seat.
    if (game.phase !== 'lobby') {
      const players = await ctx.db
        .query('players')
        .withIndex('by_game', q => q.eq('gameId', game._id))
        .collect();
      const byName = players.find(
        p => p.name.toLowerCase() === trimmedName.toLowerCase(),
      );
      if (byName) {
        await ctx.db.patch(byName._id, { deviceClientId: args.deviceClientId });
        return { gameId: game._id, playerId: byName._id, rejoined: true };
      }
      throw new ConvexError(
        "Game has already started — type the same name you used to rejoin.",
      );
    }

    const players = await ctx.db
      .query('players')
      .withIndex('by_game', q => q.eq('gameId', game._id))
      .collect();
    if (players.length >= game.playerCount) {
      throw new ConvexError('Game is full.');
    }
    if (players.some(p => p.name.toLowerCase() === trimmedName.toLowerCase())) {
      throw new ConvexError('Name already taken in this game.');
    }

    const now = Date.now();
    const playerId = await ctx.db.insert('players', {
      gameId: game._id,
      name: trimmedName,
      alive: true,
      isHost: false,
      deviceClientId: args.deviceClientId,
      joinedAt: now,
    });

    return { gameId: game._id, playerId, rejoined: false };
  },
});

export const assignPlayerToSeat = mutation({
  args: {
    gameId: v.id('games'),
    playerId: v.id('players'),
    seatPosition: v.number(),
    callerDeviceClientId: v.string(),
  },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game) throw new Error('Game not found.');
    if (game.phase !== 'lobby') throw new Error('Seats are locked once the game has started.');

    await requireHost(ctx, args.gameId, args.callerDeviceClientId);

    if (args.seatPosition < 0 || args.seatPosition >= game.playerCount) {
      throw new Error('Invalid seat position.');
    }

    const target = await ctx.db.get(args.playerId);
    if (!target || target.gameId !== args.gameId) {
      throw new Error('Player not in this game.');
    }

    const allPlayers = await ctx.db
      .query('players')
      .withIndex('by_game', q => q.eq('gameId', args.gameId))
      .collect();
    const existingOccupant = allPlayers.find(
      p => p.seatPosition === args.seatPosition && p._id !== args.playerId,
    );
    if (existingOccupant) {
      await ctx.db.patch(existingOccupant._id, { seatPosition: undefined });
    }

    await ctx.db.patch(args.playerId, { seatPosition: args.seatPosition });
  },
});

export const removePlayerFromSeat = mutation({
  args: {
    gameId: v.id('games'),
    playerId: v.id('players'),
    callerDeviceClientId: v.string(),
  },
  handler: async (ctx, args) => {
    await requireHost(ctx, args.gameId, args.callerDeviceClientId);
    await ctx.db.patch(args.playerId, { seatPosition: undefined });
  },
});

export const removePlayerFromGame = mutation({
  args: {
    gameId: v.id('games'),
    playerId: v.id('players'),
    callerDeviceClientId: v.string(),
  },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game) throw new Error('Game not found.');
    if (game.phase !== 'lobby') {
      throw new Error('Players can only be removed from the lobby.');
    }
    await requireHost(ctx, args.gameId, args.callerDeviceClientId);

    const target = await ctx.db.get(args.playerId);
    if (!target || target.gameId !== args.gameId) {
      throw new Error('Player not in this game.');
    }
    if (target.isHost) {
      throw new Error("Host can't be removed — use Leave to end the game.");
    }

    // Just delete the player, leaving their seat empty. The table keeps its
    // size (playerCount untouched), so the host can seat someone else there
    // or lower the count deliberately with setPlayerCount. Remaining players
    // keep their exact seat positions — no compaction, no fall-off, because
    // the ring still renders the same number of seats.
    await ctx.db.delete(args.playerId);
  },
});

export const clearAllSeats = mutation({
  args: {
    gameId: v.id('games'),
    callerDeviceClientId: v.string(),
  },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game) throw new Error('Game not found.');
    if (game.phase !== 'lobby') {
      throw new Error('Seats are locked once the game has started.');
    }
    await requireHost(ctx, args.gameId, args.callerDeviceClientId);

    const players = await ctx.db
      .query('players')
      .withIndex('by_game', q => q.eq('gameId', args.gameId))
      .collect();
    for (const p of players) {
      if (p.seatPosition !== undefined) {
        await ctx.db.patch(p._id, { seatPosition: undefined });
      }
    }
  },
});

export const setPlayerCount = mutation({
  args: {
    gameId: v.id('games'),
    playerCount: v.number(),
    callerDeviceClientId: v.string(),
  },
  handler: async (ctx, args) => {
    if (args.playerCount < MIN_PLAYERS || args.playerCount > MAX_PLAYERS) {
      throw new Error(`Player count must be ${MIN_PLAYERS}-${MAX_PLAYERS}.`);
    }
    const game = await ctx.db.get(args.gameId);
    if (!game) throw new Error('Game not found.');
    if (game.phase !== 'lobby') {
      throw new Error('Player count is locked once the game has started.');
    }
    await requireHost(ctx, args.gameId, args.callerDeviceClientId);

    const players = await ctx.db
      .query('players')
      .withIndex('by_game', q => q.eq('gameId', args.gameId))
      .collect();

    // The host can shrink the table at any time, even below the number of
    // joined players — the lobby surfaces the mismatch ("5 / 4 JOINED") and
    // Start stays gated until it resolves. Shrinking the table: any seat
    // index outside the new range no longer exists, so unseat its occupant.
    // The host re-seats or removes them afterwards.
    for (const p of players) {
      if (
        typeof p.seatPosition === 'number' &&
        p.seatPosition >= args.playerCount
      ) {
        await ctx.db.patch(p._id, { seatPosition: undefined });
      }
    }

    // Don't touch selectedRoles either way — Start is gated on
    // selectedRoles.length === playerCount, and the lobby UI shows
    // "TOO MANY ROLES" / "MORE ROLES NEEDED" so the host can adjust
    // whichever side reads more naturally.
    await ctx.db.patch(args.gameId, { playerCount: args.playerCount });
  },
});

export const setRoles = mutation({
  args: {
    gameId: v.id('games'),
    roles: v.array(v.string()),
    callerDeviceClientId: v.string(),
  },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game) throw new Error('Game not found.');
    if (game.phase !== 'lobby') throw new Error('Roles are locked once the game has started.');

    await requireHost(ctx, args.gameId, args.callerDeviceClientId);

    const counts = new Map<string, number>();
    for (const r of args.roles) counts.set(r, (counts.get(r) ?? 0) + 1);
    for (const r of SINGLETON_ROLES) {
      if ((counts.get(r) ?? 0) > 1) {
        throw new Error(`Only one ${r} is allowed per game.`);
      }
    }
    // Hard-excluded role pairs (e.g. Alpha Wolf + Witch/Leprechaun). The
    // lobby UI blocks adding these together, but guard here as the backstop.
    const presentRoles = new Set(args.roles);
    for (const r of presentRoles) {
      const conflicts = incompatibleRolesInBuild(r, presentRoles);
      if (conflicts.length > 0) {
        throw new Error(
          `${r} can't be in the same game as ${conflicts.join(' or ')}.`,
        );
      }
    }

    // If the host changed the build out from under existing dev pins, prune
    // any pin whose role no longer has a slot in the new build (respecting
    // multiplicity). Pins for roles still present are preserved.
    const patch: { selectedRoles: string[]; devRoleAssignments?: Array<{ seatPosition: number; role: string }> } = {
      selectedRoles: args.roles,
    };
    if (game.devRoleAssignments && game.devRoleAssignments.length > 0) {
      const budget = new Map(counts);
      const kept: Array<{ seatPosition: number; role: string }> = [];
      for (const pin of game.devRoleAssignments) {
        const left = budget.get(pin.role) ?? 0;
        if (left > 0) {
          budget.set(pin.role, left - 1);
          kept.push(pin);
        }
      }
      if (kept.length !== game.devRoleAssignments.length) {
        patch.devRoleAssignments = kept;
      }
    }

    await ctx.db.patch(args.gameId, patch);
  },
});

/**
 * Dev-only: pin specific seats to specific roles before `startGame`. The
 * caller sends the full desired set of pins (replace semantics, not patch);
 * to clear, send `[]`. Validates host + lobby phase, unique seat positions
 * in range, and that the multiset of pinned roles is a subset of the
 * current `selectedRoles`. The button calling this is gated client-side by
 * `__DEV__ || EXPO_PUBLIC_ALLOW_BOTS`.
 */
export const setDevRoleAssignments = mutation({
  args: {
    gameId: v.id('games'),
    assignments: v.array(
      v.object({
        seatPosition: v.number(),
        role: v.string(),
      }),
    ),
    callerDeviceClientId: v.string(),
  },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game) throw new Error('Game not found.');
    if (game.phase !== 'lobby') {
      throw new Error('Pins are locked once the game has started.');
    }
    await requireHost(ctx, args.gameId, args.callerDeviceClientId);

    const seenSeats = new Set<number>();
    for (const a of args.assignments) {
      if (
        !Number.isInteger(a.seatPosition) ||
        a.seatPosition < 0 ||
        a.seatPosition >= game.playerCount
      ) {
        throw new Error(`Seat ${a.seatPosition} is out of range.`);
      }
      if (seenSeats.has(a.seatPosition)) {
        throw new Error(`Seat ${a.seatPosition + 1} pinned twice.`);
      }
      seenSeats.add(a.seatPosition);
    }

    const budget = new Map<string, number>();
    for (const r of game.selectedRoles) budget.set(r, (budget.get(r) ?? 0) + 1);
    for (const a of args.assignments) {
      const left = budget.get(a.role) ?? 0;
      if (left <= 0) {
        throw new Error(
          `Pinned roles exceed the build: not enough ${a.role} in the selected roles.`,
        );
      }
      budget.set(a.role, left - 1);
    }

    await ctx.db.patch(args.gameId, { devRoleAssignments: args.assignments });
  },
});

export const leaveGame = mutation({
  args: {
    gameId: v.id('games'),
    callerDeviceClientId: v.string(),
  },
  handler: async (ctx, args) => {
    const caller = await findCaller(ctx, args.gameId, args.callerDeviceClientId);
    if (!caller) return;

    const game = await ctx.db.get(args.gameId);
    if (!game) {
      await ctx.db.delete(caller._id);
      return;
    }

    // Host leaving the lobby tears the whole game down — pre-start there's no
    // meaningful play to preserve.
    if (caller.isHost && game.phase === 'lobby') {
      const allPlayers = await ctx.db
        .query('players')
        .withIndex('by_game', q => q.eq('gameId', args.gameId))
        .collect();
      for (const p of allPlayers) {
        await ctx.db.delete(p._id);
      }
      await ctx.db.delete(args.gameId);
      return;
    }

    if (game.phase === 'lobby') {
      await ctx.db.delete(caller._id);
      return;
    }

    // Mid-game leave: keep the player record intact so they can rejoin via
    // Join Game (device match or name fallback). The host case demotes
    // isHost so other phones can detect the orphaned host slot and show
    // a CLAIM HOST banner.
    if (caller.isHost) {
      await ctx.db.patch(caller._id, { isHost: false });
    }
  },
});

export const startGame = mutation({
  args: {
    gameId: v.id('games'),
    callerDeviceClientId: v.string(),
  },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game) throw new Error('Game not found.');
    if (game.phase !== 'lobby') throw new Error('Game already started.');

    await requireHost(ctx, args.gameId, args.callerDeviceClientId);

    const players = await ctx.db
      .query('players')
      .withIndex('by_game', q => q.eq('gameId', args.gameId))
      .collect();

    if (players.length !== game.playerCount) {
      throw new Error(`Need ${game.playerCount} players, have ${players.length}.`);
    }
    if (players.some(p => p.seatPosition === undefined)) {
      throw new Error('All players must be seated before starting.');
    }
    // A Drunk build carries one extra role beyond the seat count — the
    // "+1" is set aside as the Drunk's hidden future role (revealed on N3).
    const hasDrunk = game.selectedRoles.includes('Drunk');
    const expectedRoleCount = game.playerCount + (hasDrunk ? 1 : 0);
    if (game.selectedRoles.length !== expectedRoleCount) {
      throw new Error(
        `Need ${expectedRoleCount} roles selected${
          hasDrunk ? ' (the Drunk adds one set-aside role)' : ''
        }, have ${game.selectedRoles.length}.`,
      );
    }
    // Pre-game parity guard. Starting wolves at or above half the table means
    // the wolves win on N1 before the first kill — block instead of letting
    // the host start a game that's already over. Counts every wolf in the
    // build (conservative: a wolf set aside as the Drunk's future role won't
    // actually be in play on N1, so this can only over-count, never under).
    const wolfCount = game.selectedRoles.filter(isWolfTeam).length;
    if (wolfCount * 2 >= game.playerCount) {
      throw new Error(
        `Too many wolves (${wolfCount} of ${game.playerCount}) — wolves must be less than half the table.`,
      );
    }

    // Build the final seat→role map. Dev pins (if any) land first; the
    // remaining roles are shuffled into the unpinned seats. With no pins
    // this collapses to the pure shuffle.
    const pins = game.devRoleAssignments ?? [];
    const seatToRole: Record<number, string> = {};
    const remaining = game.selectedRoles.slice();
    for (const pin of pins) {
      // Validate again at start time — selectedRoles could have changed
      // since the pin was saved (setRoles prunes, but a race is possible).
      const idx = remaining.indexOf(pin.role);
      if (idx === -1) {
        throw new Error(
          `Dev pin no longer fits the build: ${pin.role} is not in selected roles. Clear or re-pin.`,
        );
      }
      remaining.splice(idx, 1);
      seatToRole[pin.seatPosition] = pin.role;
    }

    // Pick the Drunk's set-aside future role from the unpinned remainder.
    // Preference, strictest first: never the Drunk itself (it must be dealt
    // to a seat, never the odd card out); avoid setup-only roles the Drunk
    // could never use if inherited late (Doppelganger/Mama Wolf — their power
    // is a pregame action); never set aside the last wolf (0 wolves in play
    // would hand the village an instant N1 win). Each tier relaxes a rule so
    // a pick is always found unless dev pins stranded the Drunk.
    let drunkDelayedRole: string | undefined;
    if (hasDrunk) {
      const SETUP_ONLY = new Set(['Doppelganger', 'Mama Wolf']);
      const wolvesInRemaining = remaining.filter(isWolfTeam).length;
      const notLastWolf = (r: string) =>
        !(isWolfTeam(r) && wolvesInRemaining <= 1);
      const tiers: Array<(r: string) => boolean> = [
        r => r !== 'Drunk' && !SETUP_ONLY.has(r) && notLastWolf(r),
        r => r !== 'Drunk' && notLastWolf(r),
        r => r !== 'Drunk',
      ];
      let pickIdx = -1;
      for (const ok of tiers) {
        const candidates = remaining
          .map((r, i) => ({ r, i }))
          .filter(({ r }) => ok(r));
        if (candidates.length > 0) {
          pickIdx =
            candidates[Math.floor(Math.random() * candidates.length)].i;
          break;
        }
      }
      if (pickIdx === -1) {
        throw new Error(
          'Cannot set aside the Drunk’s hidden role — every other role is pinned to a seat. Free up a pin.',
        );
      }
      drunkDelayedRole = remaining.splice(pickIdx, 1)[0];
    }

    const shuffled = shuffle(remaining);
    let nextLeftover = 0;
    for (let seat = 0; seat < game.playerCount; seat++) {
      if (seatToRole[seat] === undefined) {
        seatToRole[seat] = shuffled[nextLeftover++];
      }
    }

    const now = Date.now();
    let botDoppelgangerId: Id<'players'> | null = null;
    const botMamaWolfIds: Id<'players'>[] = [];
    const seatOrder: Id<'players'>[] = [];
    const roleById = new Map<Id<'players'>, string>();
    for (const player of players) {
      const seat = player.seatPosition;
      if (typeof seat !== 'number') continue;
      const role = seatToRole[seat];
      const patch: {
        role: string;
        originalRole: string;
        revealedAt?: number;
        drunkDelayedRole?: string;
      } = { role, originalRole: role };
      // Stash the set-aside role on whoever drew the Drunk; the N3 sober-up
      // (applyDrunkSoberUp) patches `role` to this then. Bots need no pregame
      // action — the Drunk has none until it sobers.
      if (role === 'Drunk' && drunkDelayedRole) {
        patch.drunkDelayedRole = drunkDelayedRole;
      }
      if (isBotName(player.name)) {
        patch.revealedAt = now;
        if (role === 'Doppelganger') botDoppelgangerId = player._id;
        if (role === 'Mama Wolf') botMamaWolfIds.push(player._id);
      }
      await ctx.db.patch(player._id, patch);
      seatOrder.push(player._id);
      roleById.set(player._id, role);
    }

    // If a bot ended up as the Doppelganger, auto-pick a random non-self
    // target so the conversion still has somewhere to land during testing.
    if (botDoppelgangerId) {
      const candidates = seatOrder.filter(id => id !== botDoppelgangerId);
      if (candidates.length > 0) {
        const pick = candidates[Math.floor(Math.random() * candidates.length)];
        await ctx.db.patch(botDoppelgangerId, { doppelgangerTarget: pick });
      }
    }

    // Bot Mama Wolves auto-mark a random non-wolf so testing doesn't hang on
    // the host's BEGIN DAY 1 gate. Mirrors `confirmMamaWolfTarget`: stamp the
    // target's Seer-fooling flag + a pregame history row.
    for (const mamaId of botMamaWolfIds) {
      const candidates = seatOrder.filter(
        id => id !== mamaId && !isWolfTeam(roleById.get(id) ?? ''),
      );
      if (candidates.length === 0) continue;
      const pick = candidates[Math.floor(Math.random() * candidates.length)];
      await ctx.db.patch(mamaId, { mamaWolfTarget: pick });
      await ctx.db.patch(pick, { seerAppearsAsWolf: true });
      await ctx.db.insert('nightActions', {
        gameId: args.gameId,
        nightNumber: 0,
        actorPlayerId: mamaId,
        actionType: 'mama_wolf_mark',
        targetPlayerId: pick,
        resolvedAt: now,
      });
    }

    // Wipe pre-game lobby chatter so it doesn't clutter the in-game village
    // log. Batched delete (Convex mutations have read/write limits); lobby
    // message counts are tiny, but loop defensively.
    for (;;) {
      const batch = await ctx.db
        .query('messages')
        .withIndex('by_game_channel', q => q.eq('gameId', args.gameId))
        .take(100);
      if (batch.length === 0) break;
      for (const m of batch) await ctx.db.delete(m._id);
      if (batch.length < 100) break;
    }

    // Arm the Alpha Wolf's one-time conversion lifecycle when one is in the
    // build. 'unused' until another wolf dies (see flagAlphaConvertIfApplicable).
    const alphaConvertInit = game.selectedRoles.includes('Alpha Wolf')
      ? ('unused' as const)
      : undefined;
    await ctx.db.patch(args.gameId, {
      phase: 'reveal',
      ...(alphaConvertInit ? { alphaConvert: alphaConvertInit } : {}),
    });
  },
});

export const confirmRoleReveal = mutation({
  args: {
    gameId: v.id('games'),
    callerDeviceClientId: v.string(),
  },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game) throw new Error('Game not found.');
    if (game.phase !== 'reveal') throw new Error('Not in reveal phase.');

    const me = await findCaller(ctx, args.gameId, args.callerDeviceClientId);
    if (!me) throw new Error('You are not in this game.');
    if (me.revealedAt !== undefined) return;

    // Doppelganger must pick their target before they're counted ready —
    // the client routes them through the seat picker, which calls
    // `confirmDoppelgangerTarget` instead. This guard is the defensive
    // backstop in case the picker is bypassed.
    if (me.role === 'Doppelganger' && me.doppelgangerTarget === undefined) {
      throw new Error('Pick your Doppelganger target before confirming.');
    }
    // Same gate for Mama Wolf — she must mark her Lycan before being ready.
    // The client routes her through the picker (`confirmMamaWolfTarget`).
    if (me.role === 'Mama Wolf' && me.mamaWolfTarget === undefined) {
      throw new Error('Mark a player as a Lycan before confirming.');
    }

    await ctx.db.patch(me._id, { revealedAt: Date.now() });

    // Local games host-gate the reveal → day transition (the host taps BEGIN
    // DAY 1 once everyone's phone is face-down). Remote games have no such
    // concern, so the moment the last player acks, Day 1 auto-starts.
    if ((game.mode ?? 'local') === 'remote') {
      const players = await ctx.db
        .query('players')
        .withIndex('by_game', q => q.eq('gameId', args.gameId))
        .collect();
      const allReady = players.every(p =>
        p._id === me._id ? true : p.revealedAt !== undefined,
      );
      if (allReady) {
        await startDayOne(ctx, args.gameId);
      }
    }
  },
});

/**
 * Doppelganger seat-picker submission. Atomically records the target and
 * marks the Doppelganger ready, so the host's "X of Y ready" counter only
 * ticks up once the pick is in.
 */
export const confirmDoppelgangerTarget = mutation({
  args: {
    gameId: v.id('games'),
    targetPlayerId: v.id('players'),
    callerDeviceClientId: v.string(),
  },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game) throw new Error('Game not found.');
    if (game.phase !== 'reveal') throw new Error('Not in reveal phase.');

    const me = await findCaller(ctx, args.gameId, args.callerDeviceClientId);
    if (!me) throw new Error('You are not in this game.');
    if (me.role !== 'Doppelganger') {
      throw new Error('Only the Doppelganger picks a target here.');
    }
    if (me.revealedAt !== undefined) return;

    const target = await ctx.db.get(args.targetPlayerId);
    if (!target || target.gameId !== args.gameId) {
      throw new Error('Invalid target.');
    }
    if (target._id === me._id) {
      throw new Error("You can't pick yourself.");
    }

    await ctx.db.patch(me._id, {
      doppelgangerTarget: args.targetPlayerId,
      revealedAt: Date.now(),
    });
  },
});

/**
 * Mama Wolf seat-picker submission. Atomically marks her Lycan, flags the
 * target so the Seer reads them as a wolf, and marks Mama Wolf ready (so the
 * host's "X of Y ready" counter only ticks once the mark is in). She may not
 * mark herself or any actual wolf — they already read as wolves. The target
 * is never told and their real role is untouched. Records a pregame
 * `mama_wolf_mark` history row (nightNumber 0) for end-game review.
 */
export const confirmMamaWolfTarget = mutation({
  args: {
    gameId: v.id('games'),
    targetPlayerId: v.id('players'),
    callerDeviceClientId: v.string(),
  },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game) throw new Error('Game not found.');
    if (game.phase !== 'reveal') throw new Error('Not in reveal phase.');

    const me = await findCaller(ctx, args.gameId, args.callerDeviceClientId);
    if (!me) throw new Error('You are not in this game.');
    if (me.role !== 'Mama Wolf') {
      throw new Error('Only Mama Wolf marks a Lycan here.');
    }
    if (me.revealedAt !== undefined) return;

    const target = await ctx.db.get(args.targetPlayerId);
    if (!target || target.gameId !== args.gameId) {
      throw new Error('Invalid target.');
    }
    if (target._id === me._id) {
      throw new Error("You can't mark yourself.");
    }
    if (target.role && isWolfTeam(target.role)) {
      throw new Error('That player is already a wolf.');
    }

    await ctx.db.patch(me._id, {
      mamaWolfTarget: args.targetPlayerId,
      revealedAt: Date.now(),
    });
    await ctx.db.patch(target._id, { seerAppearsAsWolf: true });
    await ctx.db.insert('nightActions', {
      gameId: args.gameId,
      nightNumber: 0,
      actorPlayerId: me._id,
      actionType: 'mama_wolf_mark',
      targetPlayerId: args.targetPlayerId,
      resolvedAt: Date.now(),
    });
  },
});

/**
 * Host gate from reveal → day 1. Verifies all players (or bots) have
 * confirmed their role, then starts the day clock.
 */
export const beginDayFromReveal = mutation({
  args: {
    gameId: v.id('games'),
    callerDeviceClientId: v.string(),
  },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game) throw new Error('Game not found.');
    if (game.phase !== 'reveal') throw new Error('Not in reveal phase.');

    await requireHost(ctx, args.gameId, args.callerDeviceClientId);

    const players = await ctx.db
      .query('players')
      .withIndex('by_game', q => q.eq('gameId', args.gameId))
      .collect();
    const stillPending = players.some(p => p.revealedAt === undefined);
    if (stillPending) {
      throw new Error('Not all players have confirmed their role yet.');
    }
    await startDayOne(ctx, args.gameId);
  },
});

// Reveal → Day 1 transition. Shared by the host's BEGIN DAY 1 button and the
// remote auto-start (fired from confirmRoleReveal when the last player acks).
async function startDayOne(ctx: MutationCtx, gameId: Id<'games'>) {
  const game = await ctx.db.get(gameId);
  if (!game || game.phase !== 'reveal') return;
  await ctx.db.patch(gameId, { phase: 'day', dayNumber: 1 });
  await initializeDayClock(ctx, gameId);
  // Remote: kick the game off in chat — the clock is already running.
  if ((game.mode ?? 'local') === 'remote') {
    await ctx.db.insert('messages', {
      gameId,
      channel: 'village',
      authorName: 'MODERATOR',
      body: 'The timer has started. GAME ON!',
      phaseLabel: 'Day 1',
      sentAt: Date.now(),
      system: true,
    });
  }
}

export const revealView = query({
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

    let visibleTeammates: Array<{ name: string; role: string; seatPosition?: number }> = [];

    if (me.role && isWolfTeam(me.role)) {
      visibleTeammates = players
        .filter(p => p._id !== me._id && p.role && isWolfTeam(p.role))
        .map(p => ({
          name: p.name,
          role: p.role!,
          seatPosition: p.seatPosition,
        }));
    } else if (me.role === 'Minion') {
      visibleTeammates = players
        .filter(p => p.role && isWolfTeam(p.role))
        .map(p => ({
          name: p.name,
          role: p.role!,
          seatPosition: p.seatPosition,
        }));
    } else if (me.role === 'Mason') {
      // Masons form a secret society — each one learns the others at reveal,
      // exactly like the wolf pack. A lone Mason simply sees an empty list.
      // Doppelgangers who later inherit Mason aren't dealt the role yet, so
      // they don't show here; they're inducted at the night reveal step.
      visibleTeammates = players
        .filter(p => p._id !== me._id && p.role === 'Mason')
        .map(p => ({
          name: p.name,
          role: p.role!,
          seatPosition: p.seatPosition,
        }));
    }

    const confirmedCount = players.filter(p => p.revealedAt !== undefined).length;
    const hostMissing = !players.some(p => p.isHost);

    // Doppelganger picker roster: every other player. The Doppelganger sees
    // names + seat numbers (no roles) and taps one to lock in their target.
    const doppelgangerCandidates =
      me.role === 'Doppelganger' && me.revealedAt === undefined
        ? players
            .filter(p => p._id !== me._id)
            .map(p => ({
              _id: p._id,
              name: p.name,
              seatPosition: p.seatPosition,
            }))
            .sort(
              (a, b) =>
                (a.seatPosition ?? 0) - (b.seatPosition ?? 0),
            )
        : [];

    // Mama Wolf mark roster: every player who is NOT already a wolf (herself
    // and the rest of the pack read as wolves anyway, so marking them is a
    // no-op). Minion/Reviler ARE eligible — they read as villagers.
    const mamaWolfCandidates =
      me.role === 'Mama Wolf' && me.revealedAt === undefined
        ? players
            .filter(p => p._id !== me._id && !(p.role && isWolfTeam(p.role)))
            .map(p => ({
              _id: p._id,
              name: p.name,
              seatPosition: p.seatPosition,
            }))
            .sort((a, b) => (a.seatPosition ?? 0) - (b.seatPosition ?? 0))
        : [];

    return {
      game: {
        _id: game._id,
        phase: game.phase,
        mode: game.mode ?? 'local',
        playerCount: game.playerCount,
      },
      me: {
        _id: me._id,
        name: me.name,
        role: me.role,
        seatPosition: me.seatPosition,
        revealedAt: me.revealedAt,
        isHost: me.isHost,
        alive: me.alive,
        doppelgangerTarget: me.doppelgangerTarget,
        mamaWolfTarget: me.mamaWolfTarget,
      },
      visibleTeammates,
      doppelgangerCandidates,
      mamaWolfCandidates,
      confirmedCount,
      totalPlayers: players.length,
      allConfirmed: confirmedCount === players.length,
      hostMissing,
    };
  },
});

/**
 * Dev-only: host fills all empty seats with named bot players (Bot 1, Bot 2…)
 * so the lobby can be tested without 30 real phones. Bots can't act, so this is
 * useful for Phase 1 (lobby → start) testing only. The button calling this is
 * gated client-side by __DEV__.
 */
export const seedTestPlayers = mutation({
  args: {
    gameId: v.id('games'),
    callerDeviceClientId: v.string(),
  },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game) throw new Error('Game not found.');
    if (game.phase !== 'lobby') throw new Error('Game already started.');

    await requireHost(ctx, args.gameId, args.callerDeviceClientId);

    const players = await ctx.db
      .query('players')
      .withIndex('by_game', q => q.eq('gameId', args.gameId))
      .collect();

    const slotsLeft = game.playerCount - players.length;
    if (slotsLeft <= 0) return;

    const occupiedSeats = new Set(
      players
        .map(p => p.seatPosition)
        .filter((s): s is number => typeof s === 'number'),
    );
    const availableSeats: number[] = [];
    for (let i = 0; i < game.playerCount; i++) {
      if (!occupiedSeats.has(i)) availableSeats.push(i);
    }

    const existingBotNumbers = players
      .map(p => /^Bot (\d+)$/.exec(p.name)?.[1])
      .filter((n): n is string => !!n)
      .map(n => parseInt(n, 10));
    let nextBotNum = (existingBotNumbers.length ? Math.max(...existingBotNumbers) : 0) + 1;

    const now = Date.now();
    for (let i = 0; i < slotsLeft; i++) {
      await ctx.db.insert('players', {
        gameId: args.gameId,
        name: `Bot ${nextBotNum + i}`,
        seatPosition: availableSeats[i],
        alive: true,
        isHost: false,
        deviceClientId: `bot-${args.gameId}-${now}-${i}`,
        joinedAt: now,
      });
    }
  },
});

/**
 * Host voluntarily hands off duties while staying in the game. Caller must
 * be the current host; target can be any human player in the game (alive or
 * eliminated — short-handed groups often promote the first-dead to mod).
 */
export const passHost = mutation({
  args: {
    gameId: v.id('games'),
    targetPlayerId: v.id('players'),
    callerDeviceClientId: v.string(),
  },
  handler: async (ctx, args) => {
    const caller = await findCaller(ctx, args.gameId, args.callerDeviceClientId);
    if (!caller) throw new ConvexError('You are not in this game.');
    if (!caller.isHost)
      throw new ConvexError('Only the host can pass host duties.');
    if (caller._id === args.targetPlayerId) return;

    const target = await ctx.db.get(args.targetPlayerId);
    if (!target || target.gameId !== args.gameId) {
      throw new ConvexError('Target is not in this game.');
    }
    if (isBotName(target.name)) {
      throw new ConvexError("Can't pass host to a bot.");
    }

    await ctx.db.patch(caller._id, { isHost: false });
    await ctx.db.patch(args.targetPlayerId, { isHost: true });
  },
});

/**
 * Any human player claims host when the slot is empty (host explicitly
 * left, or the only host is dead). Eliminated players are allowed — they
 * often stick around and can step up to moderate.
 */
export const claimHost = mutation({
  args: {
    gameId: v.id('games'),
    callerDeviceClientId: v.string(),
  },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game) throw new ConvexError('Game not found.');
    const caller = await findCaller(ctx, args.gameId, args.callerDeviceClientId);
    if (!caller) throw new ConvexError('You are not in this game.');
    if (caller.isHost) return;

    const players = await ctx.db
      .query('players')
      .withIndex('by_game', q => q.eq('gameId', args.gameId))
      .collect();
    const currentHost = players.find(p => p.isHost);
    if (currentHost) {
      throw new ConvexError('There is already a host in this game.');
    }

    await ctx.db.patch(caller._id, { isHost: true });
  },
});

/**
 * Host bails out of a mid-game game without a win condition being met.
 * Marks the game ended (phase=ended, endedAt now) but doesn't set a winner
 * — every phone's phase-driven nav routes to EndGame where the absence of
 * `game.winner` shows the neutral "GAME OVER" banner. Distinct from the
 * lobby host-leave path (which deletes the game entirely).
 */
export const endGameByHost = mutation({
  args: {
    gameId: v.id('games'),
    callerDeviceClientId: v.string(),
  },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game) throw new ConvexError('Game not found.');
    if (game.phase === 'lobby') {
      throw new ConvexError("Use Leave to close a game that hasn't started yet.");
    }
    if (game.phase === 'ended') return;
    await requireHost(ctx, args.gameId, args.callerDeviceClientId);
    await ctx.db.patch(args.gameId, {
      phase: 'ended',
      endedAt: Date.now(),
    });
  },
});

export const lobbyView = query({
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

    const me = players.find(p => p.deviceClientId === args.deviceClientId) ?? null;

    return {
      game: {
        _id: game._id,
        roomCode: game.roomCode,
        playerCount: game.playerCount,
        phase: game.phase,
        selectedRoles: game.selectedRoles,
        // Day-phase config (lobby timers modal reads these).
        dayDurationSec:
          game.dayDurationSec ?? DAY_CONFIG_DEFAULTS.dayDurationSec,
        accusationSec:
          game.accusationSec ?? DAY_CONFIG_DEFAULTS.accusationSec,
        defenseSec: game.defenseSec ?? DAY_CONFIG_DEFAULTS.defenseSec,
        voteTimerSec:
          game.voteTimerSec ?? DAY_CONFIG_DEFAULTS.voteTimerSec,
        preVoteSec: game.preVoteSec ?? DAY_CONFIG_DEFAULTS.preVoteSec,
        maxNominationsPerDay:
          game.maxNominationsPerDay ??
          DAY_CONFIG_DEFAULTS.maxNominationsPerDay,
        wolfPickerSec:
          game.wolfPickerSec ?? DAY_CONFIG_DEFAULTS.wolfPickerSec,
        nightActionSec:
          game.nightActionSec ?? DAY_CONFIG_DEFAULTS.nightActionSec,
        revealOnLynch: game.revealOnLynch ?? false,
        revealOnNightDeath: game.revealOnNightDeath ?? false,
        devRoleAssignments: game.devRoleAssignments ?? [],
      },
      players: players.map(p => ({
        _id: p._id,
        name: p.name,
        seatPosition: p.seatPosition,
        isHost: p.isHost,
      })),
      me: me
        ? {
            _id: me._id,
            name: me.name,
            isHost: me.isHost,
            seatPosition: me.seatPosition,
          }
        : null,
    };
  },
});

export const endGameView = query({
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

    const nameById = new Map(players.map(p => [p._id, p.name]));
    const nameFor = (id: Id<'players'> | undefined): string | null =>
      id ? (nameById.get(id) ?? null) : null;

    const actions = await ctx.db
      .query('nightActions')
      .withIndex('by_game_night', q => q.eq('gameId', args.gameId))
      .collect();
    actions.sort(
      (a, b) =>
        a.nightNumber - b.nightNumber || a.resolvedAt - b.resolvedAt,
    );

    type HistoryEntry = {
      nightNumber: number;
      kind: string;
      targetName: string | null;
      secondTargetName: string | null;
      team: string | null;
      sameTeam: string | null;
      outcome: string | null;
      victimNames: string[] | null;
      // Populated for conversion entries — drives the
      // "CONVERSION — FROM → TO" label on the client.
      fromRole: string | null;
      toRole: string | null;
      // Set on wolf_kill rows whose effective target differs from the
      // wolves' pick — names the role responsible so the client can color
      // the redirect arrow per redirector (Lep green, Warlock blue).
      redirectedBy: 'Leprechaun' | 'Warlock' | null;
    };

    // Build a set of (night, targetId) pairs that actually died, used to
    // mark wolf_kill entries as KILLED vs SAVED. `delayedWounds` tags the
    // same key when the night flagged the target as a Tough Guy first
    // attack — wolf_kill on that target should render DEATH DELAYED.
    const deathKey = (night: number, id: Id<'players'>) => `${night}:${id}`;
    const deaths = new Set<string>();
    // Night-source deaths only (excludes day lynches). A day lynch is stamped
    // with the CURRENT game.nightNumber — and during day N, nightNumber is
    // N-1 — so a lynch on day N+1 collides in deathKey space with night N's
    // kill rows. Night-step outcome checks (wolf / huntress / revealer /
    // reviler / warlock KILLED-vs-SAVED) must consult THIS set, not `deaths`,
    // or a target the BG cleanly saved at night and the village then lynched
    // the next day gets mislabeled KILLED on the killer's log row.
    const nightDeaths = new Set<string>();
    const delayedWounds = new Set<string>();
    // Per-player death info, used for the elimination label ("n3" / "d2")
    // and for filtering wolf-team attribution to nights the wolf was alive
    // for.
    type DeathInfo = {
      nightNumber: number;
      phase: 'day' | 'night';
      dayNumber: number | null;
    };
    const deathByPlayer = new Map<Id<'players'>, DeathInfo>();
    // Night number on which each Cursed converted, keyed by player id.
    // Populated from cursed_conversion action rows; empty when no Cursed
    // ever converted. End-game view annotates these players with the
    // conversion arc.
    const cursedConversionByPlayer = new Map<Id<'players'>, number>();
    for (const a of actions) {
      if (a.actionType === 'death' && a.targetPlayerId) {
        const r = (a.result ?? {}) as { phase?: string; dayNumber?: number };
        const phase: 'day' | 'night' = r.phase === 'day' ? 'day' : 'night';
        deaths.add(deathKey(a.nightNumber, a.targetPlayerId));
        if (phase !== 'day') {
          nightDeaths.add(deathKey(a.nightNumber, a.targetPlayerId));
        }
        if (!deathByPlayer.has(a.targetPlayerId)) {
          deathByPlayer.set(a.targetPlayerId, {
            nightNumber: a.nightNumber,
            phase,
            dayNumber: typeof r.dayNumber === 'number' ? r.dayNumber : null,
          });
        }
      }
      if (a.actionType === 'tough_guy_wounded' && a.targetPlayerId) {
        delayedWounds.add(deathKey(a.nightNumber, a.targetPlayerId));
      }
      if (a.actionType === 'cursed_conversion' && a.actorPlayerId) {
        if (!cursedConversionByPlayer.has(a.actorPlayerId)) {
          cursedConversionByPlayer.set(a.actorPlayerId, a.nightNumber);
        }
      }
    }
    // Sasquatch conversions: parallel to cursedConversionByPlayer. The row's
    // nightNumber is the night the Sasquatch joined the pack (set at
    // beginNight, before the phase patch increments the counter).
    const sasquatchConversionByPlayer = new Map<Id<'players'>, number>();
    for (const a of actions) {
      if (a.actionType === 'sasquatch_conversion' && a.actorPlayerId) {
        if (!sasquatchConversionByPlayer.has(a.actorPlayerId)) {
          sasquatchConversionByPlayer.set(a.actorPlayerId, a.nightNumber);
        }
      }
    }
    // Alpha Wolf conversions: keyed on the CONVERT TARGET (the new wolf), not
    // an actor (the row has no actorPlayerId). nightNumber is the conversion
    // night. Used to (a) render the wolf_kill row as CONVERTED not SAVED, and
    // (b) keep the freshly-converted player off the pack's kill log for nights
    // up to and including their conversion night (they weren't pack yet).
    const alphaConversionByPlayer = new Map<Id<'players'>, number>();
    for (const a of actions) {
      if (a.actionType === 'alpha_conversion' && a.targetPlayerId) {
        if (!alphaConversionByPlayer.has(a.targetPlayerId)) {
          alphaConversionByPlayer.set(a.targetPlayerId, a.nightNumber);
        }
      }
    }
    // Failed Alpha Wolf conversions: the pack picked a CONVERT target but a
    // Bodyguard/Witch (or another lethal source) blocked it, so no new wolf
    // joined. Keyed on the target + conversion night. Used only to render the
    // pack's wolf_kill row as CONVERSION BLOCKED instead of SAVED/KILLED — the
    // wolves' intent was a conversion, not a kill.
    const blockedAlphaConversionByPlayer = new Map<Id<'players'>, number>();
    for (const a of actions) {
      if (a.actionType === 'alpha_conversion_blocked' && a.targetPlayerId) {
        if (!blockedAlphaConversionByPlayer.has(a.targetPlayerId)) {
          blockedAlphaConversionByPlayer.set(a.targetPlayerId, a.nightNumber);
        }
      }
    }
    // Doppelganger conversions: parallel structure to cursedConversionByPlayer
    // but also retains the toRole + triggerPhase so end-game can show
    // "Doppelganger → Werewolf (n3)" and the wolf-kill attribution loop can
    // figure out whether the doppelganger was actually with the pack on the
    // conversion night.
    const doppelgangerConversionByPlayer = new Map<
      Id<'players'>,
      { nightNumber: number; toRole: string; triggerPhase: 'day' | 'night' }
    >();
    for (const a of actions) {
      if (a.actionType === 'doppelganger_conversion' && a.actorPlayerId) {
        if (doppelgangerConversionByPlayer.has(a.actorPlayerId)) continue;
        const result = (a.result ?? {}) as {
          toRole?: string;
          firedAtNight?: number;
          triggerPhase?: 'day' | 'night';
        };
        const toRole = result.toRole ?? 'Villager';
        // Subtitle reflects when conversion actually fired (target's death
        // night), which may differ from the row's stamped nightNumber (0,
        // bucketed with the pre-game pick).
        const fireNight = result.firedAtNight ?? a.nightNumber;
        doppelgangerConversionByPlayer.set(a.actorPlayerId, {
          nightNumber: fireNight,
          toRole,
          triggerPhase: result.triggerPhase ?? 'night',
        });
      }
    }
    // Warlock cancel / Leprechaun redirect: precompute the effective target
    // for each night's FIRST wolf_kill row (sorted by resolvedAt). Only the
    // first kill is overridable per house rules; subsequent kills (cub
    // vengeance) resolve untouched. Priority: Warlock > Lep > original.
    const wolfKillEffectiveTarget = new Map<Id<'nightActions'>, Id<'players'>>();
    const wolfKillRedirectedBy = new Map<
      Id<'nightActions'>,
      'Leprechaun' | 'Warlock'
    >();
    {
      const killsByNight = new Map<number, typeof actions>();
      const lepRedirectByNight = new Map<number, typeof actions[number]>();
      const warlockRedirectByNight = new Map<number, typeof actions[number]>();
      for (const a of actions) {
        if (a.actionType === 'wolf_kill') {
          const list = killsByNight.get(a.nightNumber) ?? [];
          list.push(a);
          killsByNight.set(a.nightNumber, list);
        }
        if (a.actionType === 'leprechaun_redirect') {
          const dir = a.result?.direction;
          if (dir === 'L' || dir === 'R') {
            lepRedirectByNight.set(a.nightNumber, a);
          }
        }
        if (a.actionType === 'warlock_redirect') {
          warlockRedirectByNight.set(a.nightNumber, a);
        }
      }
      for (const [night, kills] of killsByNight) {
        const first = kills
          .slice()
          .sort((x, y) => x.resolvedAt - y.resolvedAt)[0];
        if (!first) continue;
        const warlock = warlockRedirectByNight.get(night);
        const warlockId = warlock?.targetPlayerId as Id<'players'> | undefined;
        if (warlockId) {
          wolfKillEffectiveTarget.set(first._id, warlockId);
          wolfKillRedirectedBy.set(first._id, 'Warlock');
          continue;
        }
        const lep = lepRedirectByNight.get(night);
        const newId = lep?.result?.newTargetId as Id<'players'> | undefined;
        if (newId) {
          wolfKillEffectiveTarget.set(first._id, newId);
          wolfKillRedirectedBy.set(first._id, 'Leprechaun');
        }
      }
    }

    const historyByPlayer = new Map<Id<'players'>, HistoryEntry[]>();
    const pushEntry = (
      playerId: Id<'players'>,
      entry: HistoryEntry,
    ) => {
      const list = historyByPlayer.get(playerId) ?? [];
      list.push(entry);
      historyByPlayer.set(playerId, list);
    };

    // Per-night set of players who had any protectable kill source aimed at
    // them — wolf effective target, witch poison, huntress shot, revealer
    // hit on a wolf-team target, reviler hit on a special villager. Used
    // by the bg_protect row to render SAVED when BG actually prevented a
    // death (vs no-op nights with no incoming attack).
    const incomingKillByNight = new Map<number, Set<Id<'players'>>>();
    const addIncoming = (night: number, id: Id<'players'>) => {
      let s = incomingKillByNight.get(night);
      if (!s) {
        s = new Set();
        incomingKillByNight.set(night, s);
      }
      s.add(id);
    };
    // Witches always submit a `witch_done` row to close their turn, even on
    // nights they also saved or poisoned. We want the history list to show
    // "Passed" only on truly idle nights, so track which (witch, night) pairs
    // had an active save/poison and suppress the redundant done row below.
    const witchActed = new Set<string>();
    const witchActedKey = (actorId: Id<'players'>, night: number) =>
      `${actorId}:${night}`;
    for (const a of actions) {
      if (
        (a.actionType === 'witch_save' || a.actionType === 'witch_poison') &&
        a.actorPlayerId
      ) {
        witchActed.add(witchActedKey(a.actorPlayerId, a.nightNumber));
      }
    }

    for (const a of actions) {
      if (a.actionType === 'wolf_kill') {
        const eff = wolfKillEffectiveTarget.get(a._id) ?? a.targetPlayerId;
        if (eff) addIncoming(a.nightNumber, eff);
      } else if (a.actionType === 'witch_poison' && a.targetPlayerId) {
        addIncoming(a.nightNumber, a.targetPlayerId);
      } else if (a.actionType === 'huntress_shot' && a.targetPlayerId) {
        addIncoming(a.nightNumber, a.targetPlayerId);
      } else if (a.actionType === 'revealer_shot' && a.targetPlayerId) {
        const t = players.find(p => p._id === a.targetPlayerId);
        if (t?.role && isWolfTeam(t.role)) {
          addIncoming(a.nightNumber, a.targetPlayerId);
        }
      } else if (a.actionType === 'reviler_shot' && a.targetPlayerId) {
        const t = players.find(p => p._id === a.targetPlayerId);
        // Reviler sees through a not-yet-sobered Drunk to its true (delayed)
        // identity — mirror `revilerSeesRole` in night.ts.
        const seen = t?.role === 'Drunk' ? t.drunkDelayedRole : t?.role;
        const isSpecial =
          !!seen && teamForRole(seen) === 'village' && seen !== 'Villager';
        if (isSpecial) addIncoming(a.nightNumber, a.targetPlayerId);
      } else if (a.actionType === 'chupacabra_kill' && a.targetPlayerId) {
        // A BG guard on the chupacabra's prey only "mattered" when the hunt
        // would actually have killed — i.e. the bite was lethal (prey was a
        // wolf, or the pack was already gone). `result.lethal` is stamped at
        // morning resolution; a non-lethal hunt never threatened the target.
        const lethal = (a.result as { lethal?: boolean } | undefined)?.lethal;
        if (lethal) addIncoming(a.nightNumber, a.targetPlayerId);
      }
    }

    for (const a of actions) {
      if (a.actionType === 'death') continue; // resolution row, not a choice
      // cursed_conversion / sasquatch_conversion DO render as per-night
      // entries now ("CONVERSION — CURSED → WEREWOLF" etc.) so the per-night
      // log matches the player-card subtitle. The ack rows below are just
      // markers and stay suppressed.
      if (a.actionType === 'cursed_conversion_ack') continue;
      // Legacy `doppelganger_conversion_ack` rows from before the OK button
      // was removed — purely noise in the history list, drop them.
      if (a.actionType === 'doppelganger_conversion_ack') continue;
      // A nightmare_skip is the NW saving their charges — nothing happened
      // on the table, so drop it. The NW's actually-used nightmares still
      // show as `nightmare_put_to_sleep` rows, and skipped nights leave
      // the NW with no entry for that night (their wolf_kill targeted-X
      // row already represents what they did with the pack).
      if (a.actionType === 'nightmare_skip') continue;
      // Nightmare put-to-sleep: NW gets the actor row (rendered as
      // "Targeted X — NIGHTMARED" on the client). We ALSO push a
      // synthetic `nightmare_blocked` entry into the *target's* history
      // for that night, but only if the target's role is one that could
      // actually have used a night ability — Villagers, Hunters, Tough
      // Guys, etc. don't get the marker because nothing was actually
      // blocked from their perspective.
      if (a.actionType === 'nightmare_put_to_sleep' && a.targetPlayerId) {
        const target = players.find(p => p._id === a.targetPlayerId);
        if (target?.role && NIGHTMARE_BLOCKABLE_ROLES.has(target.role)) {
          pushEntry(a.targetPlayerId, {
            nightNumber: a.nightNumber,
            kind: 'nightmare_blocked',
            targetName: null,
            secondTargetName: null,
            team: null,
            sameTeam: null,
            outcome: null,
            victimNames: null,
            fromRole: null,
            toRole: null,
            redirectedBy: null,
          });
        }
        // Fall through to the catch-all below, which pushes the row to
        // the NW's own history.
      }
      // A witch_done row alongside a same-night witch_save / witch_poison is
      // just the turn-closer — collapse it so the night shows only the action
      // taken, not action + Passed.
      if (
        a.actionType === 'witch_done' &&
        a.actorPlayerId &&
        witchActed.has(witchActedKey(a.actorPlayerId, a.nightNumber))
      ) {
        continue;
      }
      const result = (a.result ?? {}) as {
        team?: string;
        firstId?: Id<'players'>;
        secondId?: Id<'players'>;
        sameTeam?: string;
        toRole?: string;
      };
      // Conversion attribution: cursed/sasquatch are hardcoded since the
      // arc is fixed; doppelganger_conversion_reveal looks up the
      // originating doppelganger_conversion row (stamped at nightNumber=0)
      // for the inherited role.
      let fromRole: string | null = null;
      let toRole: string | null = null;
      if (a.actionType === 'cursed_conversion') {
        fromRole = 'Cursed';
        toRole = 'Werewolf';
      } else if (a.actionType === 'sasquatch_conversion') {
        fromRole = 'Sasquatch';
        toRole = 'Werewolf';
      } else if (
        a.actionType === 'doppelganger_conversion_reveal' &&
        a.actorPlayerId
      ) {
        const conv = doppelgangerConversionByPlayer.get(a.actorPlayerId);
        if (conv) {
          fromRole = 'Doppelganger';
          toRole = conv.toRole;
        }
      }

      // For the N0 "Doppelganged X — ROLE" row, show the target's role at
      // the moment of the pre-game pick (X's originalRole), not whatever
      // they had morphed into by the time the conversion fired. The
      // conversion itself is communicated via the per-night CONVERSION row
      // at the actual fire night, which uses the current/inherited role.
      let dopplegangerN0Outcome: string | null = null;
      if (a.actionType === 'doppelganger_conversion' && a.targetPlayerId) {
        const t = players.find(p => p._id === a.targetPlayerId);
        dopplegangerN0Outcome = t?.originalRole ?? result.toRole ?? null;
      }

      const baseEntry: HistoryEntry = {
        nightNumber: a.nightNumber,
        kind: a.actionType,
        targetName: nameFor(a.targetPlayerId),
        secondTargetName: nameFor(result.secondId),
        team: result.team ?? null,
        sameTeam: result.sameTeam ?? null,
        // Doppelganger conversion rides on `outcome` to carry the role name
        // through to the client renderer (kept off `team` because that's
        // reserved for the wolf/villager dichotomy).
        outcome: dopplegangerN0Outcome,
        victimNames: null,
        fromRole,
        toRole,
        redirectedBy: null,
      };

      if (a.actionType === 'wolf_kill') {
        // Outcome reflects the FINAL target (post-Leprechaun-redirect). The
        // wolves' chosen target stays in `targetName` for the "Targeted X"
        // narration, but KILLED/SAVED/DELAYED/CONVERTED is computed against
        // whoever actually faced the kill after any redirect. Otherwise a
        // redirected kill would render "Targeted JASON — SAVED" even when
        // Mary died. When redirected, `secondTargetName` carries the
        // effective victim so the row can read "Targeted A → B — KILLED".
        const effectiveId = wolfKillEffectiveTarget.get(a._id) ?? a.targetPlayerId;
        if (
          effectiveId &&
          a.targetPlayerId &&
          effectiveId !== a.targetPlayerId
        ) {
          baseEntry.secondTargetName = nameFor(effectiveId);
          baseEntry.redirectedBy = wolfKillRedirectedBy.get(a._id) ?? null;
        }
        const converted =
          effectiveId &&
          (cursedConversionByPlayer.get(effectiveId) === a.nightNumber ||
            alphaConversionByPlayer.get(effectiveId) === a.nightNumber);
        // A blocked Alpha conversion outranks the kill/save labels: the pack's
        // action was a conversion attempt, so report whether the CONVERSION
        // landed, not whether the target happened to live or die.
        const conversionBlocked =
          effectiveId &&
          blockedAlphaConversionByPlayer.get(effectiveId) === a.nightNumber;
        const delayed =
          effectiveId &&
          delayedWounds.has(deathKey(a.nightNumber, effectiveId));
        const killed =
          effectiveId &&
          nightDeaths.has(deathKey(a.nightNumber, effectiveId));
        baseEntry.outcome = converted
          ? 'converted'
          : conversionBlocked
            ? 'conversion_blocked'
            : delayed
              ? 'delayed'
              : killed
                ? 'killed'
                : 'saved';
        // Team decision — attribute to every wolf-team player who was alive
        // at the start of this night. Wolves act first in NIGHT_STEPS, so a
        // wolf who died during night N still made (or witnessed) night N's
        // pick. A wolf who died on day N has death.nightNumber = N-1, so
        // night N+ is correctly excluded. Ex-Cursed wolves are excluded
        // from nights before AND including their conversion night — they
        // weren't with the pack when the choice was made. Ex-Sasquatch
        // wolves flip at the START of the night they convert (before the
        // wolves step), so they ARE with the pack on that night — exclusion
        // is for nights STRICTLY before. Ex-Doppelgangers join the pack the
        // night AFTER their conversion fires regardless of triggerPhase:
        //   - 'day' fires during day D, where game.nightNumber there is
        //     D-1, so firedAtNight=D-1 and they first wolves on N=D.
        //   - 'night' fires at dopp_dusk after the wolves step has already
        //     resolved, so firedAtNight=N and they first wolves on N+1.
        // Both reduce to "exclude any night ≤ dopp.nightNumber".
        for (const p of players) {
          if (!p.role || !isWolfTeam(p.role)) continue;
          const conversionNight = cursedConversionByPlayer.get(p._id);
          if (conversionNight != null && a.nightNumber <= conversionNight) {
            continue;
          }
          const sasquatchNight = sasquatchConversionByPlayer.get(p._id);
          if (sasquatchNight != null && a.nightNumber < sasquatchNight) {
            continue;
          }
          const dopp = doppelgangerConversionByPlayer.get(p._id);
          if (dopp != null && a.nightNumber <= dopp.nightNumber) {
            continue;
          }
          // Alpha-converted player wasn't with the pack on (or before) their
          // conversion night — exclude that night's pack kill from their log.
          const alphaNight = alphaConversionByPlayer.get(p._id);
          if (alphaNight != null && a.nightNumber <= alphaNight) {
            continue;
          }
          const death = deathByPlayer.get(p._id);
          if (death && a.nightNumber > death.nightNumber) continue;
          pushEntry(p._id, baseEntry);
        }
        continue;
      }

      if (a.actionType === 'wolf_blocked') {
        // Diseased carryover — wolves skipped their pick. Same alive-at-night
        // + conversion filter as wolf_kill.
        for (const p of players) {
          if (!p.role || !isWolfTeam(p.role)) continue;
          const conversionNight = cursedConversionByPlayer.get(p._id);
          if (conversionNight != null && a.nightNumber <= conversionNight) {
            continue;
          }
          const sasquatchNight = sasquatchConversionByPlayer.get(p._id);
          if (sasquatchNight != null && a.nightNumber < sasquatchNight) {
            continue;
          }
          const dopp = doppelgangerConversionByPlayer.get(p._id);
          if (dopp != null && a.nightNumber <= dopp.nightNumber) {
            continue;
          }
          // Alpha-converted player wasn't with the pack on (or before) their
          // conversion night — exclude that night's pack kill from their log.
          const alphaNight = alphaConversionByPlayer.get(p._id);
          if (alphaNight != null && a.nightNumber <= alphaNight) {
            continue;
          }
          const death = deathByPlayer.get(p._id);
          if (death && a.nightNumber > death.nightNumber) continue;
          pushEntry(p._id, baseEntry);
        }
        continue;
      }

      if (a.actionType === 'huntress_shot') {
        const killed =
          a.targetPlayerId &&
          nightDeaths.has(deathKey(a.nightNumber, a.targetPlayerId));
        baseEntry.outcome = killed ? 'killed' : 'saved';
      }

      if (a.actionType === 'chupacabra_kill') {
        // `result.lethal` (stamped at morning resolution) says whether the
        // bite actually landed — i.e. the prey was a wolf, or the pack was
        // already gone. Render the HUNT's result, not the target's fate:
        //   - lethal && died  → KILLED
        //   - lethal && lived → SAVED (BG/Witch blocked the bite)
        //   - not lethal      → NOT A WOLF (prey wasn't a wolf while wolves
        //                       still lived — even if they later died to the
        //                       wolves / poison / a misfire).
        const lethal = (a.result as { lethal?: boolean } | undefined)?.lethal;
        if (lethal === false) {
          baseEntry.outcome = 'missed';
        } else {
          const killed =
            !!a.targetPlayerId &&
            nightDeaths.has(deathKey(a.nightNumber, a.targetPlayerId));
          baseEntry.outcome = killed ? 'killed' : 'saved';
        }
      }

      if (a.actionType === 'revealer_shot') {
        // Three outcomes:
        // - target was wolf-team, died → KILLED
        // - target was wolf-team, BG protected → SAVED
        // - target was not wolf-team → revealer dies, target lives → MISSED
        const target = a.targetPlayerId
          ? players.find(p => p._id === a.targetPlayerId)
          : null;
        const targetIsWolf = !!target?.role && isWolfTeam(target.role);
        if (targetIsWolf) {
          const killed =
            a.targetPlayerId &&
            nightDeaths.has(deathKey(a.nightNumber, a.targetPlayerId));
          baseEntry.outcome = killed ? 'killed' : 'saved';
        } else {
          baseEntry.outcome = 'missed';
        }
      }

      if (a.actionType === 'reviler_shot') {
        // Hit = special villager (village team minus plain Villager). Same
        // KILLED / SAVED / MISSED outcomes as the Revealer.
        const target = a.targetPlayerId
          ? players.find(p => p._id === a.targetPlayerId)
          : null;
        // Reviler sees through a not-yet-sobered Drunk to its true (delayed)
        // identity — mirror `revilerSeesRole` in night.ts.
        const seen =
          target?.role === 'Drunk' ? target.drunkDelayedRole : target?.role;
        const targetIsSpecial =
          !!seen && teamForRole(seen) === 'village' && seen !== 'Villager';
        if (targetIsSpecial) {
          const killed =
            a.targetPlayerId &&
            nightDeaths.has(deathKey(a.nightNumber, a.targetPlayerId));
          baseEntry.outcome = killed ? 'killed' : 'saved';
        } else {
          baseEntry.outcome = 'missed';
        }
      }

      // Hunter / Hunter Wolf shot — BG and witch saves don't apply to
      // trigger kills, so if the target's death row exists for the same
      // round, it's a confirmed kill. Otherwise (defensive) treat as
      // missed.
      if (
        a.actionType === 'hunter_shot' ||
        a.actionType === 'hunter_wolf_shot'
      ) {
        const killed =
          !!a.targetPlayerId &&
          deaths.has(deathKey(a.nightNumber, a.targetPlayerId));
        baseEntry.outcome = killed ? 'killed' : 'missed';
      }

      // Bodyguard protect. Outcome 'saved' when the protected target had
      // an incoming kill source this night (wolf attack, poison, etc.) —
      // BG's call actually mattered. Otherwise no outcome and the row
      // renders as bare "Protected X".
      if (a.actionType === 'bg_protect' && a.targetPlayerId) {
        const incoming = incomingKillByNight.get(a.nightNumber);
        if (incoming?.has(a.targetPlayerId)) {
          baseEntry.outcome = 'saved';
        }
      }

      // Leprechaun redirect. `targetName` is the wolves' original target;
      // `secondTargetName` is the new target on L/R moves; `outcome` carries
      // the direction ('L' | 'R' | 'leave') or 'blocked' for diseased-night
      // acknowledgements. The client switches on outcome to render the row.
      if (a.actionType === 'leprechaun_redirect') {
        const result = (a.result ?? {}) as {
          direction?: 'L' | 'R' | 'leave';
          newTargetId?: Id<'players'>;
          blocked?: boolean;
        };
        if (result.newTargetId) {
          baseEntry.secondTargetName = nameFor(result.newTargetId);
        }
        baseEntry.outcome = result.blocked
          ? 'blocked'
          : result.direction ?? null;
      }

      // Warlock cancel + retarget. Outcome reflects whether the chosen target
      // actually died this night — KILLED if a same-night death row hit them,
      // SAVED otherwise (BG / witch save / TG resist on a Tough Guy target).
      if (a.actionType === 'warlock_redirect') {
        const killed =
          !!a.targetPlayerId &&
          nightDeaths.has(deathKey(a.nightNumber, a.targetPlayerId));
        baseEntry.outcome = killed ? 'killed' : 'saved';
      }

      // Mad Bomber's blast — populate victim names from the result blob
      // so the end-game row can render the full cascade. No direction
      // anymore; the bomb takes both neighbors automatically.
      if (a.actionType === 'mad_bomber_kill') {
        const victimIds = (a.result?.victimIds as
          | Id<'players'>[]
          | undefined) ?? [];
        baseEntry.victimNames = victimIds
          .map(id => nameFor(id))
          .filter((n): n is string => !!n);
      }

      if (a.actorPlayerId) pushEntry(a.actorPlayerId, baseEntry);
    }

    // Build the elimination label ("Day 2" / "Night 3") from each death record.
    // We fall back to nightNumber+1 for the day number only if the legacy death
    // row predates the phase tag (so older games still render something
    // reasonable rather than swallowing the label).
    const labelFor = (death: DeathInfo | undefined): string | null => {
      if (!death) return null;
      if (death.phase === 'day') {
        const day = death.dayNumber ?? death.nightNumber + 1;
        return `Day ${day}`;
      }
      return `Night ${death.nightNumber}`;
    };

    return {
      game: {
        _id: game._id,
        phase: game.phase,
        winner: game.winner ?? null,
        playerCount: game.playerCount,
      },
      players: players
        .slice()
        .sort((a, b) => (a.seatPosition ?? 0) - (b.seatPosition ?? 0))
        .map(p => ({
          _id: p._id,
          name: p.name,
          role: p.role ?? null,
          originalRole: p.originalRole ?? null,
          cursedConvertedAtNight:
            cursedConversionByPlayer.get(p._id) ?? null,
          alphaConvertedAtNight:
            alphaConversionByPlayer.get(p._id) ?? null,
          sasquatchConvertedAtNight:
            sasquatchConversionByPlayer.get(p._id) ?? null,
          doppelgangerConvertedAtNight:
            doppelgangerConversionByPlayer.get(p._id)?.nightNumber ?? null,
          doppelgangerConvertedToRole:
            doppelgangerConversionByPlayer.get(p._id)?.toRole ?? null,
          alive: p.alive,
          seatPosition: p.seatPosition,
          isMe: p._id === me?._id,
          history: historyByPlayer.get(p._id) ?? [],
          eliminationLabel: labelFor(deathByPlayer.get(p._id)),
        })),
    };
  },
});

/**
 * Lightweight play-mode lookup. Used by the navigation-level remote-chat
 * wrapper to decide whether to dock the chat pane, without pulling a whole
 * phase-specific game view. Returns 'local' when the field is absent (legacy
 * games) and null if the game is gone.
 */
export const gameMode = query({
  args: { gameId: v.id('games') },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game) return null;
    return game.mode ?? 'local';
  },
});

/**
 * The "graveyard": a persistent record of eliminated players whose role has
 * been revealed under the role-reveal variant. Each dead player is gated by
 * the phase they died in — day deaths (lynch + day-phase Hunter/MB cascade)
 * follow revealOnLynch, night deaths follow revealOnNightDeath — so a table
 * that reveals lynches but not night kills sees only the lynched here.
 * Players whose role is NOT revealed are omitted entirely (the seating ring
 * already shows who's dead). `enabled` lets the client hide the entry point
 * when both toggles are off.
 */
export const graveyardView = query({
  args: { gameId: v.id('games') },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game) return null;
    const revealOnLynch = game.revealOnLynch ?? false;
    const revealOnNightDeath = game.revealOnNightDeath ?? false;
    const enabled = revealOnLynch || revealOnNightDeath;
    if (!enabled) return { enabled, entries: [] };

    const players = await ctx.db
      .query('players')
      .withIndex('by_game', q => q.eq('gameId', args.gameId))
      .collect();

    const actions = await ctx.db
      .query('nightActions')
      .withIndex('by_game_night', q => q.eq('gameId', args.gameId))
      .collect();
    actions.sort(
      (a, b) => a.nightNumber - b.nightNumber || a.resolvedAt - b.resolvedAt,
    );

    // First death row per player → phase + label ("d2" / "n3"), matching
    // endGameView's classification (result.phase, falling back to night).
    type DeathInfo = {
      phase: 'day' | 'night';
      label: string;
      dayNumber: number | null;
    };
    const deathByPlayer = new Map<Id<'players'>, DeathInfo>();
    for (const a of actions) {
      if (a.actionType !== 'death' || !a.targetPlayerId) continue;
      if (deathByPlayer.has(a.targetPlayerId)) continue;
      const r = (a.result ?? {}) as { phase?: string; dayNumber?: number };
      const phase: 'day' | 'night' = r.phase === 'day' ? 'day' : 'night';
      const label =
        phase === 'day'
          ? `d${r.dayNumber ?? a.nightNumber + 1}`
          : `n${a.nightNumber}`;
      deathByPlayer.set(a.targetPlayerId, {
        phase,
        label,
        dayNumber: typeof r.dayNumber === 'number' ? r.dayNumber : null,
      });
    }

    // While a lynch is still being resolved (results showing — the post-vote
    // dwell that cloaks whether a Hunter is about to shoot), the death is
    // already applied but NOT yet publicly announced. Suppress this day's
    // day-phase deaths (the lynch + any cascade) until the nomination clears,
    // so the graveyard never leaks a role ahead of the village reveal.
    const lynchInFlight = !!game.currentNomination?.resultsRevealed;

    const entries = players
      .filter(p => !p.alive)
      .map(p => {
        const death = deathByPlayer.get(p._id);
        // No death row (shouldn't happen for a dead player) → treat as night.
        const phase = death?.phase ?? 'night';
        const reveal = phase === 'day' ? revealOnLynch : revealOnNightDeath;
        if (!reveal || !p.role) return null;
        if (
          lynchInFlight &&
          phase === 'day' &&
          death?.dayNumber === game.dayNumber
        ) {
          return null;
        }
        return {
          _id: p._id,
          name: p.name,
          seatPosition: p.seatPosition,
          role: p.role,
          phase,
          label: death?.label ?? null,
        };
      })
      .filter((e): e is NonNullable<typeof e> => e !== null)
      .sort((a, b) => (a.seatPosition ?? 0) - (b.seatPosition ?? 0));

    return { enabled, entries };
  },
});

export const getGameByRoomCode = query({
  args: {
    roomCode: v.string(),
  },
  handler: async (ctx, args) => {
    const game = await ctx.db
      .query('games')
      .withIndex('by_room_code', q =>
        q.eq('roomCode', args.roomCode.toUpperCase().trim()),
      )
      .first();
    if (!game) return null;

    const players = await ctx.db
      .query('players')
      .withIndex('by_game', q => q.eq('gameId', game._id))
      .collect();

    return {
      _id: game._id,
      roomCode: game.roomCode,
      phase: game.phase,
      playerCount: game.playerCount,
      currentJoined: players.length,
      joinable: game.phase === 'lobby' && players.length < game.playerCount,
    };
  },
});
