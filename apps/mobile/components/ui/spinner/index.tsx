'use client'
import React from 'react'
import { tva } from '@gluestack-ui/utils/nativewind-utils'
import { styled } from 'nativewind'
import { ActivityIndicator } from 'react-native'

const StyledActivityIndicator = styled(ActivityIndicator, {
  className: { target: 'style', nativeStyleToProp: { color: true } },
})
const spinnerStyle = tva({})

const Spinner = React.forwardRef<
  React.ComponentRef<typeof ActivityIndicator>,
  React.ComponentProps<typeof ActivityIndicator>
>(function Spinner({ className, color, focusable = false, 'aria-label': ariaLabel = 'loading', ...props }, ref) {
  return (
    <StyledActivityIndicator
      aria-label={ariaLabel}
      focusable={focusable}
      ref={ref}
      {...props}
      className={spinnerStyle({ class: className })}
      color={color}
    />
  )
})

Spinner.displayName = 'Spinner'

export { Spinner }
