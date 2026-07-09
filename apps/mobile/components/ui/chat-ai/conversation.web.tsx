import React, { type ReactElement, useCallback, useEffect, useRef } from 'react'
import type { UIMessage } from 'ai'
import { ArrowDown, Download, MessageSquare } from 'lucide-react-native'
import { Alert, FlatList, type FlatListProps, type ListRenderItem, Text, TouchableOpacity, View } from 'react-native'

import { BlankProvider, useBlankContext } from './blank-context'
import { Message, MessageContent, MessageResponse } from './message'
import { useKeyboardAwareChat } from './useKeyboardAwareChat'

export type ConversationProps = React.PropsWithChildren<{ className?: string }>

export const Conversation = ({ children, className }: ConversationProps) => (
  <BlankProvider>
    <View className={`flex-1 bg-background ${className || ''}`}>{children}</View>
  </BlankProvider>
)

export type ConversationEmptyStateProps = {
  title?: string
  description?: string
  icon?: ReactElement
  className?: string
}

export const ConversationEmptyState = ({
  title = 'Start a conversation',
  description = 'Type a message below to begin chatting',
  icon,
  className,
}: ConversationEmptyStateProps) => (
  <View className={`flex-1 items-center justify-center px-10 py-12 ${className || ''}`}>
    {icon ?? <MessageSquare className="text-muted-foreground" size={48} />}
    <Text className="mt-4 font-semibold text-foreground text-xl">{title}</Text>
    <Text className="mt-2 text-center text-base text-muted-foreground">{description}</Text>
  </View>
)

export type ConversationContentProps = {
  messages: UIMessage[]
  renderItem?: ListRenderItem<UIMessage>
  estimatedItemSize?: number
} & Omit<FlatListProps<UIMessage>, 'data' | 'renderItem'>

export const ConversationContent = ({ messages, renderItem, ...flatListProps }: ConversationContentProps) => {
  const flatListRef = useRef<FlatList<UIMessage>>(null)

  const defaultRenderItem: ListRenderItem<UIMessage> = useCallback(
    ({ item: message, index }) => (
      <Message index={index} message={message} role={message.role}>
        <MessageContent>
          {message.parts
            ?.filter((part) => part.type === 'text')
            .map((part, i) => (
              <MessageResponse key={i} message={message} />
            ))}
        </MessageContent>
      </Message>
    ),
    []
  )

  const { scrollHandler } = useKeyboardAwareChat()
  const { blankSize } = useBlankContext()

  const prevLengthRef = useRef(messages.length)

  useEffect(() => {
    const shouldScroll = messages.length > prevLengthRef.current && messages[messages.length - 1].role === 'user'

    if (shouldScroll) {
      flatListRef.current?.scrollToEnd?.()
    }
    prevLengthRef.current = messages.length
  }, [messages])

  const { messagesContainerHeight } = useBlankContext()

  return (
    <View
      className="flex-1"
      onLayout={(e) => {
        const height = e.nativeEvent.layout.height
        messagesContainerHeight.value = height
      }}
    >
      <FlatList
        className="flex-1"
        contentContainerClassName="px-4 py-6 gap-6"
        contentContainerStyle={{
          paddingBottom: blankSize.value,
        }}
        data={messages}
        keyExtractor={(item) => item.id}
        ListEmptyComponent={messages.length === 0 ? <ConversationEmptyState /> : undefined}
        ref={flatListRef}
        renderItem={renderItem || defaultRenderItem}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={false}
        {...flatListProps}
      />
    </View>
  )
}

export const ConversationScrollButton = () => (
  <TouchableOpacity
    className="absolute bottom-6 left-1/2 h-11 w-11 -translate-x-1/2 items-center justify-center rounded-full bg-primary shadow-lg"
    onPress={() => {}}
  >
    <ArrowDown className="text-primary-foreground" size={22} />
  </TouchableOpacity>
)

export type ConversationDownloadProps = { messages: UIMessage[] }

export const ConversationDownload = ({ messages }: ConversationDownloadProps) => {
  const handleDownload = useCallback(() => {
    const markdown = messages
      .map((msg) => {
        const role = msg.role === 'user' ? 'User' : 'Assistant'
        const text = msg.parts
          ?.filter((p) => p.type === 'text')
          .map((p) => p.text)
          .join('\n')
        return `**${role}:**\n${text}`
      })
      .join('\n\n')
    Alert.alert('Download', `Markdown ready (${messages.length} messages)`)
  }, [messages])

  return (
    <TouchableOpacity className="absolute top-4 right-4 rounded-2xl bg-card p-3 shadow-sm" onPress={handleDownload}>
      <Download className="text-muted-foreground" size={20} />
    </TouchableOpacity>
  )
}
