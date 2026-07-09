import React from 'react'
import type { VariantProps } from '@gluestack-ui/utils/nativewind-utils'

import { skeletonStyle, skeletonTextStyle } from './styles'

type ISkeletonProps = React.ComponentPropsWithoutRef<'div'> &
  VariantProps<typeof skeletonStyle> & {
    startColor?: string
    isLoaded?: boolean
  }

const Skeleton = React.forwardRef<HTMLDivElement, ISkeletonProps>(function Skeleton(
  {
    className,
    variant = 'rounded',
    children,
    speed = 4,
    startColor = 'bg-muted-foreground/20',
    isLoaded = false,
    ...props
  },
  ref
) {
  if (!isLoaded) {
    return (
      <div
        className={`animate-pulse ${startColor} ${skeletonStyle({
          variant,
          speed,
          class: className,
        })}`}
        ref={ref}
        {...props}
      />
    )
  }
  return children
})

type ISkeletonTextProps = React.ComponentPropsWithoutRef<'div'> &
  VariantProps<typeof skeletonTextStyle> & {
    _lines?: number
    isLoaded?: boolean
    startColor?: string
  }

const SkeletonText = React.forwardRef<HTMLDivElement, ISkeletonTextProps>(function SkeletonText(
  { className, _lines, isLoaded = false, startColor = 'bg-muted-foreground/20', gap = 2, children, ...props },
  ref
) {
  if (!isLoaded) {
    if (_lines) {
      return (
        <div
          className={`flex flex-col ${skeletonTextStyle({
            gap,
          })}`}
          ref={ref}
        >
          {Array.from({ length: _lines }).map((_, index) => (
            <div
              className={`animate-pulse ${startColor} ${skeletonTextStyle({
                class: className,
              })}`}
              key={index}
              {...props}
            />
          ))}
        </div>
      )
    }
    return (
      <div
        className={`animate-pulse ${startColor} ${skeletonTextStyle({
          class: className,
        })}`}
        ref={ref}
        {...props}
      />
    )
  }
  return children
})

Skeleton.displayName = 'Skeleton'
SkeletonText.displayName = 'SkeletonText'

export { Skeleton, SkeletonText }
