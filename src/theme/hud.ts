/**
 * Shared styling for HUD/chrome that floats directly over the full-screen
 * phase scenery (PhaseScreen). Plain dark text vanishes on the bright day
 * meadow, so scene-level text uses a brightened tone + a soft drop shadow
 * that keeps it legible over both the day and night backdrops.
 */

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
