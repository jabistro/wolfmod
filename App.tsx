import './global.css';
import './src/theme/applyGlobalFont';
import { useState, type ComponentType } from 'react';
import { LogBox } from 'react-native';
import { useFonts } from 'expo-font';
import {
  Quicksand_400Regular,
  Quicksand_500Medium,
  Quicksand_600SemiBold,
  Quicksand_700Bold,
} from '@expo-google-fonts/quicksand';
import {
  Baloo2_400Regular,
  Baloo2_500Medium,
  Baloo2_600SemiBold,
  Baloo2_700Bold,
  Baloo2_800ExtraBold,
} from '@expo-google-fonts/baloo-2';
import { PressStart2P_400Regular } from '@expo-google-fonts/press-start-2p';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer, DefaultTheme, useRoute } from '@react-navigation/native';
import { createStackNavigator } from '@react-navigation/stack';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ConvexProvider, ConvexReactClient, useQuery } from 'convex/react';

// Convex's client always logs mutation/query failures via console.error, which surfaces
// as a dev-only LogBox toast even when the screen has already handled the error inline.
LogBox.ignoreLogs([/^\[CONVEX /]);
import HomeScreen from './src/screens/HomeScreen';
import RolesScreen from './src/screens/RolesScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import ThemesScreen from './src/screens/ThemesScreen';
import TimerDefaultsScreen from './src/screens/TimerDefaultsScreen';
import ClockSetupScreen from './src/screens/ClockSetupScreen';
import ClockScreen from './src/screens/ClockScreen';
import SplashScreen from './src/screens/SplashScreen';
import PlayMenuScreen from './src/screens/PlayMenuScreen';
import CreateGameScreen from './src/screens/CreateGameScreen';
import JoinGameScreen from './src/screens/JoinGameScreen';
import LobbyScreen from './src/screens/LobbyScreen';
import RoleRevealScreen from './src/screens/RoleRevealScreen';
import NightScreen from './src/screens/NightScreen';
import TriggersScreen from './src/screens/TriggersScreen';
import MorningScreen from './src/screens/MorningScreen';
import DayScreen from './src/screens/DayScreen';
import EndGameScreen from './src/screens/EndGameScreen';
import { AlertHost } from './src/components/ThemedAlert';
import RemoteGameLayout from './src/components/RemoteGameLayout';
import { useDeviceId } from './src/hooks/useDeviceId';
import { api } from './convex/_generated/api';
import type { Id } from './convex/_generated/dataModel';
import { ThemeProvider } from './src/contexts/ThemeContext';
import { TimerDefaultsProvider } from './src/contexts/TimerDefaultsContext';
import { PlayerNameProvider } from './src/contexts/PlayerNameContext';
import { DevModeProvider } from './src/contexts/DevModeContext';
import { RoleRevealProvider } from './src/contexts/RoleRevealContext';
import type { RootStackParamList } from './src/navigation/types';

const Stack = createStackNavigator<RootStackParamList>();

/**
 * Navigation-level wrapper: for any in-game screen whose route carries a
 * `gameId`, dock the remote chat pane below it (a no-op for local games —
 * see RemoteGameLayout). Wrapping here keeps the individual screens, with
 * their many early-return branches, completely untouched.
 */
function withRemoteChat<P extends object>(
  Screen: ComponentType<P>,
): ComponentType<P> {
  return function RemoteChatWrapped(props: P) {
    const route = useRoute();
    const gameId = (route.params as { gameId?: string } | undefined)?.gameId as
      | Id<'games'>
      | undefined;
    const deviceClientId = useDeviceId();
    const mode = useQuery(api.games.gameMode, gameId ? { gameId } : 'skip');
    if (!gameId) return <Screen {...props} />;
    return (
      <RemoteGameLayout
        gameId={gameId}
        deviceClientId={deviceClientId}
        mode={mode ?? undefined}
      >
        <Screen {...props} />
      </RemoteGameLayout>
    );
  };
}

// Wrapped once at module scope so the component identity is stable across
// renders (inline wrapping would remount the screen every render).
const LobbyWithChat = withRemoteChat(LobbyScreen);
const NightWithChat = withRemoteChat(NightScreen);
const TriggersWithChat = withRemoteChat(TriggersScreen);
const MorningWithChat = withRemoteChat(MorningScreen);
const DayWithChat = withRemoteChat(DayScreen);
const EndGameWithChat = withRemoteChat(EndGameScreen);

const AppTheme = {
  ...DefaultTheme,
  colors: { ...DefaultTheme.colors, background: '#0F0F14' },
};

const convexUrl = process.env.EXPO_PUBLIC_CONVEX_URL;
if (!convexUrl) {
  // Surface the misconfiguration immediately rather than silently failing inside Convex hooks.
  // Set EXPO_PUBLIC_CONVEX_URL in `.env.local` (created automatically by `npx convex dev`).
  throw new Error(
    'EXPO_PUBLIC_CONVEX_URL is not set. Run `npx convex dev` to provision the backend.',
  );
}
const convex = new ConvexReactClient(convexUrl);

export default function App() {
  const [splashDone, setSplashDone] = useState(false);
  const [fontsLoaded] = useFonts({
    Quicksand_400Regular,
    Quicksand_500Medium,
    Quicksand_600SemiBold,
    Quicksand_700Bold,
    Baloo2_400Regular,
    Baloo2_500Medium,
    Baloo2_600SemiBold,
    Baloo2_700Bold,
    Baloo2_800ExtraBold,
    PressStart2P_400Regular,
  });

  // Hold render until the themed fonts are ready so the home screen doesn't
  // flash the system font and reflow. The custom SplashScreen still plays once
  // this returns.
  if (!fontsLoaded) return null;

  return (
    <ConvexProvider client={convex}>
      <ThemeProvider>
      <TimerDefaultsProvider>
      <PlayerNameProvider>
      <DevModeProvider>
      <RoleRevealProvider>
      <SafeAreaProvider>
        <GestureHandlerRootView style={{ flex: 1, backgroundColor: '#0F0F14' }}>
          <NavigationContainer theme={AppTheme}>
            <Stack.Navigator
              screenOptions={{
                headerShown: false,
                cardStyle: { backgroundColor: '#0F0F14' },
                gestureEnabled: true,
              }}
            >
              <Stack.Screen name="Home" component={HomeScreen} />
              <Stack.Screen name="Roles" component={RolesScreen} options={{ gestureEnabled: false }} />
              <Stack.Screen name="Settings" component={SettingsScreen} />
              <Stack.Screen name="Themes" component={ThemesScreen} />
              <Stack.Screen name="TimerDefaults" component={TimerDefaultsScreen} />
              <Stack.Screen name="ClockSetup" component={ClockSetupScreen} />
              <Stack.Screen name="Clock" component={ClockScreen} options={{ gestureEnabled: false, animation: 'none' }} />
              <Stack.Screen name="PlayMenu" component={PlayMenuScreen} />
              <Stack.Screen name="CreateGame" component={CreateGameScreen} />
              <Stack.Screen name="JoinGame" component={JoinGameScreen} />
              <Stack.Screen name="Lobby" component={LobbyWithChat} options={{ gestureEnabled: false }} />
              <Stack.Screen name="RoleReveal" component={RoleRevealScreen} options={{ gestureEnabled: false }} />
              <Stack.Screen name="Night" component={NightWithChat} options={{ gestureEnabled: false }} />
              <Stack.Screen name="Triggers" component={TriggersWithChat} options={{ gestureEnabled: false }} />
              <Stack.Screen name="Morning" component={MorningWithChat} options={{ gestureEnabled: false }} />
              <Stack.Screen name="Day" component={DayWithChat} options={{ gestureEnabled: false }} />
              <Stack.Screen name="EndGame" component={EndGameWithChat} options={{ gestureEnabled: false }} />
            </Stack.Navigator>
            <StatusBar style="light" />
          </NavigationContainer>
          {!splashDone && <SplashScreen onDone={() => setSplashDone(true)} />}
          <AlertHost />
        </GestureHandlerRootView>
      </SafeAreaProvider>
      </RoleRevealProvider>
      </DevModeProvider>
      </PlayerNameProvider>
      </TimerDefaultsProvider>
      </ThemeProvider>
    </ConvexProvider>
  );
}
