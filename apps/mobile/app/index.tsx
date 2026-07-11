import { type ReactNode, useEffect, useState } from 'react'
import { router } from 'expo-router'
import { ActivityIndicator, View } from 'react-native'

import { useConnection } from '@/stores/connection-store'

type RouteState = 'loading' | 'pair' | 'sessions'

export default function Home(): ReactNode {
  const { status, loadSavedPairing, connect } = useConnection()
  const [route, setRoute] = useState<RouteState>('loading')

  useEffect(() => {
    // On first launch, try to auto-connect with saved pairing.
    void (async () => {
      const saved = await loadSavedPairing()
      if (saved) {
        const ok = await connect(saved)
        setRoute(ok ? 'sessions' : 'pair')
      } else {
        setRoute('pair')
      }
    })()
  }, [loadSavedPairing, connect])

  // When connection status changes externally, follow it.
  useEffect(() => {
    if (route === 'loading') return
    if (status === 'connected') setRoute('sessions')
    else if (status === 'idle' || status === 'error') setRoute('pair')
  }, [status, route])

  useEffect(() => {
    if (route === 'pair') router.replace('/pair')
    else if (route === 'sessions') router.replace('/sessions')
  }, [route])

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <ActivityIndicator size="large" />
    </View>
  )
}
