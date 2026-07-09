import React, { Children, type ComponentProps, cloneElement, isValidElement, type ReactNode } from 'react'
import { X } from 'lucide-react-native'
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native'

import { Modal, ModalBackdrop, ModalBody, ModalCloseButton, ModalContent, ModalHeader } from '@/components/ui/modal'

// Context
const ModelSelectorContext = React.createContext<{
  open: boolean
  onOpenChange: (open: boolean) => void
} | null>(null)

const useModelSelector = () => {
  const ctx = React.useContext(ModelSelectorContext)
  if (!ctx) throw new Error('ModelSelector sub-components must be used inside <ModelSelector>')
  return ctx
}

// ─────────────────────────────────────────────────────────────
// Root
// ─────────────────────────────────────────────────────────────
export type ModelSelectorProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'full'
  children: ReactNode
}

export const ModelSelector = ({ open, onOpenChange, size = 'md', children }: ModelSelectorProps) => {
  const childrenArray = Children.toArray(children)

  const triggerChildren: ReactNode[] = []
  let contentElement: React.ReactElement | null = null

  childrenArray.forEach((child) => {
    if (isValidElement(child) && child.type === ModelSelectorContent) {
      contentElement = child
    } else {
      triggerChildren.push(child)
    }
  })

  return (
    <ModelSelectorContext.Provider value={{ open, onOpenChange }}>
      {triggerChildren}

      <Modal isOpen={open} onClose={() => onOpenChange(false)} size={size}>
        <ModalBackdrop />
        {contentElement}
      </Modal>
    </ModelSelectorContext.Provider>
  )
}

// ─────────────────────────────────────────────────────────────
// Trigger (asChild support)
// ─────────────────────────────────────────────────────────────
export type ModelSelectorTriggerProps = {
  asChild?: boolean
} & ComponentProps<typeof Pressable>

export const ModelSelectorTrigger = ({
  asChild = false,
  className,
  children,
  onPress: userOnPress,
  ...props
}: ModelSelectorTriggerProps) => {
  const { onOpenChange } = useModelSelector()

  const handlePress = () => {
    onOpenChange(true)
    userOnPress?.()
  }

  if (asChild && isValidElement(children)) {
    return cloneElement(children, {
      ...props,
      onPress: handlePress,
      className: `${children.props.className || ''} ${className || ''}`,
    } as any)
  }

  return (
    <Pressable
      className={`h-[40px] w-[200px] justify-between bg-primary ${className || ''}`}
      onPress={handlePress}
      {...props}
    >
      {children}
    </Pressable>
  )
}

// ─────────────────────────────────────────────────────────────
// Content — NOW passes size to ModalContent (this fixes the crash)
// ─────────────────────────────────────────────────────────────
export type ModelSelectorContentProps = ComponentProps<typeof ModalContent> & {
  title?: ReactNode
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'full' // ← added
}

export const ModelSelectorContent = ({
  title = 'Model Selector',
  children,
  className,
  size, // ← receive from root
  ...props
}: ModelSelectorContentProps) => (
  <ModalContent className={className} {...props}>
    <ModalHeader>
      <Text className="sr-only">{title}</Text>
      <ModalCloseButton>
        <X className="text-muted-foreground" size={20} />
      </ModalCloseButton>
    </ModalHeader>
    <ScrollView className="max-h-[500px]">
      <ModalBody>{children}</ModalBody>
    </ScrollView>
  </ModalContent>
)

// Rest of the components (unchanged)
export const ModelSelectorInput = ({ className, ...props }: ComponentProps<typeof TextInput>) => (
  <TextInput
    className={`h-12 border-border border-b px-4 text-base text-foreground placeholder:text-muted-foreground ${className || ''}`}
    placeholder="Search models..."
    {...props}
  />
)

export const ModelSelectorList = ({ className, ...props }: ComponentProps<typeof View>) => (
  <View className={`flex-1 ${className || 'w-full'}`} {...props} />
)

export const ModelSelectorEmpty = ({ className, ...props }: ComponentProps<typeof View>) => (
  <View className={`flex-1 items-center justify-center py-12 ${className || ''}`} {...props}>
    <Text className="text-muted-foreground">No models found.</Text>
  </View>
)

export const ModelSelectorGroup = ({
  heading,
  children,
  className,
  ...props
}: ComponentProps<typeof View> & { heading?: string }) => (
  <View className={className} {...props}>
    {heading && <Text className="px-4 py-2 font-semibold text-muted-foreground text-sm">{heading}</Text>}
    {children}
  </View>
)

export const ModelSelectorItem = ({
  isSelected = false,
  children,
  className,
  ...props
}: ComponentProps<typeof Pressable> & { isSelected?: boolean }) => {
  console.log(children)
  return (
    <Pressable
      className={`h-4 w-4 flex-row items-center px-4 py-3 ${isSelected ? 'bg-accent' : 'active:bg-muted'} ${className || ''}`}
      {...props}
    >
      {children}
    </Pressable>
  )
}

export const ModelSelectorShortcut = ({ className, ...props }: ComponentProps<typeof View>) => (
  <View className={`ml-auto ${className || ''}`} {...props} />
)

export const ModelSelectorSeparator = ({ className }: { className?: string }) => (
  <View className={`mx-4 my-1 h-px bg-border ${className || ''}`} />
)

export const ModelSelectorLogo = ({ provider }: { provider: string }) => (
  <View className="h-5 w-5 items-center justify-center rounded-full bg-muted">
    <Text className="font-medium text-[10px] text-foreground text-foreground">
      {provider.slice(0, 2).toUpperCase()}
    </Text>
  </View>
)

export const ModelSelectorLogoGroup = ({ children, className }: { children: ReactNode; className?: string }) => (
  <View className={`flex-row -space-x-1 ${className || ''}`}>{children}</View>
)

export const ModelSelectorName = ({ children, className }: { children: ReactNode; className?: string }) => (
  <Text className={`ml-3 flex-1 text-left text-base text-foreground ${className || ''}`}>{children}</Text>
)
