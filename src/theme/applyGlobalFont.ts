import { createElement, forwardRef, useSyncExternalStore } from 'react';
import { StyleSheet } from 'react-native';
import { cssInterop } from 'nativewind';
import {
  familyForWeight,
  FONT_SCALE,
  getFontTheme,
  subscribeFontTheme,
} from './fonts';

/**
 * Roll the themed fonts across the whole app without editing hundreds of call
 * sites. Imported once (for its side effect) at app startup.
 *
 * How it works on RN 0.83 / React 19 + NativeWind v4:
 *  - `import { Text } from 'react-native'` compiles (Metro/Babel CommonJS) to a
 *    plain `require('react-native')` plus a `.Text` property read at each use.
 *    So we patch that exact object — `require('react-native')` — whose `Text`
 *    and `TextInput` are configurable getters. We capture the real components,
 *    wrap them to inject the current theme's font family (chosen from the
 *    resolved fontWeight), then redefine the getters to return the wrappers.
 *    Every screen reads the getter at render time and picks up the wrapper.
 *
 *    (NOTE: patching the `import * as` wildcard namespace does NOT work — Babel
 *    builds a *copy* of the module for wildcard imports, which named imports
 *    never read from.)
 *  - `className` still works: each wrapper is registered with NativeWind's
 *    `cssInterop`, so className -> style happens before our wrapper runs.
 *  - Text that sets an explicit `fontFamily` (e.g. the home-screen wordmark) is
 *    passed through untouched.
 *  - Under the 16bit theme, font sizes are scaled down (see FONT_SCALE) so the
 *    wide pixel font doesn't blow out layouts.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const RN = require('react-native') as any;

// Guard so Fast Refresh (module re-eval in the same JS context) doesn't
// re-capture the already-wrapped Text and double-wrap / recurse.
if (!RN.__wolfFontPatched) {
  RN.__wolfFontPatched = true;

  // Capture the originals BEFORE overriding the getters.
  const OriginalText = RN.Text;
  const OriginalTextInput = RN.TextInput;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const themedStyle = (style: any) => {
    const flat = StyleSheet.flatten(style) || {};
    // Respect explicit font choices.
    if (flat.fontFamily) return style;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const override: any = {
      fontFamily: familyForWeight(flat.fontWeight),
      // With per-weight family names, leaving these on would trigger Android
      // faux-bold/italic on top of the already-weighted family.
      fontWeight: undefined,
      fontStyle: undefined,
    };

    // Kill Android's metric-derived font padding app-wide. Our pixel/rounded
    // fonts ride high in a tall line box, so the default padding pushes text
    // off-center inside circles, pills, and fixed-height rows. Only set it when
    // a call site hasn't chosen its own value.
    if (flat.includeFontPadding === undefined) {
      override.includeFontPadding = false;
    }

    const scale = FONT_SCALE[getFontTheme()] ?? 1;
    if (scale !== 1) {
      const base = typeof flat.fontSize === 'number' ? flat.fontSize : 14;
      override.fontSize = base * scale;
    }

    return [style, override];
  };

  // Subscribing to the font-theme store re-renders every Text/TextInput the
  // instant the theme changes — no matter which screen it's on — so the whole
  // app repaints its fonts at once instead of only on screens that happen to
  // re-render for another reason.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ThemedText = forwardRef<any, any>((props, ref) => {
    useSyncExternalStore(subscribeFontTheme, getFontTheme);
    return createElement(OriginalText, { ...props, ref, style: themedStyle(props.style) });
  });
  ThemedText.displayName = 'ThemedText';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ThemedTextInput = forwardRef<any, any>((props, ref) => {
    useSyncExternalStore(subscribeFontTheme, getFontTheme);
    return createElement(OriginalTextInput, { ...props, ref, style: themedStyle(props.style) });
  });
  ThemedTextInput.displayName = 'ThemedTextInput';

  // Keep NativeWind's className -> style mapping working for the wrappers.
  cssInterop(ThemedText, { className: 'style' });
  cssInterop(ThemedTextInput, { className: 'style' });

  const overrideGetter = (target: object, key: string, value: unknown) => {
    const desc = Object.getOwnPropertyDescriptor(target, key);
    if (desc && desc.configurable === false) return; // can't patch; bail safely
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: true,
      get: () => value,
    });
  };

  overrideGetter(RN, 'Text', ThemedText);
  overrideGetter(RN, 'TextInput', ThemedTextInput);
}
