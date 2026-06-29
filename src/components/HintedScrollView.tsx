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
  type ViewStyle,
} from 'react-native';

/**
 * Drop-in replacement for ScrollView that floats a fading down-chevron over
 * the bottom edge whenever there's still content below the fold — so a tall
 * list (e.g. the settings menu) reads as scrollable instead of looking like
 * the visible rows are all there is. The hint fades out the moment the user
 * reaches the end, confirming they've seen everything.
 *
 * Forwards all ScrollView props (style, contentContainerStyle, children, …).
 * The arrow is pointerEvents="none" so taps still reach the rows beneath it.
 */

// How close to the bottom (px) counts as "at the end" — also the minimum
// overflow before the hint is worth showing at all.
const END_SLOP = 24;

type Props = ScrollViewProps & {
  /** Chevron tint. Defaults to the gold accent. */
  hintColor?: string;
  /** Extra offset (px) lifting the arrow off the bottom edge. */
  hintBottomOffset?: number;
};

export default function HintedScrollView({
  children,
  onScroll,
  onLayout,
  onContentSizeChange,
  hintColor = '#D4A017',
  hintBottomOffset = 8,
  ...rest
}: Props) {
  const opacity = useRef(new Animated.Value(0)).current;
  const bob = useRef(new Animated.Value(0)).current;
  const viewportH = useRef(0);
  const contentH = useRef(0);
  const shown = useRef(false);
  const looping = useRef(false);

  function setShown(next: boolean) {
    if (next === shown.current) return;
    shown.current = next;
    Animated.timing(opacity, {
      toValue: next ? 1 : 0,
      duration: 180,
      useNativeDriver: true,
    }).start();
    // Start a gentle continuous bob the first time the hint appears; it reads
    // as "scroll down" far better than a static arrow. Runs natively, so it's
    // free while hidden (opacity 0).
    if (next && !looping.current) {
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
  }

  function recompute(scrollY: number) {
    const overflow = contentH.current - viewportH.current;
    if (overflow <= END_SLOP) {
      setShown(false);
      return;
    }
    setShown(overflow - scrollY > END_SLOP);
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

  const arrowWrap: ViewStyle = {
    position: 'absolute',
    bottom: hintBottomOffset,
    left: 0,
    right: 0,
    alignItems: 'center',
  };

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
      <Animated.View
        pointerEvents="none"
        style={[
          arrowWrap,
          { opacity, transform: [{ translateY: bob.interpolate({ inputRange: [0, 1], outputRange: [0, 4] }) }] },
        ]}
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
              color: hintColor,
              fontSize: 13,
              lineHeight: 14,
              marginTop: -1,
              includeFontPadding: false,
            }}
          >
            ▼
          </Text>
        </View>
      </Animated.View>
    </View>
  );
}
