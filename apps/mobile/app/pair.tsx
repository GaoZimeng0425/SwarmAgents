import { useEffect, useState } from 'react'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { router } from 'expo-router'
import { Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

import { Box } from '@/components/ui/box'
import { Button, ButtonText } from '@/components/ui/button'
import { Heading } from '@/components/ui/heading'
import { Input, InputField } from '@/components/ui/input'
import { VStack } from '@/components/ui/vstack'
import { parseQr } from '@/lib/parse-qr'
import { useConnection } from '@/stores/connection-store'

export default function PairScreen(): React.JSX.Element {
  const { connect, error, status } = useConnection()
  const [permission, requestPermission] = useCameraPermissions()
  const [scanned, setScanned] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const [manualInput, setManualInput] = useState('')
  const [showManual, setShowManual] = useState(false)

  // Request camera permission on mount.
  useEffect(() => {
    void requestPermission()
  }, [])

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

  const handleManualConnect = async (): Promise<void> => {
    setLocalError(null)
    try {
      const config = parseQr(manualInput.trim())
      const ok = await connect(config)
      if (ok) {
        router.replace('/sessions')
      } else {
        setLocalError('连接失败,请检查桌面端是否已启动')
      }
    } catch {
      setLocalError('格式错误,请粘贴桌面端显示的配对码')
    }
  }

  // Camera permission granted and not in manual mode — show scanner.
  if (permission?.granted && !showManual) {
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
          <View style={{ position: 'absolute', bottom: 100, right: 20 }}>
            <Button onPress={() => setShowManual(true)} size="sm" variant="outline">
              <ButtonText>手动输入</ButtonText>
            </Button>
          </View>
        </View>
      </SafeAreaView>
    )
  }

  // Permission not granted, or manual mode — show input form.
  return (
    <SafeAreaView style={{ flex: 1 }}>
      <Box className="flex-1 items-center justify-center gap-6 px-6">
        <VStack className="items-center gap-2">
          <Heading size="lg">连接桌面端</Heading>
          <Text className="text-center text-typography-400">
            在桌面端打开「设置 → 远程连接」,用手机扫描 QR 码,或手动输入配对码。
          </Text>
        </VStack>

        {!permission?.granted && (
          <Button onPress={() => void requestPermission()} size="lg">
            <ButtonText>授权相机扫码</ButtonText>
          </Button>
        )}

        <VStack className="w-full gap-3">
          <Input className="w-full">
            <InputField
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={setManualInput}
              onSubmitEditing={() => void handleManualConnect()}
              placeholder="swarm:192.168.x.x:47777?token=..."
              value={manualInput}
            />
          </Input>

          {(localError || error) && (
            <Text className="text-error-500 text-sm">{localError ?? error}</Text>
          )}

          <Button
            isDisabled={!manualInput.trim() || status === 'connecting'}
            onPress={() => void handleManualConnect()}
            size="lg"
          >
            <ButtonText>{status === 'connecting' ? '连接中…' : '连接'}</ButtonText>
          </Button>
        </VStack>

        {permission?.granted && (
          <Button onPress={() => setShowManual(false)} size="sm" variant="link">
            <ButtonText>使用扫码</ButtonText>
          </Button>
        )}
      </Box>
    </SafeAreaView>
  )
}
