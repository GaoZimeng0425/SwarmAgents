import { BlurView } from 'expo-blur'
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect'
import { router, Stack } from 'expo-router'
import { Pressable, ScrollView, View, type ViewStyle } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { useColorMode } from '@/components/color-mode'
import { Heading } from '@/components/ui/heading'
import { ChevronLeftIcon, InfoIcon } from '@/components/ui/icon'
import { Text } from '@/components/ui/text'
import { VStack } from '@/components/ui/vstack'

const sections = [
  {
    title: 'Overview',
    body: 'This screen demonstrates a modern iOS-style header with a frosted-glass blur effect. Scroll up and watch the content slide under the translucent navigation bar.',
  },
  {
    title: 'Routing',
    body: 'Every file under app/ becomes a route automatically. This file is app/details.tsx, so its route is /details.',
  },
  {
    title: 'Navigation',
    body: 'Use router.push to go forward and router.back to return. The back arrow in the header also works.',
  },
  {
    title: 'Styling',
    body: 'All styling uses tailwind classNames via nativewind. Color tokens like bg-background and text-foreground are defined in global.css.',
  },
  {
    title: 'Next steps',
    body: 'Replace this placeholder content with real features. Add more routes, connect data, build out the UI.',
  },
]

const BUTTON_SIZE = 44

const circleStyle: ViewStyle = {
  width: BUTTON_SIZE,
  height: BUTTON_SIZE,
  borderRadius: BUTTON_SIZE / 2,
  alignItems: 'center',
  justifyContent: 'center',
  overflow: 'hidden',
}

// Floating Liquid Glass back button. Uses the native iOS 26 glass effect when
// available and falls back to a frosted BlurView circle on older systems.
function GlassBackButton({ top }: { top: number }) {
  const { colorMode } = useColorMode()
  const iconColor = colorMode === 'dark' ? '#F2F2F7' : '#1C1C1E'

  return (
    <Pressable
      hitSlop={12}
      onPress={() => router.back()}
      style={{ position: 'absolute', top: top + 8, left: 16, zIndex: 10 }}
    >
      {isLiquidGlassAvailable() ? (
        <GlassView colorScheme={colorMode} glassEffectStyle="regular" isInteractive style={circleStyle}>
          <ChevronLeftIcon color={iconColor} height={26} style={{ marginLeft: -2 }} width={26} />
        </GlassView>
      ) : (
        <BlurView blurMethod="dimezisBlurView" intensity={60} style={circleStyle} tint={colorMode}>
          <ChevronLeftIcon color={iconColor} height={26} style={{ marginLeft: -2 }} width={26} />
        </BlurView>
      )}
    </Pressable>
  )
}

export default function DetailsScreen() {
  const insets = useSafeAreaInsets()

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View className="flex-1 bg-background">
        <GlassBackButton top={insets.top} />

        <ScrollView className="flex-1">
          <VStack className="gap-6 px-6 pb-12" style={{ paddingTop: insets.top + BUTTON_SIZE + 24 }}>
            {sections.map((section, i) => (
              <VStack className="gap-2" key={section.title}>
                {i === 0 && <InfoIcon className="mb-2 text-primary" height={48} width={48} />}
                <Heading size="md">{section.title}</Heading>
                <Text className="text-typography-400">{section.body}</Text>
              </VStack>
            ))}
          </VStack>
        </ScrollView>
      </View>
    </>
  )
}
