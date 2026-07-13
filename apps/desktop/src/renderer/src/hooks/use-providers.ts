// src/renderer/src/hooks/use-providers.ts
//
// Subscribes to providers state from main and derives the `ready` flag used
// by the main-window banner (Task 19) and any future task-creation surface.

import { useEffect, useMemo } from 'react'
import { type ProvidersStateView, providerViewById } from '@swarm/protocol'
import { useQuery, useQueryClient } from '@tanstack/react-query'

export const PROVIDERS_KEY = ['providers'] as const

const EMPTY: ProvidersStateView = {
  active: null,
  providers: [],
}

export type UseProviders = {
  state: ProvidersStateView
  ready: boolean
  refetch: () => void
}

export function useProviders(): UseProviders {
  const qc = useQueryClient()

  const { data, refetch } = useQuery<ProvidersStateView>({
    queryKey: PROVIDERS_KEY,
    queryFn: () => window.swarm.providers.get(),
  })

  // Main pushes the full state on change — write it straight into the cache
  // instead of refetching.
  useEffect(() => {
    const offState = window.swarm.providers.onStateChanged((v) => qc.setQueryData(PROVIDERS_KEY, v))
    return () => {
      offState()
    }
  }, [qc])

  const state = data ?? EMPTY
  const ready = useMemo(() => {
    const row = providerViewById(state, state.active)
    return row?.hasKey === true
  }, [state])

  return { state, ready, refetch: () => void refetch() }
}
