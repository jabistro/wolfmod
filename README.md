# WolfMod

A digital moderator for **Ultimate Werewolf**. Every player runs the app on their phone — WolfMod handles role reveal, the night phase, day discussion, nominations, lynch votes, and the win condition so the whole table can play.

Built with Expo / React Native and Convex.

---

## Why

Most werewolf groups have just enough people for a good game. Dedicating one of them to moderate means dropping roles, missing the fun, or both. WolfMod replaces the human mod so every friend can play.

It also fixes the things that go wrong with a human mod: forgotten wake-ups, leaked tells from timing or wording, inconsistent vote rules, and arguments over who actually died.

---

## Features

### Multi-device moderated game
- **Create / Join** a game from any phone. The host sets the player count (3–30) and drags players into seats in a circular layout — seating matters for adjacency-based roles.
- **Role reveal** with press-and-hold to view. Wolves see their pack. Minion sees the wolves. Confirmations are tracked so no one starts until everyone has acknowledged.
- **Night phase** runs role-by-role with cloaked timing: every step has a randomized 6–12 s dwell so observers can't tell from the duration whether a role is in the game, whether the actor is dead, or whether they acted quickly.
- **Day phase** with a configurable day clock, nomination budget, accusation / defense / vote sub-phases, per-clock pause/reset, and a public vote breakdown.
- **Death-trigger roles** (Hunter, Hunter Wolf, Mad Destroyer) prompt the dying player on their own phone with proper cascade ordering and announcements that don't leak team identity.
- **Ghost spectator**: dead players see every night picker mirrored in real time with target reveals — the IRL "dead players know everything" experience.
- **End-game recap**: tap any role to expand a per-night history of what that player did, with KILLED / SAVED / MISSED / DEATH DELAYED labels.

### ModClock (single-device timer)
A standalone day-phase clock for groups that want a human mod but still want the timer. Day countdown, nomination flow with accuser / defense / vote sub-phases, bell + gavel audio cues.

### Roles browser
Browse all supported roles with descriptions, team coloring (Village / Wolves / Team Wolf / Solo), and reference values for balancing.

---

## Supported roles

**v1 (shipping, 18):** Villager, Werewolf, Wolf Man, Wolf Cub, Hunter Wolf, Hunter, Huntress, Seer, Paranormal Investigator, Mentalist, Witch, Bodyguard, Tough Guy, Diseased, Minion, Revealer, Reviler, Mad Destroyer.

**v2 (deferred, 6):** Alpha Wolf, Doppelganger, Cursed, Sasquatch, Chupacabra, Leprechaun. These have team-change or chained-cascade mechanics that need more design work.

---

## Game flow

```
Lobby → Role Reveal → Day 1 → Night 1 → Morning → Day 2 → … → End Reveal
```

- Day always precedes its corresponding night — players learn their role at reveal, then the game opens with discussion.
- Mornings announce eliminations only; roles are never auto-revealed on death. Working out who died, and why, is the point.
- Lynch is strict majority of DIES votes; ties go to LIVES.
- Win condition: wolves vs. non-wolf-aligned villagers (Minion and Reviler don't count for parity).

---

## Tech stack

- **Expo** ~54 + **React Native** 0.81 + **TypeScript**
- **NativeWind** v4 (Tailwind CSS for React Native)
- **Convex** for the backend — reactive per-player queries (wolves see different state than villagers; dead players see everything live)
- **React Navigation** (native-stack)
- **EAS** for builds (`com.jabistro.wolfmod` on Android)

---

## Running locally

```bash
npm install
npx convex dev    # start the Convex backend (separate terminal)
npm start         # Expo dev server — scan the QR with Expo Go
npm run ios       # iOS simulator
npm run android   # Android emulator
```

You'll need a Convex deployment configured for the backend to come up — see [convex.dev](https://convex.dev) for setup.

---

## Project structure

```
App.tsx                  # root, mounts ConvexProvider + navigation
convex/                  # backend
  schema.ts              # games, players, nightActions, nominationVotes
  games.ts               # lobby, role reveal, end-game recap
  night.ts               # night engine: wake order, dwell, morning resolution
  day.ts                 # day clock, nominations, vote tally
  triggers.ts            # Hunter / Hunter Wolf / Mad Destroyer death triggers
  helpers.ts             # shared helpers + config defaults
src/
  screens/               # Home, PlayMenu, Create/Join, Lobby, RoleReveal,
                         # Night, Morning, Day, Triggers, EndGame,
                         # Clock (ModClock), Roles
  components/            # SeatingCircle, ThemedAlert, BuildModal,
                         # RolesBrowser, TimersConfigModal
  data/
    roles.ts             # full role catalogue with descriptions
    v1Roles.ts           # shipping role roster + team helpers
    nightOrder.ts        # NIGHT_STEPS wake order
    roleValues.ts        # weighted balance values
  hooks/useDeviceId.ts   # persistent device UUID for reconnect
  navigation/            # stack types
assets/
  images/                # logo, icon, splash, gifs
  sounds/                # ModClock bell + gavel
roles_medium/            # role card art (medium)
roles_thumbs/            # role card art (thumbnails)
```

---

## Status

Phase 4 of the multi-device build is complete — all v1 roles run end-to-end including death-trigger cascades, the day phase has configurable timers and sub-phase clocks, ghost-spectator mode is live, and end-game recap exists. Open polish items:

- Disconnect / reconnect from cold app launch
- Host-claim flow for orphaned games
- Sound + haptics for night/morning transitions
- v2 roles (team-change / chained mechanics)

---

## License

Personal project. No license granted — please don't redistribute. Ultimate Werewolf is a trademark of Bezier Games; this is an unaffiliated companion app.
