import { Stack } from 'expo-router';

import HomeScreen from '@/features/home/home-screen';

export default function HomeRoute() {
  return (
    <>
      {/* Home draws its own SHELVIN line with the mode and the appearance button. */}
      <Stack.Screen options={{ headerShown: false }} />
      <HomeScreen />
    </>
  );
}
