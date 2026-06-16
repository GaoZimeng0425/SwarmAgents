import type { MemoryView } from '@shared/types/memory'
import { useQuery } from '@tanstack/react-query'

import { swarmApi } from '@/lib/api'

export const MEMORY_KEY = ['memory'] as const

export function useMemory(): { entries: MemoryView[]; isError: boolean; refetch: () => void } {
  const { data, isError, refetch } = useQuery<MemoryView[]>({
    queryKey: MEMORY_KEY,
    queryFn: () => swarmApi.listMemory(),
  })
  return { entries: data ?? [], isError, refetch: () => void refetch() }
}
