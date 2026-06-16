import { create } from 'zustand'

export type AskOption = { label: string; value?: string }

export type AskPrompt = {
  askId: string
  sessionId: string
  taskId: string
  question: string
  options: AskOption[]
  mode: 'single' | 'multi'
}

type AskStore = {
  queue: AskPrompt[]
  /** sessionId → askId whose answer the next composer submit should fulfill ("Chat about this"). */
  pendingChat: Record<string, string>
  push: (p: AskPrompt) => void
  remove: (askId: string) => void
  setPendingChat: (sessionId: string, askId: string) => void
  clearPendingChat: (sessionId: string) => void
}

export const useAskStore = create<AskStore>((set) => ({
  queue: [],
  pendingChat: {},
  push: (p) => set((s) => (s.queue.some((x) => x.askId === p.askId) ? s : { queue: [...s.queue, p] })),
  remove: (id) => set((s) => ({ queue: s.queue.filter((x) => x.askId !== id) })),
  setPendingChat: (sessionId, askId) => set((s) => ({ pendingChat: { ...s.pendingChat, [sessionId]: askId } })),
  clearPendingChat: (sessionId) =>
    set((s) => {
      const { [sessionId]: _drop, ...rest } = s.pendingChat
      return { pendingChat: rest }
    }),
}))
