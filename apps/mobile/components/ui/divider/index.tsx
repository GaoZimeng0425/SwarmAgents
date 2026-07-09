'use client'
import React from 'react'
import type { VariantProps } from '@gluestack-ui/utils/nativewind-utils'
import { tva } from '@gluestack-ui/utils/nativewind-utils'
import { Platform, View } from 'react-native'

const dividerStyle = tva({
  base: 'bg-border',
  variants: {
    orientation: {
      vertical: 'w-px h-full',
      horizontal: 'h-px w-auto',
    },
  },
})

type IUIDividerProps = React.ComponentPropsWithoutRef<typeof View> & VariantProps<typeof dividerStyle>

const Divider = React.forwardRef<React.ComponentRef<typeof View>, IUIDividerProps>(function Divider(
  { className, orientation = 'horizontal', ...props },
  ref
) {
  return (
    <View
      ref={ref}
      {...props}
      aria-orientation={orientation}
      className={dividerStyle({
        orientation,
        class: className,
      })}
      role={Platform.OS === 'web' ? 'separator' : undefined}
    />
  )
})

Divider.displayName = 'Divider'

export { Divider }
