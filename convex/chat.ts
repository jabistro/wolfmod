import { v, ConvexError } from 'convex/values';
import { paginationOptsValidator } from 'convex/server';
import { query, mutation, QueryCtx } from './_generated/server';
import { Doc, Id } from './_generated/dataModel';
import { isWolfTeam } from '../src/data/v1Roles';
import { dayConfigOf } from './helpers';
import { playerNightDecisionEndsAt } from './night';

/**
 * Remote-mode in-app chat (see the `messages` table in schema.ts).
 *
 * The whole point of this module is that channel access is DERIVED, never
 * stored: who can read/post a channel is a pure function of the live game +
 * player state, the same way the night engine decides what each phone sees.
 * A message only carries a `channel` tag; `canReadChannel` / `postState`
 * below are the single source of truth for permissions, shared by the
 * read query, the send mutation, and the `chatState` query the UI renders
 * from. Keep all access logic here so the three never drift.
 */

const MAX_BODY_LEN = 1000;
const PAGE_FALLBACK = { page: [], isDone: true, continueCursor: '' };

type Channel = 'village' | 'wolves' | 'dead' | 'break';

function isWolf(player: Doc<'players'>): boolean {
  // Real wolves only — `seerAppearsAsWolf` (Mama Wolf's mark) is deliberately
  // NOT consulted, so her targets never join the pack's chat.
  return !!player.role && isWolfTeam(player.role);
}

/**
 * Host has paused the discussion clock (not a trial / nightfall pause). While
 * true, the gameplay channels go read-only and the BREAK ROOM opens.
 */
function isGamePaused(game: Doc<'games'>): boolean {
  return (
    game.phase === 'day' &&
    !game.currentNomination &&
    // A nomination being confirmed (pendingTrial) also pauses the day clock,
    // but that's the trial starting — NOT a host pause, so don't blip to the
    // break room before the accusation opens.
    !game.pendingTrial &&
    !game.nightFallsAt &&
    game.dayPausedRemainingMs != null
  );
}

/** Who may READ a channel's transcript. */
function canReadChannel(
  channel: Channel,
  player: Doc<'players'>,
): boolean {
  switch (channel) {
    case 'village':
      // The whole table, living and dead, can read the daytime forum.
      return true;
    case 'wolves':
      // The pack — plus dead players as silent spectators (consistent with
      // the ghost-spectator night log: the dead see everything).
      return isWolf(player) || !player.alive;
    case 'dead':
      // The ghost channel is for the eliminated only.
      return !player.alive;
    case 'break':
      // Break room is visible to everyone (read-only unless paused).
      return true;
  }
}

/**
 * Whether `player` may POST to `channel` right now, and if not, the
 * thematic reason to show in the locked composer. `lockedReason: null`
 * with `canPost: false` means "you can't even see this channel" (no UI
 * needed). A non-null reason is shown to a reader who's temporarily muted.
 */
