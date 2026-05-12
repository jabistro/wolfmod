import { mutation, query, type MutationCtx } from './_generated/server';
import { v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import { isWolfTeam, teamForRole } from '../src/data/v1Roles';
import { findCaller, requireHost, isBotName } from './helpers';

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

    // If everyone has now confirmed, advance to the night phase.
    const players = await ctx.db
      .query('players')
      .withIndex('by_game', q => q.eq('gameId', args.gameId))
      .collect();
    const stillPending = players.some(
      p => p._id !== me._id && p.revealedAt === undefined,
    );
    if (!stillPending) {
      // Game starts on Day 1 — there's no Night 0. Players just learned their
      // roles in reveal; day 1 is for setup/discussion and the host kicks off
      // night 1 manually when ready.
      await ctx.db.patch(args.gameId, {
        phase: 'day',
        dayNumber: 1,
      });
    }
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
      },
      visibleTeammates,
      confirmedCount,
      totalPlayers: players.length,
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
    };

    // Build a set of (night, targetId) pairs that actually died, used to
    // mark wolf_kill entries as KILLED vs SAVED.
    const deathKey = (night: number, id: Id<'players'>) => `${night}:${id}`;
    const deaths = new Set<string>();
    for (const a of actions) {
      if (a.actionType === 'death' && a.targetPlayerId) {
        deaths.add(deathKey(a.nightNumber, a.targetPlayerId));
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
      };

      if (a.actionType === 'wolf_kill') {
        const killed =
          a.targetPlayerId &&
          deaths.has(deathKey(a.nightNumber, a.targetPlayerId));
        baseEntry.outcome = killed ? 'killed' : 'saved';
        // Team decision — attribute to every wolf-team player so each wolf
        // sees the kill in their own history.
        for (const p of players) {
          if (p.role && isWolfTeam(p.role)) pushEntry(p._id, baseEntry);
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

      if (a.actorPlayerId) pushEntry(a.actorPlayerId, baseEntry);
    }

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
