import React from 'react'
import { router, Stack } from 'expo-router'
import { Pressable } from 'react-native'

import { Box } from '@/components/ui/box'
import { Heading } from '@/components/ui/heading'
import { ArrowLeftIcon, InfoIcon } from '@/components/ui/icon'
import { Text } from '@/components/ui/text'
import { VStack } from '@/components/ui/vstack'

export default function DetailsScreen() {
  return (
    <>
      <Stack.Screen options={{ title: 'Details' }} />
      <Box className="flex-1 bg-background">
        <VStack className="flex-1 items-center justify-center gap-6 px-6">
          <InfoIcon className="h-12 w-12 text-primary-500" />

          <VStack className="items-center gap-2">
            <Heading size="xl">Details</Heading>
            <Text className="text-center text-typography-400">
              This is a second route. Add more screens under app/ and they become routes automatically.
            </Text>
          </VStack>

          <Pressable
            className="flex-row items-center justify-center gap-2 rounded-md border border-border bg-background px-8 py-2 active:opacity-80"
            onPress={() => router.back()}
          >
            <ArrowLeftIcon className="h-4 w-4 text-foreground" />
            <Text className="text-foreground text-sm">Go back</Text>
          </Pressable>
        </VStack>
      </Box>
    </>
  )
}
