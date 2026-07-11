import { useState } from 'react'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { router } from 'expo-router'
import { SafeAreaView, Text, View } from 'react-native'

import { Box } from '@/components/ui/box'
import { Button, ButtonText } from '@/components/ui/button'
import { Heading } from '@/components/ui/heading'
import { VStack } from '@/components/ui/vstack'
import { parseQr } from '@/lib/parse-qr'
import { useConnection } from '@/stores/connection-store'

export default function PairScreen(): React.JSX.Element {
  const { connect, error, status } = useConnection()
  const [permission, requestPermission] = useCameraPermissions()
  const [scanned, setScanned] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)

  const handleScan = async ({ data }: { data: string }): Promise<void> => {
    if (scanned) return
    setScanned(true)
    try {
      const config = parseQr(data)
      const ok = await connect(config)
      if (ok) {
        router.replace('/sessions')
      } else {
        setLocalError('连接失败,请重试')
        setScanned(false)
      }
    } catch {
      setLocalError('无效的二维码,请扫描桌面端显示的配对码')
      setScanned(false)
    }
  }

  // Permission not granted yet — show a request button.
  if (!permission?.granted) {
    return (
      <SafeAreaView style={{ flex: 1 }}>
        <Box className="flex-1 items-center justify-center gap-6 px-6">
          <VStack className="items-center gap-2">
            <Heading size="lg">扫描配对码</Heading>
            <Text className="text-center text-typography-400">
              在桌面端打开「设置 → 远程连接」,用手机扫描显示的 QR 码。
            </Text>
          </VStack>
          <Button onPress={() => requestPermission()}>
            <ButtonText>授权相机</ButtonText>
          </Button>
          {localError && <Text className="text-error-500 text-sm">{localError}</Text>}
        </Box>
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <View style={{ flex: 1 }}>
        <CameraView
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          facing="back"
          onBarcodeScanned={scanned ? undefined : handleScan}
          style={{ flex: 1 }}
        />
        <View style={{ position: 'absolute', bottom: 40, left: 0, right: 0, alignItems: 'center' }}>
          <Text
            style={{
              color: 'white',
              fontSize: 14,
              textAlign: 'center',
              backgroundColor: 'rgba(0,0,0,0.5)',
              paddingHorizontal: 16,
              paddingVertical: 8,
              borderRadius: 8,
            }}
          >
            {status === 'connecting' ? '正在连接…' : '将 QR 码对准相机'}
          </Text>
        </View>
        {(localError || error) && (
          <View style={{ position: 'absolute', top: 60, left: 20, right: 20, alignItems: 'center' }}>
            <Text
              style={{
                color: '#ef4444',
                fontSize: 14,
                textAlign: 'center',
                backgroundColor: 'rgba(0,0,0,0.7)',
                paddingHorizontal: 16,
                paddingVertical: 8,
                borderRadius: 8,
              }}
            >
              {localError ?? error}
            </Text>
          </View>
        )}
      </View>
    </SafeAreaView>
  )
}
