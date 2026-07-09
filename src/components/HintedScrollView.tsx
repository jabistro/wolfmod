import React, { useRef } from 'react';
import {
  ScrollView,
  Animated,
  View,
  Text,
  type ScrollViewProps,
  type NativeSyntheticEvent,
  type NativeScrollEvent,
  type LayoutChangeEvent,
} from 'react-native';

/**
 * Drop-in replacement for ScrollView that floats fading chevrons over the
 * edges whenever there's still content out of view — a down-chevron at the
 * bottom while more remains below the fold, and an up-chevron at the top once
 * the user has scrolled past the start. So a tall list (e.g. the settings menu
 * or the BUILD role list) reads as scrollable instead of looking like the
 * visible rows are all there is; each hint fades out the moment that edge is
 * reached, confirming there's nothing more that way.
 *
 * Forwards all ScrollView props (style, contentContainerStyle, children, …).
 * The arrows are pointerEvents="none" so taps still reach the rows beneath.
 */

// How close to an edge (px) counts as "at that end" — also the minimum
// overflow before a hint is worth showing at all.
const END_SLOP = 24;

type Props = ScrollViewProps & {
  /** Chevron tint. Defaults to the gold accent. */
  hintColor?: string;
  /** Extra offset (px) lifting the down-arrow off the bottom edge. */
  hintBottomOffset?: number;
  /** Extra offset (px) dropping the up-arrow below the top edge. */
  hintTopOffset?: number;
};

export default function HintedScrollView({
  children,
  onScroll,
  onLayout,
  onContentSizeChange,
  hintColor = '#D4A017',
  hintBottomOffset = 8,
  hintTopOffset = 8,
  ...rest
}: Props) {
  const downOpacity = useRef(new Animated.Value(0)).current;
  const upOpacity = useRef(new Animated.Value(0)).current;
  const bob = useRef(new Animated.Value(0)).current;
  const viewportH = useRef(0);
  const contentH = useRef(0);
  const shownDown = useRef(false);
  const shownUp = useRef(false);
  const looping = useRef(false);

  // A gentle continuous bob reads as "scroll this way" far better than a static
  // arrow. Shared by both carets (down bobs +4, up bobs −4); starts the first
  // time either hint appears. Runs natively, so it's free while hidden.
  function startBob() {
    if (looping.current) return;
    looping.current = true;
    Animated.loop(
      Animated.sequence([
        Animated.timing(bob, {
          toValue: 1,
          duration: 650,
          useNativeDriver: true,
        }),
        Animated.timing(bob, {
          toValue: 0,
          duration: 650,
          useNativeDriver: true,
        }),
      ]),
    ).start();
  }

  function setShown(
    ref: React.MutableRefObject<boolean>,
    opacity: Animated.Value,
    next: boolean,
  ) {
    if (next === ref.current) return;
    ref.current = next;
    Animated.timing(opacity, {
      toValue: next ? 1 : 0,
      duration: 180,
      useNativeDriver: true,
    }).start();
    if (next) startBob();
  }

  function recompute(scrollY: number) {
    const overflow = contentH.current - viewportH.current;
    if (overflow <= END_SLOP) {
      setShown(shownDown, downOpacity, false);
      setShown(shownUp, upOpacity, false);
      return;
    }
    setShown(shownDown, downOpacity, overflow - scrollY > END_SLOP);
    setShown(shownUp, upOpacity, scrollY > END_SLOP);
  }

  function handleScroll(e: NativeSyntheticEvent<NativeScrollEvent>) {
    recompute(e.nativeEvent.contentOffset.y);
    onScroll?.(e);
  }
  function handleLayout(e: LayoutChangeEvent) {
    viewportH.current = e.nativeEvent.layout.height;
    recompute(0);
    onLayout?.(e);
  }
  function handleContentSize(w: number, h: number) {
    contentH.current = h;
    recompute(0);
    onContentSizeChange?.(w, h);
  }

  return (
    <View style={{ position: 'relative' }}>
      <ScrollView
        {...rest}
        scrollEventThrottle={16}
        onScroll={handleScroll}
        onLayout={handleLayout}
        onContentSizeChange={handleContentSize}
      >
        {children}
      </ScrollView>
      <Caret
        glyph="▲"
        color={hintColor}
        opacity={upOpacity}
        translateY={bob.interpolate({ inputRange: [0, 1], outputRange: [0, -4] })}
        edge={{ top: hintTopOffset }}
      />
      <Caret
        glyph="▼"
        color={hintColor}
        opacity={downOpacity}
        translateY={bob.interpolate({ inputRange: [0, 1], outputRange: [0, 4] })}
        edge={{ bottom: hintBottomOffset }}
      />
    </View>
  );
}

function Caret({
  glyph,
  color,
  opacity,
  translateY,
  edge,
}: {
  glyph: string;
  color: string;
  opacity: Animated.Value;
  translateY: Animated.AnimatedInterpolation<number>;
  edge: { top: number } | { bottom: number };
}) {
  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        alignItems: 'center',
        opacity,
        transform: [{ translateY }],
        ...edge,
      }}
    >
      <View
        style={{
          width: 34,
          height: 22,
          borderRadius: 11,
          backgroundColor: 'rgba(26, 26, 36, 0.92)',
          borderWidth: 1,
          borderColor: '#2A2A38',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text
          style={{
            color,
            fontSize: 13,
            lineHeight: 14,
            marginTop: -1,
            includeFontPadding: false,
          }}
        >
          {glyph}
        </Text>
      </View>
    </Animated.View>
  );
}
