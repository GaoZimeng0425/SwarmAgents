// src/main/web-search/redact.ts
//
// Projects the on-disk config (which holds secret keys) to the renderer-visible
// view. Keys become hasKey booleans and NEVER cross the IPC boundary.
import type { WebSearchConfigOnDisk, WebSearchConfigView } from '@shared/types/web-search'

export function toView(state: WebSearchConfigOnDisk): WebSearchConfigView {
  return {
    provider: state.provider,
    hasTavilyKey: !!state.keys.tavily,
    hasBraveKey: !!state.keys.brave,
    ...(state.searxngUrl ? { searxngUrl: state.searxngUrl } : {}),
  }
}
