import { useEffect } from 'react';
import { BackHandler } from 'react-native';

/**
 * Run `handler` on Android hardware back press while this screen is mounted.
 * `<Modal>` components handle back independently via `onRequestClose`, so this
 * fires only when no modal is open.
 *
 * Return `true` from the handler to suppress the default goBack; `false` to
 * fall through.
 */
export function useAndroidBack(handler: () => boolean) {
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', handler);
    return () => sub.remove();
  }, [handler]);
}
