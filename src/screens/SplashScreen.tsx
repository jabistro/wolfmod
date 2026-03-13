import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet } from 'react-native';

interface Props {
  onDone: () => void;
}

export default function SplashScreen({ onDone }: Props) {
  const spinValue = useRef(new Animated.Value(0)).current;
  const scaleValue = useRef(new Animated.Value(1)).current;
  const fadeValue = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    Animated.sequence([
      // Spin 3 full rotations continuously while scale peaks and returns
      Animated.parallel([
        Animated.timing(spinValue, {
          toValue: 3,
          duration: 2500,
          useNativeDriver: true,
        }),
        Animated.sequence([
          Animated.timing(scaleValue, {
            toValue: 1.5,
            duration: 1250,
            useNativeDriver: true,
          }),
          Animated.timing(scaleValue, {
            toValue: 1,
            duration: 1250,
            useNativeDriver: true,
          }),
        ]),
      ]),
      // Brief pause at normal size
      Animated.delay(500),
      // Fade out
      Animated.timing(fadeValue, {
        toValue: 0,
        duration: 400,
        useNativeDriver: true,
      }),
    ]).start(() => onDone());
  }, []);

  const spin = spinValue.interpolate({
    inputRange: [0, 3],
    outputRange: ['0deg', '1080deg'],
  });

  return (
    <Animated.View style={[styles.container, { opacity: fadeValue }]}>
      <Animated.Image
        source={require('../../assets/images/wolfmod_logo.png')}
        style={[styles.logo, { transform: [{ rotate: spin }, { scale: scaleValue }] }]}
        resizeMode="contain"
      />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#0F0F14',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 999,
  },
  logo: {
    width: 160,
    height: 160,
  },
});
