import { useEffect, useState } from 'react'
import { router } from 'expo-router'
import { SafeAreaView } from 'react-native-safe-area-context'
import { ActivityIndicator, View } from 'react-native'

import Logo from '@/assets/icons/Logo'
import { Box } from '@/components/ui/box'
import { Button, ButtonText } from '@/components/ui/button'
import { Text } from '@/components/ui/text'
import { VStack } from '@/components/ui/vstack'
import { useConnection } from '@/stores/connection-store'

export default function Home() {
  const { loadSavedPairing, connect, status } = useConnection()
  const [checking, setChecking] = useState(true)

  // On first launch, check if there's a saved pairing and auto-connect.
  useEffect(() => {
    void (async () => {
      const saved = await loadSavedPairing()
      if (saved) {
        console.log('[index] auto-connecting to', saved.host, saved.port)
        const ok = await connect(saved)
        console.log('[index] auto-connect result:', ok, 'status will update')
        if (!ok) {
          // Auto-connect failed — go to pair screen.
          router.replace('/pair')
        }
      }
      setChecking(false)
    })()
  }, [loadSavedPairing, connect])

  // If auto-connect succeeds, go to sessions.
  useEffect(() => {
    if (status === 'connected') {
      router.replace('/sessions')
    }
  }, [status])

  if (checking) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: '#151718' }}>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator size="large" color="#888" />
        </View>
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#151718' }}>
      <Box className="flex-1 items-center justify-center gap-8 px-6">
        <Logo />

        <VStack className="items-center gap-2">
          <Text className="text-2xl font-bold text-typography-900">Swarm Agents</Text>
          <Text className="text-center text-typography-400">
            连接到桌面端,在手机上查看会话、发送消息和审批权限。
          </Text>
        </VStack>

        <Button onPress={() => router.push('/pair')} size="lg">
          <ButtonText>连接桌面端</ButtonText>
        </Button>
      </Box>
    </SafeAreaView>
  )
}
