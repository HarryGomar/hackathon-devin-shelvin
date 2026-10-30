import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { BuildWatchers } from '@/features/sources/build-watchers';
import { common } from '@/i18n/common';
import { monoFamily, useTheme } from '@/theme';

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const { dark, colors } = useTheme();

  useEffect(() => {
    SplashScreen.hideAsync();
  }, []);

  const navTheme = dark ? DarkTheme : DefaultTheme;
  return (
    <SafeAreaProvider>
      <ThemeProvider
        value={{
          ...navTheme,
          colors: { ...navTheme.colors, primary: colors.text, background: colors.background, card: colors.background, text: colors.text, border: colors.border },
        }}>
        <StatusBar style={dark ? 'light' : 'dark'} />
        <BuildWatchers />
        <Stack
          screenOptions={{
            headerTintColor: colors.text,
            // Ticket headers: mono caps titles, no shadow, paper background.
            headerTitleStyle: { color: colors.text, fontFamily: monoFamily, fontSize: 13, fontWeight: '600' },
            headerShadowVisible: false,
            headerBackButtonDisplayMode: 'minimal',
            contentStyle: { backgroundColor: colors.background },
          }}>
          <Stack.Screen name="index" options={{ title: common.appName }} />
          <Stack.Screen name="scan" options={{ presentation: 'fullScreenModal', headerShown: false }} />
          <Stack.Screen name="confirm" options={{ title: 'CONFIRM PRODUCT' }} />
          <Stack.Screen name="sources" options={{ title: 'PAGES FOUND' }} />
          <Stack.Screen name="add-source" options={{ presentation: 'modal', title: 'ADD A PAGE' }} />
          <Stack.Screen name="results" options={{ title: 'RESULTS' }} />
          <Stack.Screen name="product/[id]" options={{ title: 'SAVED LISTINGS' }} />
          <Stack.Screen name="listing/[id]" options={{ title: 'LISTING' }} />
          <Stack.Screen name="builds/index" options={{ title: 'BUILDS' }} />
          <Stack.Screen name="builds/[id]" options={{ title: 'BUILD' }} />
          <Stack.Screen name="console" options={{ title: 'CONSOLE' }} />
        </Stack>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
