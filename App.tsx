import './global.css';
import { useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { createStackNavigator } from '@react-navigation/stack';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ConvexProvider, ConvexReactClient } from 'convex/react';
import HomeScreen from './src/screens/HomeScreen';
import RolesScreen from './src/screens/RolesScreen';
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
import type { RootStackParamList } from './src/navigation/types';

const Stack = createStackNavigator<RootStackParamList>();

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

  return (
    <ConvexProvider client={convex}>
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
              <Stack.Screen name="ClockSetup" component={ClockSetupScreen} />
              <Stack.Screen name="Clock" component={ClockScreen} options={{ gestureEnabled: false, animationEnabled: false }} />
              <Stack.Screen name="PlayMenu" component={PlayMenuScreen} />
              <Stack.Screen name="CreateGame" component={CreateGameScreen} />
              <Stack.Screen name="JoinGame" component={JoinGameScreen} />
              <Stack.Screen name="Lobby" component={LobbyScreen} options={{ gestureEnabled: false }} />
              <Stack.Screen name="RoleReveal" component={RoleRevealScreen} options={{ gestureEnabled: false }} />
              <Stack.Screen name="Night" component={NightScreen} options={{ gestureEnabled: false }} />
              <Stack.Screen name="Triggers" component={TriggersScreen} options={{ gestureEnabled: false }} />
              <Stack.Screen name="Morning" component={MorningScreen} options={{ gestureEnabled: false }} />
              <Stack.Screen name="Day" component={DayScreen} options={{ gestureEnabled: false }} />
              <Stack.Screen name="EndGame" component={EndGameScreen} options={{ gestureEnabled: false }} />
            </Stack.Navigator>
            <StatusBar style="light" />
          </NavigationContainer>
          {!splashDone && <SplashScreen onDone={() => setSplashDone(true)} />}
        </GestureHandlerRootView>
      </SafeAreaProvider>
    </ConvexProvider>
  );
}
