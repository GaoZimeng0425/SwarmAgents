import { useState } from 'react'
import { Button, StyleSheet, Text, View } from 'react-native'
import { useServiceClient } from '../service-client'

export function HomeScreen() {
  const client = useServiceClient()
  const [result, setResult] = useState<string>('')
  const [busy, setBusy] = useState(false)

  const probe = (): void => {
    if (!client) { setResult('not connected — set token in Settings'); return }
    setBusy(true); setResult('')
    client.listAgents().then(
      (a) => { setResult(`connected — ${a.length} agents visible`); setBusy(false) },
      (err) => { setResult(`error: ${String(err)}`); setBusy(false) },
    )
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>SwarmAgents</Text>
      <Text style={styles.hint}>Skeleton — verifies the app reaches the desktop over WS.</Text>
      <Button title={busy ? '...' : 'test connection'} onPress={probe} disabled={busy} />
      {result !== '' && <Text style={styles.result}>{result}</Text>}
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  title: { fontSize: 20, fontWeight: 'bold', marginBottom: 8 },
  hint: { color: '#666', marginBottom: 16 },
  result: { marginTop: 12 },
})
