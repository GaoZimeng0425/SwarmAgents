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

export function PermissionSheet({ prompt, onDecide }: Props): React.JSX.Element {
  const open = prompt !== null
  return (
    <Sheet open={open}>
      <SheetContent side="bottom" className="max-h-[70vh]">
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
              <Button variant="secondary" onClick={() => onDecide(prompt.actionId, 'skip')}>
                Skip
              </Button>
              <Button
                variant={prompt.risk === 'high' ? 'destructive' : 'default'}
                onClick={() => onDecide(prompt.actionId, 'grant')}
              >
                Allow
              </Button>
              <Button variant="destructive" onClick={() => onDecide(prompt.actionId, 'deny')}>
                Deny
              </Button>
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