function postState(
  channel: Channel,
  player: Doc<'players'>,
  game: Doc<'games'>,
): { canPost: boolean; lockedReason: string | null } {
  const paused = isGamePaused(game);

  // Break room: open to everyone only while paused; read-only otherwise.
  if (channel === 'break') {
    return paused
      ? { canPost: true, lockedReason: null }
      : {
          canPost: false,
          lockedReason: 'The break room opens when the host pauses the game.',
        };
  }
  // While paused, the LIVING gameplay channels go read-only — chatter moves to
  // the break room so the village log stays clean. The ghost channel stays
  // live: the dead are out of the game and can keep talking on the side.
  if (paused && (channel === 'village' || channel === 'wolves')) {
    return { canPost: false, lockedReason: 'Game paused — use the BREAK ROOM.' };
  }

  switch (channel) {
    case 'dead':
      // Ghosts may always talk among themselves.
      return player.alive
        ? { canPost: false, lockedReason: null }
        : { canPost: true, lockedReason: null };

    case 'wolves':
      if (!player.alive)
        return { canPost: false, lockedReason: 'The dead only watch the hunt.' };
      if (!isWolf(player)) return { canPost: false, lockedReason: null };
      if (game.phase !== 'night')
        return { canPost: false, lockedReason: 'The pack rests until nightfall.' };
      // The pack may only talk while their decision window is open — the shot
      // clock (wolvesPickerEndsAt) is set during the pick and cleared the
      // instant a kill is locked or the timer runs out.
      if (game.wolvesPickerEndsAt == null)
        return { canPost: false, lockedReason: 'The pack has made its choice.' };
      return { canPost: true, lockedReason: null };

    case 'village': {
      // Post-game: the village is wide open for the recap — EVERYONE talks,
      // living and dead. (Checked before the alive gate below.)
      if (game.phase === 'ended')
        return { canPost: true, lockedReason: null };
      // Pre-game lobby: open gathering chat for everyone while they wait. All
      // lobby messages are wiped at startGame so they don't clutter the game.
      if (game.phase === 'lobby')
        return { canPost: true, lockedReason: null };
      if (!player.alive)
        return { canPost: false, lockedReason: 'The dead only watch.' };
      // Dawn: the floor opens the moment the night report drops, before the
      // host formally starts the day. No nomination rules apply yet.
      if (game.phase === 'morning')
        return { canPost: true, lockedReason: null };
      if (game.phase !== 'day')
        return { canPost: false, lockedReason: 'The village sleeps.' };

      // Day clock spent (nightfall queued, or the deadline has simply passed
      // before the scheduled tick set the flag) — no more talking; night is
      // coming. Checked server-side so posts are rejected even if a client's
      // composer hasn't re-locked yet.
      const dayExpired =
        game.dayPausedRemainingMs === undefined &&
        game.dayEndsAt !== undefined &&
        Date.now() > game.dayEndsAt;
      if (game.nightFallsAt || dayExpired)
        return {
          canPost: false,
          lockedReason: 'The day is over — night is falling.',
        };

      // Daytime speaking rules mirror the table moderator: once a trial is
      // forming, only one voice at a time is allowed.
      if (game.pendingTrial)
        return { canPost: false, lockedReason: 'A trial is beginning…' };

      const nom = game.currentNomination;
      if (nom) {
        switch (nom.subPhase) {
          case 'accusation':
            return nom.accuserPlayerId === player._id
              ? { canPost: true, lockedReason: null }
              : { canPost: false, lockedReason: 'Only the accuser may speak.' };
          case 'defense':
            return nom.nominatedPlayerId === player._id
              ? { canPost: true, lockedReason: null }
              : {
                  canPost: false,
                  lockedReason: 'The accused is giving their defense.',
                };
          case 'prevote':
            // No footer text — the trial banner/countdown already signals
            // that voting is imminent, so the line is redundant.
            return { canPost: false, lockedReason: null };
          case 'vote':
            return { canPost: false, lockedReason: 'Voting — cast your votes.' };
          case 'results':
            return { canPost: false, lockedReason: 'The vote is being read.' };
        }
      }

      // No active nomination — open forum for the living.
      return { canPost: true, lockedReason: null };
    }
  }
}

/** A short context stamp ("Day 2" / "Night 3") for message dividers. */
function phaseLabelFor(game: Doc<'games'>): string {
  switch (game.phase) {
    case 'day':
      return `Day ${game.dayNumber}`;
    case 'night':
      return `Night ${game.nightNumber}`;
    case 'morning':
      return `Dawn ${game.nightNumber}`;
    case 'triggers':
      return game.dayNumber >= game.nightNumber
        ? `Day ${game.dayNumber}`
        : `Night ${game.nightNumber}`;
    case 'reveal':
      return 'Roles';
    case 'lobby':
      return 'Lobby';
    case 'ended':
      return 'Game over';
    default:
      return '';
  }
}

async function resolvePlayer(
  ctx: QueryCtx,
  gameId: Id<'games'>,
  deviceClientId: string,
): Promise<Doc<'players'> | null> {
  return await ctx.db
    .query('players')
    .withIndex('by_game_device', q =>
      q.eq('gameId', gameId).eq('deviceClientId', deviceClientId),
    )
    .first();
}

/**
 * Per-caller chat state for the UI: which channels they can see, whether the
 * composer is enabled for each, and (if muted) why. The client renders tabs
 * + input purely from this — it never re-derives permissions.
 */
