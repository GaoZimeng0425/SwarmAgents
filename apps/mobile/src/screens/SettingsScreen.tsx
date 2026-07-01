import { useState } from 'react'
import { Button, StyleSheet, Text, TextInput, View } from 'react-native'
import { saveHostConfig, type HostConfig, loadHostConfig } from '../host-config'

export function SettingsScreen() {
  const [wsHost, setWsHost] = useState('ws://127.0.0.1:47777')
  const [token, setToken] = useState('')
  const [saved, setSaved] = useState(false)

  // load on mount
  loadHostConfig().then((c: HostConfig) => { setWsHost(c.wsHost); setToken(c.token) }).catch(() => {})

  return (
    <View style={styles.container}>
      <Text style={styles.label}>WS host</Text>
      <TextInput value={wsHost} onChangeText={setWsHost} style={styles.input} autoCapitalize="none" />
      <Text style={styles.label}>Token (from desktop userData/ws-host.json)</Text>
      <TextInput value={token} onChangeText={setToken} style={styles.input} autoCapitalize="none" />
      <Button title="Save" onPress={() => { void saveHostConfig({ wsHost, token }).then(() => setSaved(true)) }} />
      {saved && <Text style={{ color: 'green', marginTop: 8 }}>saved — restart app to reconnect</Text>}
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  label: { marginTop: 8, marginBottom: 4 },
  input: { borderWidth: 1, borderColor: '#ccc', padding: 8, borderRadius: 4 },
})
