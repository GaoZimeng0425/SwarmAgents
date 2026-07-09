import { Link } from 'expo-router'

import Logo from '@/assets/icons/Logo'
import { Box } from '@/components/ui/box'
import { Button, ButtonIcon, ButtonText } from '@/components/ui/button'
import { ArrowRightIcon } from '@/components/ui/icon'
import { Text } from '@/components/ui/text'
import { VStack } from '@/components/ui/vstack'

export default function Home() {
  return (
    <Box className="flex-1 bg-background">
      <VStack className="flex-1 items-center justify-center gap-8 px-6">
        <Logo />

        <VStack className="items-center gap-2">
          <Text className="font-bold text-2xl">Swarm Agents</Text>
          <Text className="text-center text-typography-400">
            Mobile app is running. Edit app/index.tsx to get started.
          </Text>
        </VStack>

        <Link asChild href="/details">
          <Button size="lg" variant="default">
            <ButtonText>View details</ButtonText>
            <ButtonIcon as={ArrowRightIcon} />
          </Button>
        </Link>
      </VStack>
    </Box>
  )
}
