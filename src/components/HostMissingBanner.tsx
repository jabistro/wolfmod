import React, { useState } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator } from 'react-native';
import { useMutation } from 'convex/react';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import { showAlert } from './ThemedAlert';

type Props = {
  gameId: Id<'games'>;
  deviceClientId: string;
};

/**
 * Shown across the top of every in-game screen when no player holds the
 * host role (host explicitly left, or the only host is dead). Any human
 * player — alive or eliminated — can tap to claim host.
 */
export function HostMissingBanner({ gameId, deviceClientId }: Props) {
  const claimHost = useMutation(api.games.claimHost);
  const [busy, setBusy] = useState(false);

  async function handleClaim() {
    setBusy(true);
    try {
      await claimHost({ gameId, callerDeviceClientId: deviceClientId });
    } catch (e) {
      showAlert(
        'Could not claim host',
        e instanceof Error ? e.message : String(e),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <TouchableOpacity
      onPress={handleClaim}
      disabled={busy}
      style={{
        backgroundColor: '#3A1F1F',
        paddingVertical: 10,
        paddingHorizontal: 16,
        marginHorizontal: 16,
        marginBottom: 8,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: '#B03A2E',
        opacity: busy ? 0.5 : 1,
      }}
    >
      {busy ? (
        <ActivityIndicator color="#D4A017" />
      ) : (
        <>
          <Text
            style={{
              color: '#F0EDE8',
              fontSize: 13,
              fontWeight: '700',
              letterSpacing: 1.5,
              textAlign: 'center',
            }}
          >
            HOST HAS LEFT
          </Text>
          <Text
            style={{
              color: '#D4A017',
              fontSize: 11,
              fontWeight: '700',
              letterSpacing: 2,
              textAlign: 'center',
              marginTop: 2,
            }}
          >
            TAP TO CLAIM HOST
          </Text>
        </>
      )}
    </TouchableOpacity>
  );
}
