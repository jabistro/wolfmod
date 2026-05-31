import { mutation, query, type MutationCtx } from './_generated/server';
import { v, ConvexError } from 'convex/values';
import type { Id } from './_generated/dataModel';
import { isWolfTeam, teamForRole, SINGLETON_ROLES } from '../src/data/v1Roles';
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
  },
  handler: async (ctx, args) => {
    if (args.playerCount < MIN_PLAYERS || args.playerCount > MAX_PLAYERS) {
      throw new Error(`Player count must be ${MIN_PLAYERS}-${MAX_PLAYERS}.`);
    }
    const trimmedName = args.hostName.trim();
    if (!trimmedName) throw new Error('Name is required.');

    const roomCode = await allocateRoomCode(ctx);
    const now = Date.now();

    const gameId = await ctx.db.insert('games', {
      roomCode,
      playerCount: args.playerCount,
      phase: 'lobby',
      nightNumber: 0,
      dayNumber: 0,
      selectedRoles: [],
      createdAt: now,
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
    if (game.playerCount <= MIN_PLAYERS) {
      throw new Error(`Game needs at least ${MIN_PLAYERS} seats.`);
    }

    await ctx.db.delete(args.playerId);

    // Compact remaining seats to 0..n-1, preserving relative order. Without
    // this, a hole appears where the removed player sat AND any seated
    // player whose position equals the old (now-invalid) top index falls
    // off the ring — the lobby circle only renders `playerCount` seats but
    // the player record still has the stale position, so they vanish from
    // the UI while still counting as "joined" for the start check.
    const remaining = await ctx.db
      .query('players')
      .withIndex('by_game', q => q.eq('gameId', args.gameId))
      .collect();
    const seated = remaining
      .filter(p => typeof p.seatPosition === 'number')
      .sort(
        (a, b) => (a.seatPosition as number) - (b.seatPosition as number),
      );
    for (let i = 0; i < seated.length; i++) {
      if (seated[i].seatPosition !== i) {
        await ctx.db.patch(seated[i]._id, { seatPosition: i });
      }
    }

    // selectedRoles intentionally left alone — surfacing the mismatch
    // (TOO MANY ROLES / NEED MORE) is the design.
    await ctx.db.patch(args.gameId, { playerCount: game.playerCount - 1 });
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
    if (args.playerCount < players.length) {
      throw new Error(
        `${players.length} players have joined — remove some before lowering the count.`,
      );
    }

    // Shrinking the table: any seat index outside the new range no longer
    // exists, so unseat its occupant. The host re-seats them afterwards.
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

    await ctx.db.patch(args.gameId, { selectedRoles: args.roles });
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
    if (game.selectedRoles.length !== game.playerCount) {
      throw new Error(
        `Need ${game.playerCount} roles selected, have ${game.selectedRoles.length}.`,
      );
    }
    // Pre-game parity guard. Starting wolves at or above half the table means
    // the wolves win on N1 before the first kill — block instead of letting
    // the host start a game that's already over.
    const wolfCount = game.selectedRoles.filter(isWolfTeam).length;
    if (wolfCount * 2 >= game.playerCount) {
      throw new Error(
        `Too many wolves (${wolfCount} of ${game.playerCount}) — wolves must be less than half the table.`,
      );
    }

    // Shuffle roles and assign one per seat. Bot players are pre-confirmed
    // for the reveal step so testing with one real phone + bots can proceed
    // (real bots can't tap "OK").
    const shuffled = shuffle(game.selectedRoles);
    const now = Date.now();
    let botDoppelgangerId: Id<'players'> | null = null;
    const seatOrder: Id<'players'>[] = [];
    for (const player of players) {
      const seat = player.seatPosition;
      if (typeof seat !== 'number') continue;
      const role = shuffled[seat];
      const patch: {
        role: string;
        originalRole: string;
        revealedAt?: number;
      } = { role, originalRole: role };
      if (isBotName(player.name)) {
        patch.revealedAt = now;
        if (role === 'Doppelganger') botDoppelgangerId = player._id;
      }
      await ctx.db.patch(player._id, patch);
      seatOrder.push(player._id);
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

    await ctx.db.patch(args.gameId, { phase: 'reveal' });
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

    await ctx.db.patch(me._id, { revealedAt: Date.now() });
    // Phase advances to 'day' only when the host explicitly taps BEGIN DAY 1
    // (see `beginDayFromReveal`). Auto-transitioning would start the day
    // clock — and possibly night actions later — before everyone has put
    // their phones face-down. Host-gating gives the table a clean "ready?"
    // beat.
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
    await ctx.db.patch(args.gameId, { phase: 'day', dayNumber: 1 });
    await initializeDayClock(ctx, args.gameId);
  },
});

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

    return {
      game: {
        _id: game._id,
        phase: game.phase,
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
      },
      visibleTeammates,
      doppelgangerCandidates,
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
        maxNominationsPerDay:
          game.maxNominationsPerDay ??
          DAY_CONFIG_DEFAULTS.maxNominationsPerDay,
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
    };

    // Build a set of (night, targetId) pairs that actually died, used to
    // mark wolf_kill entries as KILLED vs SAVED. `delayedWounds` tags the
    // same key when the night flagged the target as a Tough Guy first
    // attack — wolf_kill on that target should render DEATH DELAYED.
    const deathKey = (night: number, id: Id<'players'>) => `${night}:${id}`;
    const deaths = new Set<string>();
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
        deaths.add(deathKey(a.nightNumber, a.targetPlayerId));
        if (!deathByPlayer.has(a.targetPlayerId)) {
          const r = (a.result ?? {}) as { phase?: string; dayNumber?: number };
          const phase: 'day' | 'night' = r.phase === 'day' ? 'day' : 'night';
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
    // Leprechaun redirect: precompute the effective target for each night's
    // FIRST wolf_kill row (sorted by resolvedAt). Only the first kill is
    // redirectable per house rules; subsequent kills (cub vengeance) resolve
    // un-redirected. Empty when no leprechaun ever moved a kill.
    const wolfKillEffectiveTarget = new Map<Id<'nightActions'>, Id<'players'>>();
    {
      const killsByNight = new Map<number, typeof actions>();
      const redirectByNight = new Map<number, typeof actions[number]>();
      for (const a of actions) {
        if (a.actionType === 'wolf_kill') {
          const list = killsByNight.get(a.nightNumber) ?? [];
          list.push(a);
          killsByNight.set(a.nightNumber, list);
        }
        if (a.actionType === 'leprechaun_redirect') {
          const dir = a.result?.direction;
          if (dir === 'L' || dir === 'R') {
            redirectByNight.set(a.nightNumber, a);
          }
        }
      }
      for (const [night, kills] of killsByNight) {
        const first = kills
          .slice()
          .sort((x, y) => x.resolvedAt - y.resolvedAt)[0];
        if (!first) continue;
        const redirect = redirectByNight.get(night);
        const newId = redirect?.result?.newTargetId as
          | Id<'players'>
          | undefined;
        if (newId) wolfKillEffectiveTarget.set(first._id, newId);
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
        const isSpecial =
          !!t?.role &&
          teamForRole(t.role) === 'village' &&
          t.role !== 'Villager';
        if (isSpecial) addIncoming(a.nightNumber, a.targetPlayerId);
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
        }
        const converted =
          effectiveId &&
          cursedConversionByPlayer.get(effectiveId) === a.nightNumber;
        const delayed =
          effectiveId &&
          delayedWounds.has(deathKey(a.nightNumber, effectiveId));
        const killed =
          effectiveId &&
          deaths.has(deathKey(a.nightNumber, effectiveId));
        baseEntry.outcome = converted
          ? 'converted'
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
          const death = deathByPlayer.get(p._id);
          if (death && a.nightNumber > death.nightNumber) continue;
          pushEntry(p._id, baseEntry);
        }
        continue;
      }

      if (a.actionType === 'huntress_shot') {
        const killed =
          a.targetPlayerId &&
          deaths.has(deathKey(a.nightNumber, a.targetPlayerId));
        baseEntry.outcome = killed ? 'killed' : 'saved';
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
            deaths.has(deathKey(a.nightNumber, a.targetPlayerId));
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
        const targetIsSpecial =
          !!target?.role &&
          teamForRole(target.role) === 'village' &&
          target.role !== 'Villager';
        if (targetIsSpecial) {
          const killed =
            a.targetPlayerId &&
            deaths.has(deathKey(a.nightNumber, a.targetPlayerId));
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

    // Build the elimination label ("d2" / "n3") from each death record. We
    // fall back to nightNumber+1 for the day number only if the legacy death
    // row predates the phase tag (so older games still render something
    // reasonable rather than swallowing the label).
    const labelFor = (death: DeathInfo | undefined): string | null => {
      if (!death) return null;
      if (death.phase === 'day') {
        const day = death.dayNumber ?? death.nightNumber + 1;
        return `d${day}`;
      }
      return `n${death.nightNumber}`;
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
