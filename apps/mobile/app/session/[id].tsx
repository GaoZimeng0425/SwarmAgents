import { useEffect, useMemo, useState } from 'react'
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
import { useQueryClient } from '@tanstack/react-query'

import { markdownRules } from '@/components/ui/chat-ai/message'
import { useConnection } from '@/stores/connection-store'
import {
  type Segment,
  buildSegments,
  hydrateSession,
  useMessages,
} from '@swarm/shared'
import type { MessageWireEvent } from '@swarm/protocol'

type PermissionPrompt = {
  messageId: string
  actionId: string
  risk: string
  summary: string
}

export default function SessionDetailScreen(): React.JSX.Element {
  const { id: sessionId } = useLocalSearchParams<{ id: string }>()
  const { client } = useConnection()
  const qc = useQueryClient()
  const messages = useMessages()
  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [permissions, setPermissions] = useState<PermissionPrompt[]>([])

  // Hydrate history on mount / session switch.
  useEffect(() => {
    if (!client || !sessionId) return
    void hydrateSession(qc, { getMessageEvents: (sid) => client.getMessageEvents(sid), subscribeEvents: () => () => {} }, sessionId)
  }, [client, sessionId, qc])

  // Watch for permission_request events in the message records.
  useEffect(() => {
    if (!sessionId) return
    const sessionMessages = messages.filter((m) => m.sessionId === sessionId)
    const perms: PermissionPrompt[] = []
    for (const msg of sessionMessages) {
      for (const evt of msg.events) {
        const wire = evt as MessageWireEvent
        if (wire.kind === 'message.permission_request' && wire.sessionId === sessionId) {
          perms.push({
            messageId: wire.messageId,
            actionId: wire.actionId,
            risk: wire.risk,
            summary: wire.summary,
          })
        }
      }
    }
    setPermissions(perms)
  }, [messages, sessionId])

  // Flatten all MessageRecords for this session into render segments.
  const segments = useMemo(() => {
    const sessionMessages = messages
      .filter((m) => m.sessionId === sessionId)
      .sort((a, b) => b.order - a.order)
    return sessionMessages.flatMap((r) => buildSegments(r.events))
  }, [messages, sessionId])

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
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1 }}
      >
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
