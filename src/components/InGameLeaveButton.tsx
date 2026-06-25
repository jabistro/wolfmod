import React from 'react';
import { TouchableOpacity, Text } from 'react-native';
import { SCENE_TEXT_SHADOW, HUD_CHROME } from '../theme/hud';

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
          color: HUD_CHROME,
          fontSize: 12,
          fontWeight: '700',
          letterSpacing: 2,
          ...SCENE_TEXT_SHADOW,
        }}
      >
        LEAVE
      </Text>
    </TouchableOpacity>
  );
}
