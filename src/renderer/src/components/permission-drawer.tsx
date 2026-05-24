// src/renderer/src/components/permission-drawer.tsx
//
// Medium-risk permission UI. Renders as a bottom drawer with no backdrop
// (ship B.19: no modal overlays with backdrop blur for "dialogs"). Dismissible
// by Escape. High-risk goes through native dialog.showMessageBox via
// useNativeConfirm; low-risk is auto-granted by the main-process permission
// gate and never reaches the renderer.
import type { PermissionDecision } from '@shared/types/ui'

import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import type { PermissionPrompt } from '@/stores/permission'

type Props = {
  prompt: PermissionPrompt | null
  onDecide: (actionId: string, decision: PermissionDecision) => void
}

export function PermissionDrawer({ prompt, onDecide }: Props): React.JSX.Element {
  const open = prompt !== null
  return (
    <Sheet open={open}>
      <SheetContent
        side="bottom"
        // Override the default backdrop: shadcn Sheet renders an overlay with
        // bg-black/10 + backdrop-blur. We don't want either for native feel.
        className="max-h-[70vh] border-t bg-popover/95 shadow-lg [&~div[role=presentation]]:hidden"
      >
        {prompt && (
          <>
            <SheetHeader>
              <SheetTitle>Action requires confirmation</SheetTitle>
              <SheetDescription>
                Task {prompt.taskId} · risk: <strong>{prompt.risk}</strong>
              </SheetDescription>
            </SheetHeader>
            <div className="my-4 text-sm">{prompt.summary}</div>
            <pre className="max-h-40 overflow-auto rounded bg-muted p-3 font-mono text-xs">
              {JSON.stringify(prompt.payload, null, 2)}
            </pre>
            <SheetFooter className="gap-2">
              <Button variant="secondary" onClick={() => { onDecide(prompt.actionId, 'skip') }}>
                Skip
              </Button>
              <Button onClick={() => { onDecide(prompt.actionId, 'grant') }}>Allow</Button>
              <Button variant="destructive" onClick={() => { onDecide(prompt.actionId, 'deny') }}>
                Deny
              </Button>
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
