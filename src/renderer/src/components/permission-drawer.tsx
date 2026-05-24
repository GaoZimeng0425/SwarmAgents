// src/renderer/src/components/permission-drawer.tsx
//
// Medium-risk permission UI. Renders as a fixed bottom card with no backdrop
// (ship B.19: no modal overlays with backdrop blur for "dialogs"). Dismissible
// by Escape. High-risk goes through native dialog.showMessageBox via
// useNativeConfirm; low-risk is auto-granted by the main-process permission
// gate and never reaches the renderer.
import { useEffect } from 'react'

import type { PermissionDecision } from '@shared/types/ui'

import { Button } from '@/components/ui/button'
import type { PermissionPrompt } from '@/stores/permission'

type Props = {
  prompt: PermissionPrompt | null
  onDecide: (actionId: string, decision: PermissionDecision) => void
}

export function PermissionDrawer({ prompt, onDecide }: Props): React.JSX.Element | null {
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

  if (!prompt) return null

  return (
    <div
      role="dialog"
      aria-label="Action requires confirmation"
      className="fixed inset-x-0 bottom-0 z-40 max-h-[70vh] overflow-auto border-t border-border bg-popover/95 px-6 py-4 shadow-lg"
    >
      <div className="flex flex-col gap-3">
        <header>
          <h2 className="text-base font-medium">Action requires confirmation</h2>
          <p className="text-sm text-muted-foreground">
            Task {prompt.taskId} · risk: <strong>{prompt.risk}</strong>
          </p>
        </header>
        <div className="text-sm">{prompt.summary}</div>
        <pre className="max-h-40 overflow-auto rounded bg-muted p-3 font-mono text-xs">
          {JSON.stringify(prompt.payload, null, 2)}
        </pre>
        <footer className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => { onDecide(prompt.actionId, 'skip') }}>
            Skip
          </Button>
          <Button onClick={() => { onDecide(prompt.actionId, 'grant') }}>Allow</Button>
          <Button variant="destructive" onClick={() => { onDecide(prompt.actionId, 'deny') }}>
            Deny
          </Button>
        </footer>
      </div>
    </div>
  )
}
