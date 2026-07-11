import { useEffect, useMemo, useRef, useState } from 'react'
import type { MessageEvent, MessageWireEvent } from '@swarm/protocol'
import { useLocalSearchParams, router } from 'expo-router'
import { ChevronLeft } from 'lucide-react-native'
import Markdown from 'react-native-markdown-display'
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

import { markdownRules } from '@/components/ui/chat-ai/message'
import { useEvents } from '@/hooks/use-events'
import { useConnection } from '@/stores/connection-store'
import { type Segment, applyEvent, buildSegments, type MessageRecord } from '@swarm/shared'

type PermissionPrompt = {
  messageId: string
  actionId: string
  risk: string
  summary: string
}

export default function SessionDetailScreen(): React.JSX.Element {
  const { id: sessionId } = useLocalSearchParams<{ id: string }>()
  const { client } = useConnection()
  const [records, setRecords] = useState<MessageRecord[]>([])
  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [permissions, setPermissions] = useState<PermissionPrompt[]>([])
  const processedCountRef = useRef(0)

  const filter = useMemo(() => (event: string) => event.startsWith('message.'), [])
  const events = useEvents(filter)

  // Flatten all MessageRecords into render segments, ordered by `order`.
  const segments = useMemo(() => {
    const sorted = [...records].sort((a, b) => b.order - a.order)
    return sorted.flatMap((r) => buildSegments(r.events))
  }, [records])

  // Load history on mount — reduce raw events into MessageRecord[] via applyEvent.
  useEffect(() => {
    if (!client || !sessionId) return
    void (async () => {
      try {
        const history = await client.getMessageEvents(sessionId)
        const sorted = [...history].sort((a, b) => a.seq - b.seq)
        const reduced = sorted.reduce<MessageRecord[]>((acc, r) => applyEvent(acc, r.event), [])
        setRecords(reduced)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    })()
  }, [client, sessionId])

  // Reset when switching sessions.
  useEffect(() => {
    processedCountRef.current = 0
    setRecords([])
  }, [sessionId])

  // Append live events — apply each to the records via applyEvent.
  useEffect(() => {
    if (events.length === 0) return
    const newEvents = events.slice(processedCountRef.current)
    processedCountRef.current = events.length

    for (const latest of newEvents) {
      if (!latest.event.startsWith('message.')) continue
      const wireEvent = latest.data as MessageWireEvent
      if (wireEvent.sessionId !== sessionId) continue

      setRecords((prev) => applyEvent(prev, wireEvent))

      if (wireEvent.kind === 'message.permission_request') {
        setPermissions((prev) => [
          ...prev,
          {
            messageId: wireEvent.messageId,
            actionId: wireEvent.actionId,
            risk: wireEvent.risk,
            summary: wireEvent.summary,
          },
        ])
      }
    }
  }, [events, sessionId])

  const handleSend = async (): Promise<void> => {
    if (!client || !sessionId || !input.trim()) return
    const text = input.trim()
    setInput('')
    try {
      await client.submitPrompt(sessionId, text)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const handlePermission = async (perm: PermissionPrompt, decision: 'grant' | 'deny'): Promise<void> => {
    if (!client || !sessionId) return
    try {
      await client.decidePermission(sessionId, perm.actionId, decision)
      setPermissions((prev) => prev.filter((p) => p.actionId !== perm.actionId))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const renderSegment = ({ item }: { item: Segment }): React.JSX.Element => {
    switch (item.kind) {
      case 'user':
        return (
          <View style={{ marginHorizontal: 16, marginVertical: 4, flexDirection: 'row', justifyContent: 'flex-end' }}>
            <View style={{ maxWidth: '85%', borderRadius: 12, backgroundColor: '#2a2a2e', paddingHorizontal: 12, paddingVertical: 8 }}>
              <Text style={{ color: '#e0e0e0', fontSize: 15 }}>{item.text}</Text>
            </View>
          </View>
        )

      case 'assistant':
        return (
          <View style={{ marginHorizontal: 16, marginVertical: 4, maxWidth: '90%' }}>
            <Markdown rules={markdownRules}>{item.text}</Markdown>
          </View>
        )

      case 'reasoning':
        return (
          <View style={{ marginHorizontal: 16, marginVertical: 4, borderRadius: 8, borderWidth: 1, borderColor: '#333', backgroundColor: '#1e1e22', paddingHorizontal: 12, paddingVertical: 8 }}>
            <Text style={{ color: '#888', fontSize: 13, fontStyle: 'italic' }}>{item.text}</Text>
          </View>
        )

      case 'tool':
        return (
          <View style={{ marginHorizontal: 16, marginVertical: 4, borderRadius: 8, borderWidth: 1, borderColor: '#333', backgroundColor: '#1e1e22', paddingHorizontal: 12, paddingVertical: 8 }}>
            <Text style={{ color: '#aaa', fontSize: 13, fontWeight: '500' }}>
              🔧 {item.tool}
              {item.ok === null ? ' ⋯' : item.ok ? ' ✓' : ' ✗'}
            </Text>
            {item.output && (
              <Text style={{ marginTop: 4, color: '#777', fontSize: 12, fontFamily: 'monospace' }} numberOfLines={5}>
                {item.output}
              </Text>
            )}
          </View>
        )

      case 'error':
        return (
          <View style={{ marginHorizontal: 16, marginVertical: 4, borderRadius: 8, backgroundColor: '#3a1518', paddingHorizontal: 12, paddingVertical: 8 }}>
            <Text style={{ color: '#ef4444', fontSize: 14 }}>
              {item.label === 'stopped' ? '⏹' : '⚠'} {item.detail}
            </Text>
          </View>
        )

      case 'event':
        return (
          <View style={{ marginHorizontal: 16, marginVertical: 4 }}>
            <Text style={{ color: '#666', fontSize: 12 }}>
              {item.label}: {item.detail}
            </Text>
          </View>
        )
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#151718' }}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <View style={{ flex: 1 }}>
          {/* Header */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 12,
              paddingHorizontal: 16,
              paddingVertical: 14,
              borderBottomWidth: 1,
              borderBottomColor: '#2a2a2a',
            }}
          >
            <TouchableOpacity hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} onPress={() => router.back()}>
              <ChevronLeft color="#e0e0e0" size={24} />
            </TouchableOpacity>
            <Text style={{ color: '#e0e0e0', fontSize: 17, fontWeight: '600' }}>会话详情</Text>
          </View>

          {error && (
            <View style={{ paddingHorizontal: 16, paddingVertical: 4 }}>
              <Text style={{ color: '#ef4444', fontSize: 12 }}>{error}</Text>
            </View>
          )}

          <FlatList
            data={segments}
            keyExtractor={(item) => item.key}
            renderItem={renderSegment}
          />

          {/* Permission cards */}
          {permissions.length > 0 && (
            <View style={{ gap: 8, borderTopWidth: 1, borderTopColor: '#2a2a2a', paddingHorizontal: 16, paddingVertical: 12 }}>
              {permissions.map((perm) => (
                <View key={perm.actionId} style={{ borderRadius: 8, borderWidth: 1, borderColor: '#856404', backgroundColor: '#1e1a0e', padding: 12 }}>
                  <Text style={{ color: '#fbbf24', fontSize: 14, fontWeight: '500' }}>{perm.risk} 风险操作 · 需要审批</Text>
                  <Text style={{ marginTop: 4, color: '#aaa', fontSize: 12 }}>{perm.summary}</Text>
                  <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                    <TouchableOpacity
                      onPress={() => void handlePermission(perm, 'grant')}
                      style={{ backgroundColor: '#3b82f6', borderRadius: 8, paddingHorizontal: 16, paddingVertical: 6 }}
                    >
                      <Text style={{ color: '#fff', fontSize: 14 }}>批准</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => void handlePermission(perm, 'deny')}
                      style={{ borderWidth: 1, borderColor: '#555', borderRadius: 8, paddingHorizontal: 16, paddingVertical: 6 }}
                    >
                      <Text style={{ color: '#ccc', fontSize: 14 }}>拒绝</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ))}
            </View>
          )}

          {/* Input bar */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, borderTopWidth: 1, borderTopColor: '#2a2a2a', paddingHorizontal: 16, paddingVertical: 8 }}>
            <TextInput
              style={{
                flex: 1,
                color: '#e0e0e0',
                backgroundColor: '#2a2a2e',
                borderRadius: 8,
                paddingHorizontal: 12,
                paddingVertical: 8,
                fontSize: 15,
              }}
              placeholder="输入消息…"
              placeholderTextColor="#666"
              value={input}
              onChangeText={setInput}
              onSubmitEditing={() => void handleSend()}
            />
            <TouchableOpacity
              disabled={!input.trim()}
              onPress={() => void handleSend()}
              style={{
                backgroundColor: input.trim() ? '#3b82f6' : '#1e3a5f',
                borderRadius: 8,
                paddingHorizontal: 16,
                paddingVertical: 10,
              }}
            >
              <Text style={{ color: '#fff', fontSize: 15 }}>发送</Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}
