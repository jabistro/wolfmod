import React from 'react';
import { View, Text, Modal, TouchableOpacity, ActivityIndicator } from 'react-native';

export type MasonReveal =
  | { kind: 'became'; allies: Array<{ name: string }> }
  | { kind: 'joined'; joinedName: string };

/**
 * Mason secret-society induction reveal. Shown when a Doppelganger inherits
 * the Mason role:
 *   - `became` : to the new Mason themselves, listing their living fellow
 *                Masons (or noting they're alone).
 *   - `joined` : to each existing Mason, naming the new member.
 *
 * Persistent + self-acked by design — it stays up until the player taps OK
 * (the server clears the flag, which hides it), so a brief look-away can't
 * make them miss it. It never gates the night; other players don't wait on
 * the ack. Rendered on both the Night and Morning screens so an end-of-night
 * reveal is still caught in the morning. See `submitMasonAck` / the
 * `masonRevealState` views in convex/night.ts.
 */
export function MasonRevealModal({
  state,
  onAck,
  submitting,
}: {
  state: MasonReveal | null;
  onAck: () => void;
  submitting: boolean;
}) {
  return (
    <Modal visible={!!state} transparent animationType="fade">
      <View className="flex-1 bg-wolf-bg items-center justify-center px-6">
        {state?.kind === 'joined' ? (
          <>
            <Text className="text-wolf-muted text-xs font-bold tracking-widest text-center mb-6">
              A NEW MASON
            </Text>
            <View
              className="bg-wolf-card rounded-2xl px-6 py-6"
              style={{ maxWidth: 360 }}
            >
              <Text className="text-wolf-text text-base leading-6 text-center">
                <Text className="text-wolf-accent font-extrabold">
                  {state.joinedName.toUpperCase()}
                </Text>
                {' has joined the Masons. They are one of you now.'}
              </Text>
            </View>
          </>
        ) : state?.kind === 'became' ? (
          <>
            <Text className="text-wolf-muted text-xs font-bold tracking-widest text-center mb-6">
              A SECRET SOCIETY
            </Text>
            <View
              className="bg-wolf-card rounded-2xl px-6 py-6"
              style={{ maxWidth: 360 }}
            >
              <Text className="text-wolf-text text-base leading-6 text-center">
                {'Your target has fallen. You are now a '}
                <Text className="text-wolf-accent font-extrabold">MASON</Text>
                {'.'}
              </Text>
              <View className="mt-5">
                <Text className="text-wolf-muted text-xs font-bold tracking-widest text-center mb-2">
                  FELLOW MASONS
                </Text>
                {state.allies.length > 0 ? (
                  state.allies.map(m => (
                    <Text
                      key={m.name}
                      className="text-wolf-accent text-base font-extrabold text-center"
                    >
                      {m.name}
                    </Text>
                  ))
                ) : (
                  <Text className="text-wolf-muted text-sm text-center">
                    No other Masons remain. You keep the secret alone.
                  </Text>
                )}
              </View>
            </View>
          </>
        ) : null}

        <TouchableOpacity
          onPress={onAck}
          disabled={submitting}
          style={{ opacity: submitting ? 0.4 : 1, marginTop: 36, minWidth: 200 }}
          className="bg-wolf-accent rounded-xl py-4 items-center"
        >
          {submitting ? (
            <ActivityIndicator color="#0F0F14" />
          ) : (
            <Text className="text-wolf-bg text-base font-extrabold tracking-widest">
              OK
            </Text>
          )}
        </TouchableOpacity>
      </View>
    </Modal>
  );
}
