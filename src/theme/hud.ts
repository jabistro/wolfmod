import { Dimensions } from 'react-native';

/**
 * Shared styling for HUD/chrome that floats directly over the full-screen
 * phase scenery (PhaseScreen). Plain dark text vanishes on the bright day
 * meadow, so scene-level text uses a brightened tone + a soft drop shadow
 * that keeps it legible over both the day and night backdrops.
 */

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

/** Seating-ring diameter, shared by the day phase and every night picker. */
export const RING_SIZE = Math.min(320, SCREEN_W - 32);

/**
 * The seating ring's vertical center, measured as a distance up from the
 * bottom of the screen. The day phase and all night pickers position the ring
 * ABSOLUTELY at this exact spot (see `ringAnchorStyle`), so it occupies the
 * same on-screen coordinates on every screen — no jump moving between day,
 * night, and the various pickers, regardless of how much other chrome each
 * screen shows. Tune this one number to raise/lower the ring everywhere.
 */
export const RING_CENTER_FROM_BOTTOM = Math.round(SCREEN_H * 0.33);

/** Distance from the screen bottom to the ring's bottom edge. */
export const RING_BOTTOM_EDGE = RING_CENTER_FROM_BOTTOM - RING_SIZE / 2;

/**
 * Absolute style that pins a RING_SIZE-tall ring so its center sits at
 * RING_CENTER_FROM_BOTTOM. Apply to the ring's wrapper; the wrapper's parent
 * must reach the bottom of the screen (true for both PhaseScreen bodies).
 */
export const ringAnchorStyle = {
  position: 'absolute' as const,
  left: 0,
  right: 0,
  bottom: RING_BOTTOM_EDGE,
  alignItems: 'center' as const,
};

/** Drop shadow for any text laid directly over the scene (no panel behind). */
export const SCENE_TEXT_SHADOW = {
  textShadowColor: 'rgba(0, 0, 0, 0.95)',
  textShadowOffset: { width: 0, height: 2 },
  textShadowRadius: 9,
} as const;

/** Brightened replacement for `wolf-muted` on chrome that sits over scenery. */
export const HUD_CHROME = '#DAD6CE';

/**
 * Drop shadow for image-based chrome over the scene (the BUILD icon). Images
 * can't use `textShadow*`, so the caller stacks a dark, offset copy of the
 * image behind the real one — these are the offset/tint for that copy. Mirrors
 * the SCENE_TEXT_SHADOW look so icons read the same as the scene text.
 */
export const SCENE_ICON_SHADOW = {
  position: 'absolute' as const,
  top: 2,
  left: 1,
  tintColor: '#000',
  opacity: 0.6,
};
