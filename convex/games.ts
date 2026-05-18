import { mutation, query, type MutationCtx } from './_generated/server';
import { v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import { isWolfTeam, teamForRole } from '../src/data/v1Roles';
import {
  findCaller,
  requireHost,
  isBotName,
  initializeDayClock,
  DAY_CONFIG_DEFAULTS,
} from './helpers';

const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I, O
const ROOM_CODE_LENGTH = 4;
const MIN_PLAYERS = 3;
const MAX_PLAYERS = 30;

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
    if (!game) throw new Error('Game not found.');
    if (game.phase !== 'lobby') throw new Error('Game has already started.');

    // Reconnect: same device already in this game
    const existing = await ctx.db
      .query('players')
      .withIndex('by_game_device', q =>
        q.eq('gameId', game._id).eq('deviceClientId', args.deviceClientId),
      )
      .first();
    if (existing) {
      return { gameId: game._id, playerId: existing._id, rejoined: true };
    }

    const trimmedName = args.name.trim();
    if (!trimmedName) throw new Error('Name is required.');

    const players = await ctx.db
      .query('players')
      .withIndex('by_game', q => q.eq('gameId', game._id))
      .collect();
    if (players.length >= game.playerCount) {
      throw new Error('Game is full.');
    }
    if (players.some(p => p.name.toLowerCase() === trimmedName.toLowerCase())) {
      throw new Error('Name already taken in this game.');
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
    }
    // Mid-game leave handled in later phases (host-claim, spectator transition)
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

    // Shuffle roles and assign one per seat. Bot players are pre-confirmed
    // for the reveal step so testing with one real phone + bots can proceed
    // (real bots can't tap "OK").
    const shuffled = shuffle(game.selectedRoles);
    const now = Date.now();
    for (const player of players) {
      const seat = player.seatPosition;
      if (typeof seat !== 'number') continue;
      const role = shuffled[seat];
      const patch: { role: string; revealedAt?: number } = { role };
      if (isBotName(player.name)) patch.revealedAt = now;
      await ctx.db.patch(player._id, patch);
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

    await ctx.db.patch(me._id, { revealedAt: Date.now() });
    // Phase advances to 'day' only when the host explicitly taps BEGIN DAY 1
    // (see `beginDayFromReveal`). Auto-transitioning would start the day
    // clock — and possibly night actions later — before everyone has put
    // their phones face-down. Host-gating gives the table a clean "ready?"
    // beat.
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
      },
      visibleTeammates,
      confirmedCount,
      totalPlayers: players.length,
      allConfirmed: confirmedCount === players.length,
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
      direction: string | null;
      victimNames: string[] | null;
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

    for (const a of actions) {
      if (a.actionType === 'death') continue; // resolution row, not a choice
      const result = (a.result ?? {}) as {
        team?: string;
        firstId?: Id<'players'>;
        secondId?: Id<'players'>;
        sameTeam?: string;
      };
      const baseEntry: HistoryEntry = {
        nightNumber: a.nightNumber,
        kind: a.actionType,
        targetName: nameFor(a.targetPlayerId),
        secondTargetName: nameFor(result.secondId),
        team: result.team ?? null,
        sameTeam: result.sameTeam ?? null,
        outcome: null,
        direction: null,
        victimNames: null,
      };

      if (a.actionType === 'wolf_kill') {
        const delayed =
          a.targetPlayerId &&
          delayedWounds.has(deathKey(a.nightNumber, a.targetPlayerId));
        const killed =
          a.targetPlayerId &&
          deaths.has(deathKey(a.nightNumber, a.targetPlayerId));
        baseEntry.outcome = delayed ? 'delayed' : killed ? 'killed' : 'saved';
        // Team decision — attribute to every wolf-team player who was alive
        // at the start of this night. Wolves act first in NIGHT_STEPS, so a
        // wolf who died during night N still made (or witnessed) night N's
        // pick. A wolf who died on day N has death.nightNumber = N-1, so
        // night N+ is correctly excluded.
        for (const p of players) {
          if (!p.role || !isWolfTeam(p.role)) continue;
          const death = deathByPlayer.get(p._id);
          if (death && a.nightNumber > death.nightNumber) continue;
          pushEntry(p._id, baseEntry);
        }
        continue;
      }

      if (a.actionType === 'wolf_blocked') {
        // Diseased carryover — wolves skipped their pick. Same alive-at-night
        // filter as wolf_kill: only wolves who were around to lose the pick.
        for (const p of players) {
          if (!p.role || !isWolfTeam(p.role)) continue;
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

      // Mad Destroyer's blast — populate direction + victim names from
      // the result blob so the end-game row can render the full cascade.
      if (a.actionType === 'mad_destroyer_kill') {
        const direction = (a.result?.direction as string | undefined) ?? null;
        const victimIds = (a.result?.victimIds as
          | Id<'players'>[]
          | undefined) ?? [];
        baseEntry.direction = direction;
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
      },
      players: players
        .slice()
        .sort((a, b) => (a.seatPosition ?? 0) - (b.seatPosition ?? 0))
        .map(p => ({
          _id: p._id,
          name: p.name,
          role: p.role ?? null,
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
