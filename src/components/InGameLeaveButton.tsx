import React from 'react';
import { TouchableOpacity, Text } from 'react-native';

/**
 * Top-left LEAVE button for in-game screens. Position is absolute so it
 * overlays whatever header each screen already has without disturbing the
 * existing layout.
 */
export function InGameLeaveButton({ onPress }: { onPress: () => void }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      hitSlop={8}
      style={{
        position: 'absolute',
        left: 8,
        top: 40,
        padding: 8,
        zIndex: 10,
      }}
    >
      <Text
        style={{
          color: '#8A8590',
          fontSize: 12,
          fontWeight: '700',
          letterSpacing: 2,
        }}
      >
        LEAVE
      </Text>
    </TouchableOpacity>
  );
}
