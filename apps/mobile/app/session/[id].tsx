import { useEffect, useMemo, useState } from 'react'
import type { MessageEvent, MessageWireEvent } from '@swarm/protocol'
import { useLocalSearchParams } from 'expo-router'
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native'

import { Box } from '@/components/ui/box'
import { Button, ButtonText } from '@/components/ui/button'
import { Heading } from '@/components/ui/heading'
import { HStack } from '@/components/ui/hstack'
import { Input, InputField } from '@/components/ui/input'
import { VStack } from '@/components/ui/vstack'
import { useEvents } from '@/hooks/use-events'
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
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [permissions, setPermissions] = useState<PermissionPrompt[]>([])

  // Subscribe to message.* events for this session.
  const filter = useMemo(() => (event: string) => event.startsWith('message.'), [])
  const events = useEvents(filter)

  // Load history on mount.
  useEffect(() => {
    if (!client || !sessionId) return
    void (async () => {
      try {
        const history = await client.getMessageEvents(sessionId)
        setMessages(history)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setLoading(false)
      }
    })()
  }, [client, sessionId])

  // Append live events to messages and extract permission prompts.
  useEffect(() => {
    if (events.length === 0) return
    const latest = events[events.length - 1]
    if (!latest.event.startsWith('message.')) return
    const wireEvent = latest.data as MessageWireEvent
    if (wireEvent.sessionId !== sessionId) return

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

    // Extract permission requests.
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

  const renderMessage = ({ item }: { item: MessageEvent }): React.JSX.Element => {
    const e = item.event as MessageWireEvent
    if (e.kind === 'message.created') {
      return (
        <Box className="mx-4 my-1 rounded-lg bg-muted/40 px-3 py-2">
          <Text className="text-sm text-typography-900">{e.prompt}</Text>
        </Box>
      )
    }
    if (e.kind === 'message.complete') {
      return (
        <Box className="mx-4 my-1 rounded-lg bg-primary-50 px-3 py-2">
          <Text className="text-sm text-typography-900">{e.summary}</Text>
        </Box>
      )
    }
    if (e.kind === 'message.error') {
      return (
        <Box className="mx-4 my-1 rounded-lg bg-error-50 px-3 py-2">
          <Text className="text-error-600 text-sm">⚠ {e.error.message}</Text>
        </Box>
      )
    }
    if (e.kind === 'message.progress') {
      return (
        <Box className="mx-4 my-1">
          <Text className="text-typography-400 text-xs italic">{String(e.event)}</Text>
        </Box>
      )
    }
    if (e.kind === 'message.permission_request') {
      // Permission prompts are rendered separately as cards at the bottom.
      return <></>
    }
    return <></>
  }

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <Box className="flex-1">
          <Box className="border-border border-b px-4 py-2">
            <Heading size="sm">会话</Heading>
          </Box>

          {error && (
            <Box className="px-4 py-1">
              <Text className="text-error-500 text-xs">{error}</Text>
            </Box>
          )}

          <FlatList
            data={messages}
            keyExtractor={(item, idx) => `${item.messageId}-${item.seq}-${idx}`}
            onContentSizeChange={() => {
              // Auto-scroll would go here with a ref; keeping simple for first phase.
            }}
            renderItem={renderMessage}
          />

          {/* Permission cards */}
          {permissions.length > 0 && (
            <Box className="gap-2 border-border border-t px-4 py-3">
              {permissions.map((perm) => (
                <Box className="rounded-lg border border-warning-300 bg-warning-50 p-3" key={perm.actionId}>
                  <Text className="font-medium text-sm text-warning-900">{perm.risk} 风险操作 · 需要审批</Text>
                  <Text className="mt-1 text-typography-700 text-xs">{perm.summary}</Text>
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
          <HStack className="items-center gap-2 border-border border-t px-4 py-2">
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
