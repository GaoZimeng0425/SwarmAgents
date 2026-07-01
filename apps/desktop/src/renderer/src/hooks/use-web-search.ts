// src/renderer/src/hooks/use-web-search.ts
//
// Subscribes to the web-search config view from main. The view is redacted —
// keys are exposed only as hasKey booleans.
import { useEffect, useState } from 'react'
import type { WebSearchConfigView } from '@shared/types/web-search'

const EMPTY: WebSearchConfigView = {
  provider: 'auto',
  hasTavilyKey: false,
  hasBraveKey: false,
}

export function useWebSearch(): WebSearchConfigView {
  const [state, setState] = useState<WebSearchConfigView>(EMPTY)

  useEffect(() => {
    let cancelled = false
    void window.swarm.webSearch.get().then((v) => {
      if (!cancelled) setState(v)
    })
    const off = window.swarm.webSearch.onStateChanged((v) => setState(v))
    return () => {
      cancelled = true
      off()
    }
  }, [])

  return state
}
