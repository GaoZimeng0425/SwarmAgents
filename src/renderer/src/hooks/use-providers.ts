// src/renderer/src/hooks/use-providers.ts
//
// Subscribes to providers state from main and derives the `ready` flag used
// by the main-window banner (Task 19) and any future task-creation surface.
import { useEffect, useMemo, useState } from 'react'
import { findProviderRowView, type ProvidersStateView } from '@shared/types/provider'

const EMPTY: ProvidersStateView = {
  active: null,
  builtins: { anthropic: null, openai: null },
  custom: [],
}

export type UseProviders = {
  state: ProvidersStateView
  ready: boolean
  decryptFailed: boolean
}

export function useProviders(): UseProviders {
  const [state, setState] = useState<ProvidersStateView>(EMPTY)
  const [decryptFailed, setDecryptFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    void window.swarm.providers.get().then((v) => {
      if (!cancelled) setState(v)
    })
    const offState = window.swarm.providers.onStateChanged((v) => setState(v))
    const offDecrypt = window.swarm.providers.onDecryptFailed(() => setDecryptFailed(true))
    return () => {
      cancelled = true
      offState()
      offDecrypt()
    }
  }, [])

  const ready = useMemo(() => {
    const row = findProviderRowView(state, state.active)
    return row?.hasKey === true
  }, [state])

  return { state, ready, decryptFailed }
}
