import { useCallback, useEffect, useState } from 'react'
import type { SessionSummary } from '@swarm/protocol'
import { router } from 'expo-router'
import { Settings } from 'lucide-react-native'
import { ActivityIndicator, FlatList, RefreshControl, Text, TouchableOpacity, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

import { useConnection } from '@/stores/connection-store'

export default function SessionsScreen(): React.JSX.Element {
  const { client, status, error } = useConnection()
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)

  const fetchSessions = useCallback(async (): Promise<void> => {
    if (!client) {
      setLoading(false)
      return
    }
    try {
      setFetchError(null)
      setLoading(true)
      const result = await client.listSessions()
      setSessions(result)
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [client])

  useEffect(() => {
    void fetchSessions()
  }, [fetchSessions])

  const renderItem = ({ item }: { item: SessionSummary }): React.JSX.Element => (
    <TouchableOpacity
      onPress={() => router.push(`/session/${item.id}`)}
      style={{ paddingVertical: 14, paddingHorizontal: 16 }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <View style={{ flex: 1, gap: 4 }}>
          <Text numberOfLines={1} style={{ color: '#e0e0e0', fontSize: 15, fontWeight: '500' }}>
            {item.title ?? '未命名会话'}
          </Text>
          <Text style={{ color: '#888', fontSize: 12 }}>
            {item.taskCount} 条消息 · {new Date(item.lastActiveAt).toLocaleDateString()}
          </Text>
        </View>
        {item.pinned && <Text style={{ color: '#888', fontSize: 12 }}>📌</Text>}
      </View>
    </TouchableOpacity>
  )

  const displayError = fetchError ?? error

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#151718' }}>
      <View style={{ flex: 1 }}>
        {/* Header */}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingHorizontal: 16,
            paddingVertical: 14,
          }}
        >
          <Text style={{ color: '#e0e0e0', fontSize: 18, fontWeight: '600' }}>会话</Text>
          <TouchableOpacity
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            onPress={() => router.push('/settings')}
            style={{ padding: 8 }}
          >
            <Settings color="#888" size={22} />
          </TouchableOpacity>
        </View>

        {/* Error */}
        {displayError && (
          <View style={{ paddingHorizontal: 16, paddingVertical: 6 }}>
            <Text style={{ color: '#ef4444', fontSize: 13 }}>{displayError}</Text>
          </View>
        )}

        {/* Loading */}
        {loading && sessions.length === 0 ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <ActivityIndicator color="#888" size="large" />
            <Text style={{ color: '#888', fontSize: 14, marginTop: 8 }}>加载会话…</Text>
          </View>
        ) : sessions.length === 0 ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ color: '#666', fontSize: 14 }}>{status === 'error' ? '连接断开,请重连' : '暂无会话'}</Text>
          </View>
        ) : (
          <FlatList
            data={sessions}
            ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: '#2a2a2a' }} />}
            keyExtractor={(item) => item.id}
            refreshControl={
              <RefreshControl onRefresh={() => void fetchSessions()} refreshing={loading} tintColor="#888" />
            }
            renderItem={renderItem}
          />
        )}
      </View>
    </SafeAreaView>
  )
}
