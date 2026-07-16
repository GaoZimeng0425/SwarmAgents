import { useEffect, useMemo, useState } from 'react'
import type { Risk } from '@swarm/protocol'
import { applyWireEvent, buildSegments, emptySessionView, hydrate, type Segment, type SessionView } from '@swarm/shared'
import { router, useLocalSearchParams } from 'expo-router'
import { ChevronLeft } from 'lucide-react-native'
import { FlatList, KeyboardAvoidingView, Platform, Text, TextInput, TouchableOpacity, View } from 'react-native'
import Markdown from 'react-native-markdown-display'
import { SafeAreaView } from 'react-native-safe-area-context'

import { markdownRules } from '@/components/ui/chat-ai/message'
import { useAgentWireEvents } from '@/hooks/use-events'
import { useConnection } from '@/stores/connection-store'

type PermissionPrompt = {
  actionId: string
  risk: Risk
  summary: string
}

export default function SessionDetailScreen(): React.JSX.Element {
  const { id: sessionId } = useLocalSearchParams<{ id: string }>()
  const { client } = useConnection()
  const [view, setView] = useState<SessionView>(emptySessionView)
  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [permissions, setPermissions] = useState<PermissionPrompt[]>([])

  // Catch-up load on mount / session switch: pull the full entry log and
  // start a fresh view from it. Live events fold in separately below.
  useEffect(() => {
    setView(emptySessionView())
    setPermissions([])
    if (!client || !sessionId) return
    let alive = true
    void client.getSessionEntries(sessionId).then((rows) => {
      if (!alive) return
      setView((prev) => hydrate(prev, rows))
    })
    return () => {
      alive = false
    }
  }, [client, sessionId])

  // Fold live wire events for this session into the view, and track pending
  // permission_request prompts — cleared on decide or when the run ends.
  useAgentWireEvents((e) => {
    if (e.sessionId !== sessionId) return
    setView((prev) => applyWireEvent(prev, e))
    if (e.kind === 'permission_request') {
      setPermissions((prev) =>
        prev.some((p) => p.actionId === e.actionId)
          ? prev
          : [...prev, { actionId: e.actionId, risk: e.risk, summary: e.summary }]
      )
    }
    if (e.kind === 'agent_end') setPermissions([])
  })

  // Flatten the session's entry log into render segments.
  const segments = useMemo(() => buildSegments(view), [view])

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
            <View
              style={{
                maxWidth: '85%',
                borderRadius: 12,
                backgroundColor: '#2a2a2e',
                paddingHorizontal: 12,
                paddingVertical: 8,
              }}
            >
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
          <View
            style={{
              marginHorizontal: 16,
              marginVertical: 4,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: '#333',
              backgroundColor: '#1e1e22',
              paddingHorizontal: 12,
              paddingVertical: 8,
            }}
          >
            <Text style={{ color: '#888', fontSize: 13, fontStyle: 'italic' }}>{item.text}</Text>
          </View>
        )
      case 'tool':
        return (
          <View
            style={{
              marginHorizontal: 16,
              marginVertical: 4,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: '#333',
              backgroundColor: '#1e1e22',
              paddingHorizontal: 12,
              paddingVertical: 8,
            }}
          >
            <Text style={{ color: '#aaa', fontSize: 13, fontWeight: '500' }}>
              🔧 {item.tool}
              {item.ok === null ? ' ⋯' : item.ok ? ' ✓' : ' ✗'}
            </Text>
            {item.output && (
              <Text numberOfLines={5} style={{ marginTop: 4, color: '#777', fontSize: 12, fontFamily: 'monospace' }}>
                {item.output}
              </Text>
            )}
          </View>
        )
      case 'error':
        return (
          <View
            style={{
              marginHorizontal: 16,
              marginVertical: 4,
              borderRadius: 8,
              backgroundColor: '#3a1518',
              paddingHorizontal: 12,
              paddingVertical: 8,
            }}
          >
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
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
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

          <FlatList data={segments} keyExtractor={(item) => item.key} renderItem={renderSegment} />

          {/* Permission cards */}
          {permissions.length > 0 && (
            <View
              style={{
                gap: 8,
                borderTopWidth: 1,
                borderTopColor: '#2a2a2a',
                paddingHorizontal: 16,
                paddingVertical: 12,
              }}
            >
              {permissions.map((perm) => (
                <View
                  key={perm.actionId}
                  style={{
                    borderRadius: 8,
                    borderWidth: 1,
                    borderColor: '#856404',
                    backgroundColor: '#1e1a0e',
                    padding: 12,
                  }}
                >
                  <Text style={{ color: '#fbbf24', fontSize: 14, fontWeight: '500' }}>
                    {perm.risk} 风险操作 · 需要审批
                  </Text>
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
                      style={{
                        borderWidth: 1,
                        borderColor: '#555',
                        borderRadius: 8,
                        paddingHorizontal: 16,
                        paddingVertical: 6,
                      }}
                    >
                      <Text style={{ color: '#ccc', fontSize: 14 }}>拒绝</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ))}
            </View>
          )}

          {/* Input bar */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
              borderTopWidth: 1,
              borderTopColor: '#2a2a2a',
              paddingHorizontal: 16,
              paddingVertical: 8,
            }}
          >
            <TextInput
              onChangeText={setInput}
              onSubmitEditing={() => void handleSend()}
              placeholder="输入消息…"
              placeholderTextColor="#666"
              style={{
                flex: 1,
                color: '#e0e0e0',
                backgroundColor: '#2a2a2e',
                borderRadius: 8,
                paddingHorizontal: 12,
                paddingVertical: 8,
                fontSize: 15,
              }}
              value={input}
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
