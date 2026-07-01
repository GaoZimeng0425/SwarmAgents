import { useEffect, useState } from 'react'
import { StatusBar } from 'expo-status-bar'
import { Button, StyleSheet, Text, View } from 'react-native'
import { NavigationContainer } from '@react-navigation/native'
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import { createServiceClient, type ServiceClient } from '@swarm/protocol'
import { createWsTransport } from './src/transport-ws'
import { loadHostConfig } from './src/host-config'
import { ServiceClientContext } from './src/service-client'
import { HomeScreen } from './src/screens/HomeScreen'
import { SettingsScreen } from './src/screens/SettingsScreen'

const Stack = createNativeStackNavigator()

export default function App() {
  const [client, setClient] = useState<ServiceClient | null>(null)
  const [status, setStatus] = useState('booting')

  useEffect(() => {
    ;(async () => {
      const { wsHost, token } = await loadHostConfig()
      if (!token) { setStatus('no token — set in Settings'); return }
      try {
        const ws = new WebSocket(wsHost, `swarm.${token}`)
        const { transport, ready } = createWsTransport(ws)
        await ready
        const c = createServiceClient({ transport, onEvent: () => {} })
        await c.connect()
        setClient(c)
        setStatus('connected')
      } catch (err) {
        setStatus(`error: ${String(err)}`)
      }
    })().catch((e) => setStatus(`error: ${String(e)}`))
  }, [])

  return (
    <ServiceClientContext.Provider value={client}>
      <NavigationContainer>
        <Stack.Navigator>
          <Stack.Screen name="Home" options={{ title: 'SwarmAgents' }}>
            {({ navigation }) => (
              <View style={{ flex: 1 }}>
                {status !== 'connected' && (
                  <View style={styles.banner}>
                    <Text style={styles.bannerText}>{status}</Text>
                  </View>
                )}
                <View style={{ flex: 1 }}>
                  <HomeScreen />
                </View>
                <Button title="settings" onPress={() => navigation.navigate('Settings')} />
              </View>
            )}
          </Stack.Screen>
          <Stack.Screen name="Settings" component={SettingsScreen} />
        </Stack.Navigator>
      </NavigationContainer>
      <StatusBar style="auto" />
    </ServiceClientContext.Provider>
  )
}

const styles = StyleSheet.create({
  banner: { padding: 8, backgroundColor: '#ffe' },
  bannerText: { color: '#663' },
})
