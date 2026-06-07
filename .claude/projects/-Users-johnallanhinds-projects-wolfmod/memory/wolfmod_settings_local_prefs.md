---
name: wolfmod-settings-local-prefs
description: Home Settings page local-device prefs (name, timer defaults, dev-mode toggle) + the DEV_FEATURES_AVAILABLE gate convention
metadata:
  type: project
---

The Home → SETTINGS page holds device-local preferences, each an AsyncStorage-backed React context wired as a provider in `App.tsx` (same shape as `ThemeContext`):
- `PlayerNameContext` (`wolfmod.playerName`) — prefills + auto-saves name on Create/Join.
- `TimerDefaultsContext` (`wolfmod.timerDefaults`) — seeds `createGame` timer args; shares stepper UI via `src/components/TimerSteppers.tsx` (`TIMER_DEFAULTS` must stay in sync with `DAY_CONFIG_DEFAULTS` in convex/helpers.ts).
- `DevModeContext` (`wolfmod.devModeEnabled`, default ON) — host toggle to hide lobby dev tools when playing for real.

**Dev-gate convention (added 2026-06-06):** the build-level gate is now the single const `DEV_FEATURES_AVAILABLE` in `src/config/devFlags.ts` (`__DEV__ || EXPO_PUBLIC_ALLOW_BOTS === 'true'`). Do NOT re-inline that raw expression. Lobby dev tools (FILL EMPTY SEATS, ASSIGN ROLES) render on `showDevTools = DEV_FEATURES_AVAILABLE && devModeEnabled`. The DEVELOPER MODE Switch in Settings only renders when `DEV_FEATURES_AVAILABLE` (invisible in real release builds). See [[wolfmod-dev-role-pins]] and [[wolfmod-two-phone-playtest]].
