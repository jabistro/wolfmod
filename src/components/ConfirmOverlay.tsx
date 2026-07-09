import React from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator } from 'react-native';

/**
 * Shared confirm popup for target pickers (night roles + the pregame
 * Doppelganger / Mama Wolf picks). Floats a wolf-surface card over the scene
 * with a transparent backdrop — NOT a full-screen blackout — so the table
 * stays visible behind it. Caller supplies the message as children; the NO /
 * YES buttons are built in.
 */
export function ConfirmOverlay({
  children,
  onCancel,
  onConfirm,
  submitting,
  confirmLabel = 'YES',
  cancelLabel = 'NO',
  confirmTone = 'accent',
}: {
  children: React.ReactNode;
  onCancel: () => void;
  onConfirm: () => void;
  submitting?: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 'accent' = gold YES (default); 'danger' = red YES for lethal actions. */
  confirmTone?: 'accent' | 'danger';
}) {
  const danger = confirmTone === 'danger';
  return (
    <View
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
        backgroundColor: 'transparent',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <View
        className="bg-wolf-surface rounded-3xl"
        style={{
          alignItems: 'center',
          alignSelf: 'center',
          maxWidth: 360,
          paddingTop: 26,
          paddingBottom: 22,
          paddingHorizontal: 26,
          borderWidth: 1,
          borderColor: '#2C2C3A',
        }}
      >
        {children}
        <View className="flex-row" style={{ gap: 14, marginTop: 24 }}>
          <TouchableOpacity
            onPress={onCancel}
            disabled={submitting}
            className="bg-wolf-card rounded-xl py-4 px-10"
            style={{ borderWidth: 1, borderColor: '#3A3A48' }}
          >
            <Text className="text-wolf-text text-base font-extrabold tracking-widest">
              {cancelLabel}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={onConfirm}
            disabled={submitting}
            style={{ opacity: submitting ? 0.4 : 1 }}
            className={`rounded-xl py-4 px-10 ${danger ? 'bg-wolf-red' : 'bg-wolf-accent'}`}
          >
            {submitting ? (
              <ActivityIndicator color={danger ? '#F0EDE8' : '#0F0F14'} />
            ) : (
              <Text
                className={`text-base font-extrabold tracking-widest ${danger ? 'text-wolf-text' : 'text-wolf-bg'}`}
              >
                {confirmLabel}
              </Text>
            )}
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}
