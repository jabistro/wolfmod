# WolfMod

A digital moderator for **Ultimate Werewolf**. Every player runs the app on their phone — WolfMod handles role reveal, the night phase, day discussion, nominations, lynch votes, and the win condition so the whole table can play. It works around one table or fully remote, with per-player chat, and ships three swappable art-and-font themes.

Built with Expo / React Native and Convex.

---

## Try the demo

WolfMod is a mobile app, but you can try the public demo without an app store account. Best with a group of 5+ friends, but you can also play solo with the **Roles** browser or the single-device **ModClock** timer.

### Android — install the APK (the easy way)

This is the recommended way in — no app store, no account, no build tools. [Download the APK](https://expo.dev/artifacts/eas/ZbT0LbtMN0OYWi4GnDw4MfEksnx-vONAz4XciOeKagg.apk) on your Android phone and open the file to install. You may need to allow installs from your browser the first time. Short on players? Fill the empty seats with bots.

<a href="https://expo.dev/artifacts/eas/ZbT0LbtMN0OYWi4GnDw4MfEksnx-vONAz4XciOeKagg.apk"><img src="assets/images/apk-download-qr.png" alt="APK download QR" width="180"></a>

**iPhone:** there's no public iOS download yet — iOS goes out through TestFlight, so ask for an invite.

### Already running a WolfMod build?

If you have a WolfMod development or preview build installed, scan this to pull the latest public demo over the air (an EAS Update at runtime 3.6.0 — it loads in a WolfMod build, not stock Expo Go):

<a href="https://expo.dev/preview/update?message=Public+demo&updateRuntimeVersion=3.6.0&createdAt=2026-07-09T06%3A51%3A41.699Z&slug=wolfmod&projectId=cb9e5e86-7395-4618-b62a-a148b6bf3d83&group=c44302b9-dee1-4b8e-a882-d1f9b46f9029"><img src="assets/images/expo-go-qr.png" alt="Preview update QR" width="180"></a>

Or open the [preview link](https://expo.dev/preview/update?message=Public+demo&updateRuntimeVersion=3.6.0&createdAt=2026-07-09T06%3A51%3A41.699Z&slug=wolfmod&projectId=cb9e5e86-7395-4618-b62a-a148b6bf3d83&group=c44302b9-dee1-4b8e-a882-d1f9b46f9029) directly on your phone.

The demo runs on a shared Convex backend, so it may be slow or rate-limited under load.

---

## Why

Most werewolf groups have just enough people for a good game. Dedicating one of them to moderate means dropping roles, missing the fun, or both. WolfMod replaces the human mod so every friend can play.

It also fixes the things that go wrong with a human mod: forgotten wake-ups, leaked tells from timing or wording, inconsistent vote rules, and arguments over who actually died.

---

## Features

### Multi-device moderated game
- **Create / Join** a game from any phone. The host sets the player count (3–30) and drags players into seats in a circular layout — seating matters for adjacency-based roles. Compact re-seating keeps the circle contiguous when the count drops.
- **Local or remote play.** Run it around one table, or fully remote with per-player text chat (team + public channels, unread badges, and a full autopilot so the game advances without a human mod present).
- **Build modal** to pick the exact role list, with live validation that surfaces mismatches (TOO MANY / NEED MORE) and role incompatibilities instead of silently trimming.
- **Role reveal** with press-and-hold to view on a trade-dress-distinct card. Wolves see their pack, the Minion sees the wolves, Masons learn each other. Confirmations are tracked so no one starts until everyone has acknowledged.
- **Night phase** runs role-by-role in gated parallel waves with cloaked timing: every step has a randomized dwell so observers can't tell from the duration whether a role is in the game, whether the actor is dead, or whether they acted quickly. Passive triggers are never surfaced in player-facing UI.
- **Day phase** with a configurable day clock, player-driven nominations (any player taps a seat to nominate; per-day cap, host escape hatch), accusation / defense / vote sub-phases, per-clock pause/reset, and a public vote breakdown.
- **Death-trigger roles** (Hunter, Hunter Wolf, Mad Bomber) prompt the dying player on their own phone with proper cascade ordering and announcements that don't leak team identity.
- **Ghost spectator**: dead players see every night picker mirrored in real time with target reveals — the IRL "dead players know everything" experience, in a chronological per-actor night log.
- **Optional role reveal on death** and a self-hiding graveyard for eliminated players.
- **End-game recap**: tap any role to expand a per-night history of what that player did, with KILLED / SAVED / MISSED / DEATH DELAYED labels.

### Themes
Three swappable decks — **Ghibli** (default), **Chibi**, and **16-Bit** — each with its own role card art, seat avatars, day/night table backdrops, and an app-wide font. Picked in Settings; the active deck's art is pre-warmed on launch so screens render without load-in lag.

### Table gamification
Seat avatars around the circle plus full-screen day/night backdrops on every phase screen, with cinematic cross-fade transitions between day and night.

### ModClock (single-device timer)
A standalone day-phase clock for groups that want a human mod but still want the timer. Day countdown, nomination flow with accuser / defense / vote sub-phases, bell + gavel audio cues.

### Roles browser
Browse the full ~140-role Ultimate Werewolf catalogue with descriptions, team coloring (Village / Wolves / Team Wolf / Solo), and reference values for balancing. The 30 playable roles show themed art; the rest appear as locked "unlock to play" cards.

---

## Supported roles

**30 roles play end-to-end**, grouped by allegiance:

- **Village (16):** Villager, Seer, Witch, Bodyguard, Hunter, Huntress, Mentalist, Paranormal Investigator, Tough Guy, Diseased, Revealer, Mad Bomber, Leprechaun, Warlock, Lycan, Mason.
- **Wolves (7):** Werewolf, Wolf Man, Hunter Wolf, Wolf Cub, Nightmare Wolf, Mama Wolf, Alpha Wolf.
- **Wolf-aligned (2):** Minion, Reviler.
- **Convertible / solo (5):** Cursed, Doppelganger, Sasquatch, Drunk, Chupacabra.

The team-change and chained-cascade roles that were once deferred (Alpha Wolf, Doppelganger, Cursed, Sasquatch, Chupacabra, Leprechaun) are now in the shipping set. The Roles browser lists the broader Ultimate Werewolf catalogue beyond these 30 as locked "unlock to play" cards.

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

- **Expo** ~54 + **React Native** 0.81.5 + **TypeScript**
- **NativeWind** v4 (Tailwind CSS for React Native)
- **Convex** for the backend — reactive per-player queries (wolves see different state than villagers; dead players see everything live)
- **React Navigation** (stack) with opacity cross-fade transitions
- **expo-image** for cached art, with a startup preloader that warms the active deck
- **Per-theme fonts** via a global RN `Text` patch synced to the active deck
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
App.tsx                  # root, mounts ConvexProvider + providers + navigation
convex/                  # backend
  schema.ts              # games, players, nightActions, nominationVotes, chat
  games.ts               # lobby, role reveal, end-game recap
  night.ts               # night engine: wake order, dwell, morning resolution
  day.ts                 # day clock, nominations, vote tally
  triggers.ts            # Hunter / Hunter Wolf / Mad Bomber death triggers
  chat.ts                # per-player chat channels + remote autopilot
  helpers.ts             # shared helpers + config defaults
src/
  screens/               # Home, PlayMenu, Create/Join, Lobby, RoleReveal,
                         # Night, Morning, Day, Triggers, EndGame,
                         # Clock (ModClock), Roles, Settings, Themes
  components/            # SeatingCircle, PhaseScreen, ThemedAlert, BuildModal,
                         # RoleCard, ConfirmOverlay, GraveyardModal, ChatPane,
                         # RemoteGameLayout, RolesBrowser, TimersConfigModal
  contexts/              # Theme, PlayerName, DevMode, RoleReveal, TimerDefaults
  theme/                 # per-theme font store + global Text patch
  data/
    roles.ts             # full ~140-role catalogue with descriptions
    v1Roles.ts           # 30-role playable roster + team helpers
    themeArt.ts          # per-deck role art (getDisplayArt)
    tableArt.ts          # per-deck seat avatars + day/night backdrops
    nightOrder.ts        # NIGHT_STEPS wake order
    roleValues.ts        # weighted balance values
  utils/preloadArt.ts    # warms image caches for the active deck
  hooks/useDeviceId.ts   # persistent device UUID for reconnect
  navigation/            # stack types
assets/
  images/                # logo, icon, splash, gifs
  table/{ghibli,chibi,16bit}/    # per-deck avatars + backdrops
  sounds/                # ModClock bell + gavel
roles_{ghibli,chibi,16bit}_medium/    # per-deck role card art (medium)
roles_{ghibli,chibi,16bit}_thumbs/    # per-deck role card art (thumbnails)
```

---

## Status

The multi-device build runs end-to-end: all 30 roles play including death-trigger cascades and the team-change / chained mechanics (Alpha Wolf, Doppelganger, Cursed, Sasquatch, Chupacabra, Leprechaun) that were once deferred. The day phase has configurable timers and sub-phase clocks, ghost-spectator mode is live, and end-game recap exists. Since then: full remote play with per-player chat, three art-and-font themes, and table gamification (seat avatars + day/night backdrops) have shipped. Open polish items:

- Disconnect / reconnect from cold app launch
- Host-claim flow for orphaned games
- Additional catalogue roles (still shown as locked "unlock to play")
- Looped night-path background animation

---

## License

Personal project. No license granted — please don't redistribute. Ultimate Werewolf is a trademark of Bezier Games; this is an unaffiliated companion app.
