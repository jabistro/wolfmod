import { Asset } from 'expo-asset';
import { Image } from 'expo-image';
import { ROLES } from '../data/roles';
import { getDisplayArt, type Theme } from '../data/themeArt';
import { getTableArt } from '../data/tableArt';

// Warm the image caches for a deck's art before the user ever navigates to it,
// so screens render instantly instead of showing the first-mount fetch/decode
// lag. Two passes per asset:
//   1. Asset.downloadAsync — resolves the module to a local file (in Expo Go
//      this is the Metro round-trip that causes most of the visible lag).
//   2. Image.prefetch — warms expo-image's own memory+disk cache (incl. decode)
//      so the <Image> components used across the app hit a warm cache on mount.
// Fire-and-forget; the splash animation covers the initial warm.

// Shared UI art that isn't theme-scoped.
const SHARED: ReturnType<typeof require>[] = [
  require('../../assets/images/wolfmod_logo.png'),
  require('../../assets/images/build.png'),
];

function modulesForTheme(theme: Theme): ReturnType<typeof require>[] {
  const set = new Set<ReturnType<typeof require>>();

  // Every role's display art for this deck (thumb + medium). getDisplayArt
  // collapses non-V1 roles to the locked "unlock to play" art, so the set
  // naturally de-dupes down to just the deck's real images plus locked art.
  for (const role of ROLES) {
    const art = getDisplayArt(role.name, theme);
    set.add(art.image);
    set.add(art.thumb);
  }

  // Table art: seat avatars (day + night) and every full-screen backdrop.
  const table = getTableArt(theme);
  [
    table.avatar,
    table.avatarNight,
    table.backdropDay,
    table.backdropNight,
    table.home,
    table.createJoin,
    table.lobby,
  ].forEach(m => set.add(m));

  SHARED.forEach(m => set.add(m));

  return [...set];
}

// One in-flight promise per theme so repeated calls (e.g. a theme-change effect
// firing twice) coalesce instead of re-warming.
const inFlight: Partial<Record<Theme, Promise<void>>> = {};

export function preloadArt(theme: Theme): Promise<void> {
  const existing = inFlight[theme];
  if (existing) return existing;

  const p = (async () => {
    const assets = modulesForTheme(theme).map(m => Asset.fromModule(m));
    await Promise.all(assets.map(a => a.downloadAsync().catch(() => {})));
    const uris = assets
      .map(a => a.localUri ?? a.uri)
      .filter((u): u is string => !!u);
    try {
      await Image.prefetch(uris, 'memory-disk');
    } catch {
      // Prefetch is best-effort — a miss just means the old lazy-load path.
    }
  })();

  inFlight[theme] = p;
  return p;
}
