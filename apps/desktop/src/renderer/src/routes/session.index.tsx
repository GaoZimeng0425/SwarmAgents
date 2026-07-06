import { useEffect } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { MessagesSquare } from 'lucide-react'

import { useSessionsStore } from '@/stores/sessions'

export const Route = createFileRoute('/session/')({ component: SessionIndexView })

// Landing for the 对话 rail item: shows the SessionPanel list (gated by
// isConversationScene in __root) with a placeholder where a conversation would
// appear. Mirrors routes/index.tsx by clearing any stale selection on mount.
function SessionIndexView(): React.JSX.Element {
  const select = useSessionsStore((s) => s.select)
  useEffect(() => {
    select(null)
  }, [select])

  return (
    <div className="flex size-full flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="text-muted-foreground">
        <MessagesSquare aria-hidden="true" className="size-6 opacity-60" />
      </div>
      <div className="space-y-1">
        <h3 className="font-medium text-sm">选择一个会话开始</h3>
        <p className="text-muted-foreground text-sm">或点击左上 “New chat” 新建对话</p>
      </div>
    </div>
  )
}
