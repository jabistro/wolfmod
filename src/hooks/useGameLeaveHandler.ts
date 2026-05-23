import { useCallback } from 'react';
import { useNavigation } from '@react-navigation/native';
import { useMutation } from 'convex/react';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import { showAlert } from '../components/ThemedAlert';
import { useAndroidBack } from './useAndroidBack';

type Params = {
  gameId: Id<'games'>;
  deviceClientId: string | null;
  isHost?: boolean;
  /** Override the body copy (e.g. EndGame, lobby, host-with-pass-option). */
  message?: string;
  /**
   * When provided AND `isHost` is true, the leave modal adds a "Pass host
   * first…" button. The caller is responsible for opening a player picker
   * (e.g. <PassHostPickerModal>) in response.
   */
  onPassHostFirst?: () => void;
};

/**
 * Wires the in-game LEAVE button and Android hardware-back to a single
 * confirmation flow. The player's record is kept on the server (mid-game
 * leave is a no-op for non-hosts), so they can rejoin via the Join Game
 * screen while the game is still going.
 */
export function useGameLeaveHandler({
  gameId,
  deviceClientId,
  isHost,
  message,
  onPassHostFirst,
}: Params) {
  const navigation = useNavigation<any>();
  const leaveGame = useMutation(api.games.leaveGame);

  const confirmLeave = useCallback(() => {
    const defaultMsg = isHost
      ? "You're the host. Other players will be able to claim host once you leave. You can rejoin later."
      : "You can rejoin the game while it's still going.";
    const buttons: Parameters<typeof showAlert>[2] = [
      { text: 'Cancel', style: 'cancel' },
    ];
    if (isHost && onPassHostFirst) {
      buttons.push({
        text: 'Pass host first…',
        onPress: onPassHostFirst,
      });
    }
    buttons.push({
      text: 'Leave',
      style: 'destructive',
      onPress: async () => {
        if (!deviceClientId) return;
        try {
          await leaveGame({ gameId, callerDeviceClientId: deviceClientId });
          navigation.popToTop();
        } catch (e) {
          showAlert('Error', e instanceof Error ? e.message : String(e));
        }
      },
    });
    showAlert('Leave game?', message ?? defaultMsg, buttons);
  }, [
    gameId,
    deviceClientId,
    isHost,
    message,
    onPassHostFirst,
    leaveGame,
    navigation,
  ]);

  useAndroidBack(
    useCallback(() => {
      confirmLeave();
      return true;
    }, [confirmLeave]),
  );

  return { confirmLeave };
}