export const chatState = query({
  args: { gameId: v.id('games'), deviceClientId: v.string() },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game || game.mode !== 'remote') {
      return { enabled: false, channels: [] as const };
    }
    const player = await resolvePlayer(ctx, args.gameId, args.deviceClientId);
    if (!player) return { enabled: false, channels: [] as const };

    const allChannels: Channel[] = ['village', 'wolves', 'dead', 'break'];
    const channels = allChannels
      // The break room is in-game only — hide its tab in the pre-game lobby.
      .filter(channel => !(channel === 'break' && game.phase === 'lobby'))
      .filter(channel => canReadChannel(channel, player))
      .map(channel => {
        const { canPost, lockedReason } = postState(channel, player, game);
        return { channel, canPost, lockedReason };
      });

    // Trial countdown surfaced into the chat (accusation / defense / prevote):
    // the big on-screen timers are replaced by a banner in the ChatPane so the
    // speaker watches their clock while typing.
    const nom = game.currentNomination;
    let trial:
      | {
          subPhase: 'accusation' | 'defense' | 'prevote';
          endsAt: number;
          pausedRemainingMs: number | null;
          accusedName: string;
          accuserName: string;
          iAmSpeaker: boolean;
        }
      | null = null;
    if (
      nom &&
      (nom.subPhase === 'accusation' ||
        nom.subPhase === 'defense' ||
        nom.subPhase === 'prevote')
    ) {
      const accused = await ctx.db.get(nom.nominatedPlayerId);
      const accuser = nom.accuserPlayerId
        ? await ctx.db.get(nom.accuserPlayerId)
        : null;
      const iAmSpeaker =
        (nom.subPhase === 'accusation' &&
          nom.accuserPlayerId === player._id) ||
        (nom.subPhase === 'defense' && nom.nominatedPlayerId === player._id);
      trial = {
        subPhase: nom.subPhase,
        endsAt: nom.subPhaseEndsAt,
        pausedRemainingMs: nom.subPhasePausedRemainingMs ?? null,
        accusedName: accused?.name ?? 'the accused',
        accuserName: accuser?.name ?? 'someone',
        iAmSpeaker,
      };
    }
    // The chat owns the screen (taller) during morning and every non-vote
    // trial step — the underlying game screen goes minimal.
    const chatDominant =
      game.phase === 'morning' ||
      (!!nom &&
        (nom.subPhase === 'accusation' ||
          nom.subPhase === 'defense' ||
          nom.subPhase === 'prevote' ||
          nom.subPhase === 'results'));

    // Both the discussion stats and the wolf-pack roster need the player list;
    // fetch it once and share.
    const wolvesReadable = canReadChannel('wolves', player);
    const needDayStats =
      game.phase === 'day' && !nom && !game.nightFallsAt;
    const allPlayers =
      wolvesReadable || needDayStats
        ? await ctx.db
            .query('players')
            .withIndex('by_game', q => q.eq('gameId', args.gameId))
            .collect()
        : [];

    // Active discussion stats, relocated into the chat header (replacing "CHAT"
    // when expanded) so the clock/alive/noms stay visible while the tall chat
    // covers the underlying timer bar. Only during open discussion.
    let day: {
      aliveCount: number;
      dayEndsAt: number | null;
      dayPausedRemainingMs: number | null;
      nominationsRemaining: number;
      maxNominationsPerDay: number;
    } | null = null;
    if (needDayStats) {
      const cfg = dayConfigOf(game);
      day = {
        aliveCount: allPlayers.filter(p => p.alive).length,
        dayEndsAt: game.dayEndsAt ?? null,
        dayPausedRemainingMs: game.dayPausedRemainingMs ?? null,
        nominationsRemaining: Math.max(
          0,
          cfg.maxNominationsPerDay - (game.nominationsThisDay ?? 0),
        ),
        maxNominationsPerDay: cfg.maxNominationsPerDay,
      };
    }

    // Wolf-pack roster, pinned at the top of the WOLVES chat so the pack can
    // see who's on their team — and which wolf is which — without leaving the
    // chat to study the seating ring, speeding up the nightly kill decision.
    // Mirrors the "Name (Role)" reveal the wolves already share at role reveal.
    // Real wolves only (Minion/Reviler don't wake with — or chat with — the
    // pack). Exposed to anyone who can READ the channel: the living pack plus
    // dead spectators (consistent with the ghost-spectator full-info view).
    // Seat order so it reads the same on every wolf's phone.
    const wolfRoster = wolvesReadable
      ? allPlayers
          .filter(p => isWolf(p))
          .sort((a, b) => (a.seatPosition ?? 0) - (b.seatPosition ?? 0))
          .map(p => ({
            name: p.name,
            role: p.role!,
            alive: p.alive,
            isMe: p._id === player._id,
          }))
      : null;

    return {
      enabled: true,
      channels,
      me: { playerId: player._id, alive: player.alive },
      // Surfaced so the ChatPane header can host the morning BEGIN DAY control
      // (see ChatPane.tsx) instead of a separate jumbled morning-screen block.
      phase: game.phase,
      isHost: player.isHost,
      gameOver: !!game.winner,
      // Vote countdown is live — ChatPane auto-collapses so the LIVES/DIES
      // buttons aren't hidden behind the chat.
      voteActive: game.currentNomination?.subPhase === 'vote',
      // Results just tallied — ChatPane forces every device to the bottom so the
      // vote-result card is front-and-center (not the pre-vote scroll spot).
      voteResultsShowing: !!nom && nom.subPhase === 'results',
      trial,
      chatDominant,
      day,
      wolfRoster,
      // Host paused the discussion → client moves everyone to the BREAK ROOM
      // and makes the gameplay channels read-only.
      paused: isGamePaused(game),
      // The viewer's current night decision deadline (if any) so the chat
      // header can show a countdown while the picker is hidden under the chat:
      // the wolves' shared shot clock for the pack, else this actor's own
      // NIGHT ACTIONS deadline. Null if they have nothing to decide.
      decisionClock:
        game.phase !== 'night'
          ? null
          : isWolf(player) && game.wolvesPickerEndsAt != null
            ? game.wolvesPickerEndsAt
            : await playerNightDecisionEndsAt(ctx, game, player),
    };
  },
});

