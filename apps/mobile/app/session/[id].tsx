import { useEffect, useMemo, useRef, useState } from 'react'
import type { MessageEvent, MessageWireEvent } from '@swarm/protocol'
import { useLocalSearchParams } from 'expo-router'
import Markdown from 'react-native-markdown-display'
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  Text,
  View,
} from 'react-native'

import { markdownRules } from '@/components/ui/chat-ai/message'
import { Box } from '@/components/ui/box'
import { Button, ButtonText } from '@/components/ui/button'
import { Heading } from '@/components/ui/heading'
import { HStack } from '@/components/ui/hstack'
import { Input, InputField } from '@/components/ui/input'
import { useEvents } from '@/hooks/use-events'
import { type Segment, buildSegments } from '@/lib/task-segments'
import { useConnection } from '@/stores/connection-store'

type PermissionPrompt = {
  messageId: string
  actionId: string
  risk: string
  summary: string
}

export default function SessionDetailScreen(): React.JSX.Element {
  const { id: sessionId } = useLocalSearchParams<{ id: string }>()
  const { client } = useConnection()
  const [messages, setMessages] = useState<MessageEvent[]>([])
  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [permissions, setPermissions] = useState<PermissionPrompt[]>([])
  // Tracks how many events from the `events` buffer have already been processed
  // into messages/permissions, so a render batch carrying multiple events isn't
  // reduced to just the last one.
  const processedCountRef = useRef(0)

  // Subscribe to message.* events for this session.
  const filter = useMemo(() => (event: string) => event.startsWith('message.'), [])
  const events = useEvents(filter)

  // Flatten raw events into render segments (assistant chunks coalesced, tools paired, etc.)
  const segments = useMemo(() => buildSegments(messages), [messages])

  // Load history on mount.
  useEffect(() => {
    if (!client || !sessionId) return
    void (async () => {
      try {
        const history = await client.getMessageEvents(sessionId)
        setMessages(history)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    })()
  }, [client, sessionId])

  // Reset the processed-events cursor when switching sessions.
  useEffect(() => {
    processedCountRef.current = 0
  }, [sessionId])

  // Append live events to messages and extract permission prompts.
  useEffect(() => {
    if (events.length === 0) return
    const newEvents = events.slice(processedCountRef.current)
    processedCountRef.current = events.length

    for (const latest of newEvents) {
      if (!latest.event.startsWith('message.')) continue
      const wireEvent = latest.data as MessageWireEvent
      if (wireEvent.sessionId !== sessionId) continue

      setMessages((prev) => [
        ...prev,
        {
          messageId: wireEvent.messageId,
          parentMessageId: wireEvent.parentMessageId ?? null,
          seq: wireEvent.seq,
          ts: wireEvent.ts,
          event: wireEvent,
        },
      ])

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
          <Box className="mx-4 my-1 flex flex-row justify-end">
            <Box className="max-w-[85%] rounded-lg bg-muted/60 px-3 py-2">
              <Text className="text-sm text-typography-900">{item.text}</Text>
            </Box>
          </Box>
        )

      case 'assistant':
        return (
          <Box className="mx-4 my-1 max-w-[90%]">
            <Markdown rules={markdownRules}>{item.text}</Markdown>
          </Box>
        )

      case 'reasoning':
        return (
          <Box className="mx-4 my-1 rounded-lg border border-border/50 bg-muted/20 px-3 py-2">
            <Text className="text-xs italic text-typography-400">{item.text}</Text>
          </Box>
        )

      case 'tool':
        return (
          <Box className="mx-4 my-1 rounded-lg border border-border/50 bg-muted/20 px-3 py-2">
            <Text className="text-xs font-medium text-typography-600">
              🔧 {item.tool}
              {item.ok === null ? ' ⋯' : item.ok ? ' ✓' : ' ✗'}
            </Text>
            {item.output && (
              <Text className="mt-1 font-mono text-xs text-typography-400" numberOfLines={5}>
                {item.output}
              </Text>
            )}
          </Box>
        )

      case 'error':
        return (
          <Box className="mx-4 my-1 rounded-lg bg-error-50 px-3 py-2">
            <Text className="text-sm text-error-600">
              {item.label === 'stopped' ? '⏹' : '⚠'} {item.detail}
            </Text>
          </Box>
        )

      case 'event':
        return (
          <Box className="mx-4 my-1">
            <Text className="text-xs text-typography-400">
              {item.label}: {item.detail}
            </Text>
          </Box>
        )
    }
  }

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <Box className="flex-1">
          <Box className="border-b border-border px-4 py-2">
            <Heading size="sm">会话</Heading>
          </Box>

          {error && (
            <Box className="px-4 py-1">
              <Text className="text-xs text-error-500">{error}</Text>
            </Box>
          )}

          <FlatList
            data={segments}
            keyExtractor={(item) => item.key}
            renderItem={renderSegment}
          />

          {/* Permission cards */}
          {permissions.length > 0 && (
            <Box className="gap-2 border-t border-border px-4 py-3">
              {permissions.map((perm) => (
                <Box className="rounded-lg border border-warning-300 bg-warning-50 p-3" key={perm.actionId}>
                  <Text className="text-sm font-medium text-warning-900">{perm.risk} 风险操作 · 需要审批</Text>
                  <Text className="mt-1 text-xs text-typography-700">{perm.summary}</Text>
                  <HStack className="mt-2 gap-2">
                    <Button onPress={() => void handlePermission(perm, 'grant')} size="sm">
                      <ButtonText>批准</ButtonText>
                    </Button>
                    <Button onPress={() => void handlePermission(perm, 'deny')} size="sm" variant="outline">
                      <ButtonText>拒绝</ButtonText>
                    </Button>
                  </HStack>
                </Box>
              ))}
            </Box>
          )}

          {/* Input bar */}
          <HStack className="items-center gap-2 border-t border-border px-4 py-2">
            <Input className="flex-1">
              <InputField
                onChangeText={setInput}
                onSubmitEditing={() => void handleSend()}
                placeholder="输入消息…"
                value={input}
              />
            </Input>
            <Button isDisabled={!input.trim()} onPress={() => void handleSend()}>
              <ButtonText>发送</ButtonText>
            </Button>
          </HStack>
        </Box>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}
