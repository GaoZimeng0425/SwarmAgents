// src/main/gmail/ipc.ts
//
// Wires the Gmail service to Electron IPC (renderer-facing handlers) and
// exposes the main-rpc query handlers the service→main bridge dispatches to.
// Mirrors budgets/ipc.ts; broadcasts gmail:stateChanged to all windows.
import { createLogger } from '@shared/logger'
import type { GmailClientCreds, MainMethod, MainMethodSignatures } from '@swarm/protocol'

import { createIpcRegistrar, sendToAllWindows } from '../ipc/wire'
import type { Service } from './service'

const log = createLogger({ process: 'main' }).child({ component: 'gmail-ipc' })

type GmailMethod = Extract<MainMethod, `gmail.${string}`>
export type RpcHandlers = {
  [M in GmailMethod]: (...args: MainMethodSignatures[M]['args']) => Promise<unknown>
}

export function wireGmailIpc(args: { service: Service }): {
  dispose: () => void
  rpcHandlers: RpcHandlers
} {
  const { service } = args
  const ipc = createIpcRegistrar()

  const unsubscribe = service.onStateChanged((view) => {
    sendToAllWindows('gmail:stateChanged', view)
  })

  ipc.handle('gmail:getStatus', () => service.getView())
  ipc.handle('gmail:setClientCreds', (_e, creds: GmailClientCreds) => service.setClientCreds(creds))
  ipc.handle('gmail:clearClientCreds', () => service.clearClientCreds())
  ipc.handle('gmail:linkAccount', () => service.linkAccount())
  ipc.handle('gmail:unlinkAccount', () => service.unlinkAccount())
  ipc.handle('gmail:syncNow', () => service.syncNow())
  // Renderer-facing read access to the cache (the inbox view). The agent-tool
  // equivalents live in rpcHandlers below; these are the same service calls.
  ipc.handle('gmail:listRecent', (_e, input: { limit?: number; label?: string } | undefined) =>
    service.listRecent({ limit: input?.limit ?? 20, label: input?.label })
  )
  ipc.handle('gmail:getThread', (_e, id: string) => service.getThread(String(id)))
  ipc.handle('gmail:search', (_e, q: string, limit: number) => service.search(String(q), Number(limit ?? 20)))
  ipc.handle('gmail:getThreadAnalysis', (_e, threadId: string) => service.getThreadAnalysis(String(threadId)))
  ipc.handle(
    'gmail:saveThreadAnalysis',
    (_e, threadId: string, analysis: import('@swarm/protocol').ThreadAnalysisPayload) =>
      service.saveThreadAnalysis(String(threadId), analysis)
  )
  ipc.handle('gmail:analyzedThreadIds', () => service.analyzedThreadIds())
  ipc.handle('gmail:markThreadRead', (_e, threadId: string) => service.markThreadRead(String(threadId)))
  ipc.handle('gmail:listInboxPage', (_e, page: number) => service.listInboxPage(Number(page)))

  const rpcHandlers: RpcHandlers = {
    'gmail.search': (q, limit) => Promise.resolve(service.search(String(q), Number(limit ?? 20))),
    'gmail.get_thread': (id) => Promise.resolve(service.getThread(String(id))),
    'gmail.list_recent': (input) => {
      const opts = (input as { limit?: number; label?: string } | undefined) ?? {}
      return Promise.resolve(service.listRecent({ limit: opts.limit ?? 20, label: opts.label }))
    },
    'gmail.save_thread_analysis': (threadId, analysis) =>
      Promise.resolve(
        service.saveThreadAnalysis(String(threadId), analysis as import('@swarm/protocol').ThreadAnalysisPayload)
      ),
  }

  log.info({ msg: 'gmail IPC wired' })

  return {
    dispose() {
      unsubscribe()
      ipc.dispose()
    },
    rpcHandlers,
  }
}
