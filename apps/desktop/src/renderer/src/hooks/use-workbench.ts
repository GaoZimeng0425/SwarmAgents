// React Query hooks for the workbench task board. Reads go through useQuery;
// mutations invalidate the workbench query on success. The main process also
// broadcasts state changes via onStateChanged, which triggers a refetch so
// changes from other windows / MCP propagate live.

import { useEffect } from 'react'
import {
  type AddColumnInput,
  type CreateTaskInput,
  emptyWorkbenchData,
  type MoveTaskInput,
  type UpdateTaskInput,
} from '@swarm/protocol'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

const QUERY_KEY = ['workbench'] as const

/** Load all tasks + columns, kept in sync with main's state-change broadcast.
 *  Overrides the global query-client defaults (staleTime: Infinity,
 *  refetchOnMount: false) which would otherwise suppress the initial fetch. */
export function useWorkbenchData() {
  return useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => window.swarm.workbench.getAll(),
    staleTime: 0,
    refetchOnMount: true,
    initialData: emptyWorkbenchData,
  })
}

/** Subscribe to main's state-change broadcast → invalidate so useQuery refetches.
 *  Call this once from the top-level WorkbenchView. */
export function useWorkbenchSync(): void {
  const qc = useQueryClient()
  useEffect(() => {
    const off = window.swarm.workbench.onStateChanged(() => {
      void qc.invalidateQueries({ queryKey: QUERY_KEY })
    })
    return off
  }, [qc])
}

export function useCreateTask() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateTaskInput) => window.swarm.workbench.createTask(input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: QUERY_KEY }),
  })
}

export function useUpdateTask() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateTaskInput }) => window.swarm.workbench.updateTask(id, patch),
    onSuccess: () => void qc.invalidateQueries({ queryKey: QUERY_KEY }),
  })
}

export function useCompleteTask() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => window.swarm.workbench.completeTask(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: QUERY_KEY }),
  })
}

export function useReopenTask() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => window.swarm.workbench.reopenTask(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: QUERY_KEY }),
  })
}

export function useDeleteTask() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => window.swarm.workbench.deleteTask(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: QUERY_KEY }),
  })
}

export function useMoveTask() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: MoveTaskInput) => window.swarm.workbench.moveTask(input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: QUERY_KEY }),
  })
}

export function useAddColumn() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: AddColumnInput) => window.swarm.workbench.addColumn(input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: QUERY_KEY }),
  })
}

export function useRenameColumn() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { id: string; name: string }) => window.swarm.workbench.renameColumn(input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: QUERY_KEY }),
  })
}

export function useDeleteColumn() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => window.swarm.workbench.deleteColumn(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: QUERY_KEY }),
  })
}

export function useReorderColumns() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (orderedIds: string[]) => window.swarm.workbench.reorderColumns(orderedIds),
    onSuccess: () => void qc.invalidateQueries({ queryKey: QUERY_KEY }),
  })
}
