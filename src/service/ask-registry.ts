import { ulid } from 'ulid'

export type AskMode = 'single' | 'multi'
export type AskOption = { label: string; value?: string }

type Pending = { resolve: (answer: string) => void }

export type AskRegistry = {
  /** Ask the human a question and block until they respond. Resolves with the chosen answer text. */
  request(req: { taskId: string; question: string; options: AskOption[]; mode: AskMode }): Promise<string>
  resolve(askId: string, answer: string): void
  /** Resolve every outstanding ask (e.g. on cancel) so awaiting tools don't hang. */
  cancelAll(reason: string): void
}

/**
 * Human-in-the-loop choice channel. Mirrors {@link createPermissionRegistry}:
 * a tool calls `request`, the UI shows option buttons, and `resolve` (driven by
 * the renderer over IPC) unblocks the tool with the chosen answer. Unlike
 * permissions there is no timeout — a human judgment call has no deadline; a
 * cancelled run clears pending asks via `cancelAll`.
 */
export function createAskRegistry(broadcast: (event: string, data: unknown) => void): AskRegistry {
  const pending = new Map<string, Pending>()

  return {
    request(req) {
      const askId = ulid()
      return new Promise<string>((resolve) => {
        pending.set(askId, { resolve })
        broadcast('task.ask', { askId, ...req })
      })
    },

    resolve(askId, answer) {
      const p = pending.get(askId)
      if (!p) return
      pending.delete(askId)
      p.resolve(answer)
    },

    cancelAll(reason) {
      for (const [, p] of pending) p.resolve(reason)
      pending.clear()
    },
  }
}
