import { memo } from 'react'
import { Streamdown } from 'streamdown'

import { cn } from '@/lib/utils'

// Streaming-aware markdown. Streamdown parses incomplete markdown gracefully
// (unterminated bold/code fences while text is still streaming) and ships shiki
// code highlighting + copy controls, so it suits our coalesced streaming bubble.
// Its baked-in utility classes are picked up via the `@source` line in globals.css.
export const Markdown = memo(function Markdown({
  children,
  className,
}: {
  children: string
  className?: string
}): React.JSX.Element {
  return (
    <Streamdown
      className={cn('text-sm [&>*:first-child]:mt-0 [&>*:last-child]:mb-0', className)}
      parseIncompleteMarkdown
    >
      {children}
    </Streamdown>
  )
})
