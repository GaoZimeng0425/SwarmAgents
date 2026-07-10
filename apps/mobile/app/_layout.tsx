import { ColorModeProvider, useColorMode } from '@/components/color-mode'
import { Fab, FabIcon } from '@/components/ui/fab'
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider'
import { MoonIcon, SunIcon } from '@/components/ui/icon'
import '@/global.css'
import { useEffect } from 'react'
import FontAwesome from '@expo/vector-icons/FontAwesome'
import { useFonts } from 'expo-font'
import { DarkTheme, DefaultTheme, Stack, ThemeProvider, usePathname } from 'expo-router'
import * as SplashScreen from 'expo-splash-screen'
import { StatusBar } from 'expo-status-bar'
import { GestureHandlerRootView } from 'react-native-gesture-handler'

export {
  // Catch any errors thrown by the Layout component.
  ErrorBoundary,
} from 'expo-router'

SplashScreen.preventAutoHideAsync()

export default function RootLayout() {
  const [loaded, error] = useFonts({
    SpaceMono: require('../assets/fonts/SpaceMono-Regular.ttf'),
    ...FontAwesome.font,
  })

  // Expo Router uses Error Boundaries to catch errors in the navigation tree.
  useEffect(() => {
    if (error) throw error
  }, [error])

  useEffect(() => {
    if (loaded) {
      SplashScreen.hideAsync()
    }
  }, [loaded])
  return (
    <ColorModeProvider>
      <RootLayoutNav />
    </ColorModeProvider>
  )
}

function RootLayoutNav() {
  const pathname = usePathname()
  const { colorMode, toggleColorMode } = useColorMode()

  return (
    <ThemeProvider value={colorMode === 'dark' ? DarkTheme : DefaultTheme}>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <GluestackUIProvider mode={colorMode}>
          <StatusBar style={colorMode === 'dark' ? 'light' : 'dark'} />
          <Stack
            screenOptions={{
              headerTransparent: true,
              contentStyle: {
                backgroundColor: colorMode === 'dark' ? '#151718' : '#fff',
              },
            }}
          >
            <Stack.Screen name="index" options={{ headerShown: false }} />
            <Stack.Screen name="details" options={{ headerShown: false }} />
          </Stack>
          {pathname === '/' && (
            <Fab className="m-6" onPress={toggleColorMode} size="lg">
              <FabIcon as={colorMode === 'dark' ? MoonIcon : SunIcon} />
            </Fab>
          )}
        </GluestackUIProvider>
      </GestureHandlerRootView>
    </ThemeProvider>
  )
}
