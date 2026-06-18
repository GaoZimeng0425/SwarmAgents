// src/renderer/src/components/permission-drawer.tsx
//
// 权限申请面板。渲染为 chat 列内、紧贴 composer 上方的内联滑出面板(非模态、
// 无 backdrop),进场上滑淡入。所有风险等级(medium/high)都经此面板决策;
// low 由主进程 permission gate 自动放行,不到渲染层。高风险仅做视觉区分
// (destructive 样式 + 默认焦点落在 Deny),不加二次确认门槛。Escape = skip。
import { useEffect, useRef } from 'react'
import type { PermissionDecision } from '@shared/types/ui'

import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import type { PermissionPrompt } from '@/stores/permission'

type Props = {
  prompt: PermissionPrompt | null
  onDecide: (actionId: string, decision: PermissionDecision) => void
}

export function PermissionDrawer({ prompt, onDecide }: Props): React.JSX.Element | null {
  const denyRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!prompt) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onDecide(prompt.actionId, 'skip')
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [prompt, onDecide])

  // High-risk: park focus on Deny so the safe choice is the default.
  useEffect(() => {
    if (prompt?.risk === 'high') denyRef.current?.focus()
  }, [prompt])

  if (!prompt) return null

  const isHigh = prompt.risk === 'high'

  return (
    <section
      aria-label="Action requires confirmation"
      className={cn(
        'mx-3 mb-2 flex max-h-[50vh] shrink-0 flex-col overflow-hidden rounded-xl border bg-popover/95 shadow-lg',
        'fade-in-0 slide-in-from-bottom-3 animate-in duration-200',
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
