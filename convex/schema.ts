import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

export default defineSchema({
  games: defineTable({
    roomCode: v.string(),
    playerCount: v.number(),
    phase: v.union(
      v.literal('lobby'),
      v.literal('reveal'),
      v.literal('night'),
      v.literal('morning'),
      v.literal('day'),
      v.literal('ended'),
    ),
    nightNumber: v.number(),
    dayNumber: v.number(),
    nightStep: v.optional(v.string()),
    /**
     * Wall-clock deadline (ms) for the current night step. Each step holds at
     * least until this passes, even if the action is recorded earlier. This
     * cloaks "actor is dead" (instant skip) vs "actor is deciding" (variable
     * time) — they look the same to other players.
     */
    nightStepEndsAt: v.optional(v.number()),
    selectedRoles: v.array(v.string()),
    winner: v.optional(v.union(v.literal('village'), v.literal('wolf'))),
    createdAt: v.number(),
    endedAt: v.optional(v.number()),

    // Day-phase configuration. voteTimerSec is the per-vote countdown
    // (default 5, configurable in Settings later).
    voteTimerSec: v.optional(v.number()),
    /**
     * Wall-clock target for end-of-day display. Currently informational
     * only — host explicitly transitions to night via BEGIN NIGHT.
     */
    dayEndsAt: v.optional(v.number()),
    /**
     * Active nomination state, if any. The host nominates a player and a
     * vote runs until voteEndsAt; after a scheduled tally, resultsRevealed
     * flips true and everyone sees the LIVES/DIES breakdown until the host
     * taps CONTINUE GAME (which either lynches and ends day, or clears the
     * nomination so day continues).
     */
    currentNomination: v.optional(
      v.object({
        nominatedPlayerId: v.id('players'),
        voteEndsAt: v.number(),
        resultsRevealed: v.boolean(),
        nominationIndex: v.number(),
      }),
    ),
    nominationsThisDay: v.optional(v.number()),
  }).index('by_room_code', ['roomCode']),

  players: defineTable({
    gameId: v.id('games'),
    name: v.string(),
    seatPosition: v.optional(v.number()),
    role: v.optional(v.string()),
    alive: v.boolean(),
    isHost: v.boolean(),
    deviceClientId: v.string(),
    joinedAt: v.number(),
    revealedAt: v.optional(v.number()),
    pendingDeath: v.optional(v.boolean()),
    roleState: v.optional(v.any()),
  })
    .index('by_game', ['gameId'])
    .index('by_device', ['deviceClientId'])
    .index('by_game_device', ['gameId', 'deviceClientId']),

  /**
   * Append-only log of every night/day action. Powers spectator view, the
   * morning death-resolution math, and post-game history. We never delete
   * rows here; resolution writes new entries (e.g. 'death' rows alongside
   * the 'wolf_kill' that caused them).
   */
  nightActions: defineTable({
    gameId: v.id('games'),
    nightNumber: v.number(),
    actorPlayerId: v.optional(v.id('players')),
    actionType: v.string(),
    targetPlayerId: v.optional(v.id('players')),
    result: v.optional(v.any()),
    resolvedAt: v.number(),
  }).index('by_game_night', ['gameId', 'nightNumber']),

  /**
   * One row per voter per nomination. We keep history (don't overwrite)
   * across the game so spectators can review who voted what across the
   * whole day. nominationIndex disambiguates multiple nominations in a
   * single day.
   */
  nominationVotes: defineTable({
    gameId: v.id('games'),
    dayNumber: v.number(),
    nominationIndex: v.number(),
    voterPlayerId: v.id('players'),
    vote: v.union(v.literal('lives'), v.literal('dies')),
    votedAt: v.number(),
  }).index('by_game_nomination', ['gameId', 'dayNumber', 'nominationIndex']),
});
