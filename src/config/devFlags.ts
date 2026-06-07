// True when this build is allowed to expose host-only dev/playtest tools
// (FILL EMPTY SEATS, ASSIGN ROLES). Local dev always qualifies; EAS playtest
// builds opt in via EXPO_PUBLIC_ALLOW_BOTS. Real release builds leave that env
// var unset, so the tools — and the Settings toggle that hides them — never
// appear. These are build-time constants, so this resolves once at bundle time.
export const DEV_FEATURES_AVAILABLE =
  __DEV__ || process.env.EXPO_PUBLIC_ALLOW_BOTS === 'true';
