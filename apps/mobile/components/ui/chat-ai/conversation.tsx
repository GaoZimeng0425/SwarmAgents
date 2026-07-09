import React, { type ReactElement, useCallback, useEffect, useRef } from 'react'
import type { LegendListRef } from '@legendapp/list'
import { AnimatedLegendList } from '@legendapp/list/reanimated'
import type { UIMessage } from 'ai'
import { ArrowDown, Download } from 'lucide-react-native'
import {
  Alert,
  type FlatList,
  type FlatListProps,
  type ListRenderItem,
  Platform,
  Text,
  TouchableOpacity,
  View,
} from 'react-native'
import { GestureDetector } from 'react-native-gesture-handler'

import { BlankProvider, useBlankContext } from './blank-context'
import { Message, MessageContent, MessageResponse } from './message'
import { useKeyboardAwareChat } from './useKeyboardAwareChat'

export const Conversation = ({ children, className }: ConversationProps) => (
  <BlankProvider>
    <View className={`flex-1 bg-background px-4 ${className || ''}`}>{children}</View>
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
  <View className={`flex-1 items-center justify-center ${className || ''}`}>
    <Text className="mt-4 font-semibold text-3xl text-foreground">{title}</Text>
  </View>
)

export type ConversationContentProps = {
  messages: UIMessage[]
  renderItem?: ListRenderItem<UIMessage>
  estimatedItemSize?: number
} & Omit<FlatListProps<UIMessage>, 'data' | 'renderItem'>

export const ConversationContent = ({
  messages,
  renderItem,
  estimatedItemSize = 140,
  ...flatListProps
}: ConversationContentProps) => {
  const flatListRef = useRef<FlatList<UIMessage> | LegendListRef>(null)

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

  const { scrollHandler, panGesture } = useKeyboardAwareChat()
  const { blankSize } = useBlankContext()

  const prevLengthRef = useRef(messages.length)

  useEffect(() => {
    const shouldScroll = messages.length > prevLengthRef.current && messages[messages.length - 1].role === 'user'

    if (shouldScroll && Platform.OS !== 'web') {
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
      {messages.length === 0 ? (
        <ConversationEmptyState />
      ) : (
        <AnimatedLegendList
          contentContainerStyle={{
            paddingBottom: blankSize.value,
          }}
          data={messages}
          estimatedItemSize={estimatedItemSize}
          initialNumToRender={15}
          keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
          keyExtractor={(item) => item.id}
          maxToRenderPerBatch={10}
          ref={flatListRef}
          removeClippedSubviews={Platform.OS !== 'web'}
          renderItem={renderItem || defaultRenderItem}
          scrollEventThrottle={16}
          showsVerticalScrollIndicator={false}
          windowSize={10}
          {...flatListProps}
        />
      )}
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
