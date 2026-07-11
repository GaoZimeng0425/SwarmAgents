import { useEffect, useState } from 'react'
import type { SessionSummary } from '@swarm/protocol'
import { router } from 'expo-router'
import { FlatList, RefreshControl, SafeAreaView, Text, TouchableOpacity } from 'react-native'

import { Box } from '@/components/ui/box'
import { Heading } from '@/components/ui/heading'
import { HStack } from '@/components/ui/hstack'
import { VStack } from '@/components/ui/vstack'
import { useConnection } from '@/stores/connection-store'

export default function SessionsScreen(): React.JSX.Element {
  const { client } = useConnection()
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchSessions = async (): Promise<void> => {
    if (!client) return
    try {
      setError(null)
      const result = await client.listSessions()
      setSessions(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void fetchSessions()
  }, [client])

  const renderItem = ({ item }: { item: SessionSummary }): React.JSX.Element => (
    <TouchableOpacity
      onPress={() => router.push(`/session/${item.id}`)}
      style={{ paddingVertical: 12, paddingHorizontal: 16 }}
    >
      <HStack className="items-center justify-between">
        <VStack className="flex-1 gap-1">
          <Text className="font-medium text-typography-900" numberOfLines={1}>
            {item.title ?? '未命名会话'}
          </Text>
          <Text className="text-typography-400 text-xs">
            {item.taskCount} 条消息 · {new Date(item.lastActiveAt).toLocaleDateString()}
          </Text>
        </VStack>
        {item.pinned && <Text className="text-typography-400 text-xs">📌</Text>}
      </HStack>
    </TouchableOpacity>
  )

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <Box className="flex-1">
        <Box className="px-4 py-3">
          <Heading size="md">会话列表</Heading>
        </Box>
        {error && (
          <Box className="px-4 py-2">
            <Text className="text-error-500 text-sm">{error}</Text>
          </Box>
        )}
        <FlatList
          data={sessions}
          ItemSeparatorComponent={() => <Box className="h-px bg-border" />}
          keyExtractor={(item) => item.id}
          refreshControl={<RefreshControl onRefresh={() => void fetchSessions()} refreshing={loading} />}
          renderItem={renderItem}
        />
      </Box>
    </SafeAreaView>
  )
}