/** Paginated, reactive transcript for one channel (newest first). */
export const listMessages = query({
  args: {
    gameId: v.id('games'),
    deviceClientId: v.string(),
    channel: v.union(
      v.literal('village'),
      v.literal('wolves'),
      v.literal('dead'),
      v.literal('break'),
    ),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game || game.mode !== 'remote') return PAGE_FALLBACK;
    const player = await resolvePlayer(ctx, args.gameId, args.deviceClientId);
    if (!player || !canReadChannel(args.channel, player)) return PAGE_FALLBACK;

    return await ctx.db
      .query('messages')
      .withIndex('by_game_channel', q =>
        q.eq('gameId', args.gameId).eq('channel', args.channel),
      )
      .order('desc')
      .paginate(args.paginationOpts);
  },
});

/**
 * Per-channel unread counts for the caller, across every channel they can
 * READ — so the collapsed chat bar can show a running total and each channel
 * tab can show its own badge. `lastSeen[channel]` is the client's high-water
 * mark (the newest message it has shown for that channel); anything newer
 * (and not the caller's own) is unread. Also returns each channel's newest
 * `sentAt` so a fresh client can seed its marks and not count old history.
 */
export const unreadCounts = query({
  args: {
    gameId: v.id('games'),
    deviceClientId: v.string(),
    lastSeen: v.object({
      village: v.optional(v.number()),
      wolves: v.optional(v.number()),
      dead: v.optional(v.number()),
      break: v.optional(v.number()),
    }),
  },
  handler: async (ctx, args) => {
    const empty = {
      counts: { village: 0, wolves: 0, dead: 0, break: 0 },
      latest: { village: 0, wolves: 0, dead: 0, break: 0 },
    };
    const game = await ctx.db.get(args.gameId);
    if (!game || game.mode !== 'remote') return empty;
    const player = await resolvePlayer(ctx, args.gameId, args.deviceClientId);
    if (!player) return empty;

    const channels: Channel[] = ['village', 'wolves', 'dead', 'break'];
    const counts: Record<Channel, number> = empty.counts;
    const latest: Record<Channel, number> = empty.latest;

    for (const channel of channels) {
      if (!canReadChannel(channel, player)) continue;
      const since = args.lastSeen[channel] ?? 0;
      // Newest-first; record the newest sentAt, then stop once we pass the
      // caller's last-seen mark. The caller's own messages aren't "unread".
      for await (const m of ctx.db
        .query('messages')
        .withIndex('by_game_channel', q =>
          q.eq('gameId', args.gameId).eq('channel', channel),
        )
        .order('desc')) {
        if (latest[channel] === 0) latest[channel] = m.sentAt;
        if (m.sentAt <= since) break;
        // Only another PLAYER's messages are "unread". Moderator/system cards
        // (dawn report, dusk notice, GAME ON) are app-presented narration — they
        // have no authorPlayerId and never count toward an unread badge/divider.
        if (m.authorPlayerId != null && m.authorPlayerId !== player._id)
          counts[channel]++;
      }
    }
    return { counts, latest };
  },
});

export const sendMessage = mutation({
  args: {
    gameId: v.id('games'),
    deviceClientId: v.string(),
    channel: v.union(
      v.literal('village'),
      v.literal('wolves'),
      v.literal('dead'),
      v.literal('break'),
    ),
    body: v.string(),
  },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game) throw new ConvexError('Game not found.');
    if (game.mode !== 'remote')
      throw new ConvexError('Chat is only available in remote games.');

    const player = await resolvePlayer(ctx, args.gameId, args.deviceClientId);
    if (!player) throw new ConvexError('You are not in this game.');

    const body = args.body.trim();
    if (!body) throw new ConvexError('Message is empty.');
    if (body.length > MAX_BODY_LEN)
      throw new ConvexError('Message is too long.');

    const { canPost, lockedReason } = postState(args.channel, player, game);
    if (!canPost)
      throw new ConvexError(lockedReason ?? 'You cannot post here right now.');

    await ctx.db.insert('messages', {
      gameId: args.gameId,
      channel: args.channel,
      authorPlayerId: player._id,
      authorName: player.name,
      body,
      phaseLabel: phaseLabelFor(game),
      sentAt: Date.now(),
    });
    return null;
  },
});
