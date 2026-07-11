import { router } from 'expo-router'
import { SafeAreaView, Text } from 'react-native'

import { Box } from '@/components/ui/box'
import { Button, ButtonText } from '@/components/ui/button'
import { Heading } from '@/components/ui/heading'
import { VStack } from '@/components/ui/vstack'
import { useConnection } from '@/stores/connection-store'

export default function SettingsScreen(): React.JSX.Element {
  const { config, status, disconnect, reconnect } = useConnection()

  const handleDisconnect = (): void => {
    disconnect()
    router.replace('/pair')
  }

  const handleReconnect = (): void => {
    void reconnect()
  }

  const handleRePair = (): void => {
    disconnect()
    router.replace('/pair')
  }

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <Box className="flex-1 px-4 py-4">
        <VStack className="gap-4">
          <Heading size="md">连接设置</Heading>

          <Box className="gap-2 rounded-lg border border-border p-3">
            <Text className="text-sm text-typography-400">状态</Text>
            <Text className="text-sm text-typography-900">
              {status === 'connected'
                ? '已连接'
                : status === 'connecting'
                  ? '连接中…'
                  : status === 'error'
                    ? '连接错误'
                    : '未连接'}
            </Text>
          </Box>

          {config && (
            <Box className="gap-2 rounded-lg border border-border p-3">
              <Text className="text-sm text-typography-400">桌面端地址</Text>
              <Text className="font-mono text-sm text-typography-900">
                {config.host}:{config.port}
              </Text>
            </Box>
          )}

          <VStack className="gap-2">
            <Button isDisabled={status === 'connecting' || !config} onPress={handleReconnect}>
              <ButtonText>重新连接</ButtonText>
            </Button>
            <Button onPress={handleDisconnect} variant="outline">
              <ButtonText>断开连接</ButtonText>
            </Button>
            <Button onPress={handleRePair} variant="outline">
              <ButtonText>重新配对</ButtonText>
            </Button>
          </VStack>
        </VStack>
      </Box>
    </SafeAreaView>
  )
}
