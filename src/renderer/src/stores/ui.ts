import { create } from 'zustand'

type UiStore = {
  selectedTaskId: string | null
  setSelected: (id: string | null) => void
}

export const useUiStore = create<UiStore>((set) => ({
  selectedTaskId: null,
  setSelected: (id) => set({ selectedTaskId: id }),
}))
