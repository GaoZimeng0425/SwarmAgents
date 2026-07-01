// src/renderer/src/components/permission-card.tsx
//
// 单个权限申请卡片(非模态、无 backdrop)。由 ComposerOverlay 叠加渲染:多个
// 待决申请时一个 prompt 一张卡。所有风险等级(medium/high)都经此卡决策;low
// 由主进程 permission gate 自动放行,不到渲染层。高风险仅做视觉区分
// (destructive 样式 + 栈顶卡默认焦点落在 Deny),不加二次确认门槛。Escape
// 处理(skip 栈顶)上移到 ComposerOverlay。
import { useEffect, useRef } from 'react'
import type { PermissionDecision } from '@swarm/protocol'

import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import type { PermissionPrompt } from '@/stores/permission'

type Props = {
  prompt: PermissionPrompt
  onDecide: (actionId: string, decision: PermissionDecision) => void
  /** Top-of-stack card parks focus on Deny so the safe choice is the default. */
  autoFocusDeny?: boolean
}

export function PermissionCard({ prompt, onDecide, autoFocusDeny = false }: Props): React.JSX.Element {
  const denyRef = useRef<HTMLButtonElement>(null)
  const isHigh = prompt.risk === 'high'

  useEffect(() => {
    if (autoFocusDeny && isHigh) denyRef.current?.focus()
  }, [autoFocusDeny, isHigh])

  return (
    <section
      aria-label="Action requires confirmation"
      className={cn(
        'flex max-h-[50vh] shrink-0 flex-col overflow-hidden rounded-xl border bg-popover shadow-sm',
        isHigh ? 'border-destructive/50 ring-1 ring-destructive/30' : 'border-border'
      )}
      data-risk={prompt.risk}
    >
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-3 px-4 py-3">
          <header>
            <h2 className={cn('font-medium text-base', isHigh && 'text-destructive')}>Action requires confirmation</h2>
            <p className="text-muted-foreground text-sm">
              Task {prompt.taskId} · risk: <strong>{prompt.risk}</strong>
            </p>
          </header>
          <div className="text-sm">{prompt.summary}</div>
          <ScrollArea className="max-h-40 rounded bg-muted">
            <pre className="p-3 font-mono text-xs">{JSON.stringify(prompt.payload, null, 2)}</pre>
          </ScrollArea>
          <footer className="flex justify-end gap-2">
            <Button
              onClick={() => {
                onDecide(prompt.actionId, 'skip')
              }}
              variant="secondary"
            >
              Skip
            </Button>
            <Button
              onClick={() => {
                onDecide(prompt.actionId, 'grant')
              }}
            >
              Allow
            </Button>
            <Button
              onClick={() => {
                onDecide(prompt.actionId, 'deny')
              }}
              ref={denyRef}
              variant="destructive"
            >
              Deny
            </Button>
          </footer>
        </div>
      </ScrollArea>
    </section>
  )
}
