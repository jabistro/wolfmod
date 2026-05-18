import React, { useEffect, useState } from 'react';
import { Modal, Pressable, Text, TouchableOpacity, View } from 'react-native';

export type ThemedAlertButtonStyle = 'default' | 'cancel' | 'destructive';

export type ThemedAlertButton = {
  text: string;
  onPress?: () => void;
  style?: ThemedAlertButtonStyle;
};

type AlertPayload = {
  id: number;
  title: string;
  message?: string;
  buttons: ThemedAlertButton[];
};

type Listener = (queue: AlertPayload[]) => void;

let nextId = 1;
let queue: AlertPayload[] = [];
const listeners = new Set<Listener>();

function emit() {
  for (const l of listeners) l(queue);
}

export function showAlert(
  title: string,
  message?: string,
  buttons?: ThemedAlertButton[],
) {
  queue = [
    ...queue,
    {
      id: nextId++,
      title,
      message,
      buttons: buttons && buttons.length > 0 ? buttons : [{ text: 'OK' }],
    },
  ];
  emit();
}

export function AlertHost() {
  const [items, setItems] = useState<AlertPayload[]>(queue);

  useEffect(() => {
    const l: Listener = q => setItems([...q]);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);

  const current = items[0];

  function dismiss(btn?: ThemedAlertButton) {
    queue = queue.slice(1);
    emit();
    btn?.onPress?.();
  }

  function handleBackdropPress() {
    if (!current) return;
    const cancel = current.buttons.find(b => b.style === 'cancel');
    if (cancel) dismiss(cancel);
  }

  // Cancel-styled buttons render as a plain text link at the bottom.
  // Everything else stacks as a wolf-card pill.
  const cancelBtn = current?.buttons.find(b => b.style === 'cancel');
  const cardBtns = current?.buttons.filter(b => b.style !== 'cancel') ?? [];

  return (
    <Modal
      visible={!!current}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={() => {
        if (!current) return;
        dismiss(cancelBtn ?? current.buttons[0]);
      }}
    >
      <Pressable
        onPress={handleBackdropPress}
        style={{
          flex: 1,
          backgroundColor: 'rgba(0,0,0,0.85)',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
        }}
      >
        {current && (
          <Pressable
            onPress={e => e.stopPropagation()}
            className="bg-wolf-surface rounded-2xl w-full p-6"
            style={{ maxWidth: 420 }}
          >
            <Text className="text-wolf-text text-lg font-bold mb-3 text-center">
              {current.title}
            </Text>
            {current.message ? (
              <Text className="text-wolf-muted text-sm text-center mb-4">
                {current.message}
              </Text>
            ) : null}

            {cardBtns.map((btn, i) => (
              <TouchableOpacity
                key={`${btn.text}-${i}`}
                onPress={() => dismiss(btn)}
                className={`bg-wolf-card rounded-xl py-3 ${i > 0 ? 'mt-2' : ''}`}
              >
                <Text
                  className={`text-center font-bold ${
                    btn.style === 'destructive' ? 'text-wolf-red' : 'text-wolf-text'
                  }`}
                >
                  {btn.text}
                </Text>
              </TouchableOpacity>
            ))}

            {cancelBtn && (
              <TouchableOpacity
                onPress={() => dismiss(cancelBtn)}
                className="mt-3 py-2"
              >
                <Text className="text-wolf-muted text-center">
                  {cancelBtn.text}
                </Text>
              </TouchableOpacity>
            )}
          </Pressable>
        )}
      </Pressable>
    </Modal>
  );
}
