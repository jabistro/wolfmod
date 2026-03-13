import './global.css';
import { useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { createStackNavigator } from '@react-navigation/stack';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import HomeScreen from './src/screens/HomeScreen';
import RolesScreen from './src/screens/RolesScreen';
import ClockSetupScreen from './src/screens/ClockSetupScreen';
import ClockScreen from './src/screens/ClockScreen';
import SplashScreen from './src/screens/SplashScreen';
import type { RootStackParamList } from './src/navigation/types';

const Stack = createStackNavigator<RootStackParamList>();

const AppTheme = {
  ...DefaultTheme,
  colors: { ...DefaultTheme.colors, background: '#0F0F14' },
};

export default function App() {
  const [splashDone, setSplashDone] = useState(false);

  return (
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
        </Stack.Navigator>
        <StatusBar style="light" />
      </NavigationContainer>
      {!splashDone && <SplashScreen onDone={() => setSplashDone(true)} />}
    </GestureHandlerRootView>
  );
}
