// Local type definitions vendored from the Vercel AI SDK (`ai` v6) UI types.
// Only the subset consumed by the ai-elements components is reproduced here, so
// the renderer does not depend on the `ai` package at type-check time.

export type ChatStatus = 'submitted' | 'streaming' | 'ready' | 'error'

export type FileUIPart = {
  type: 'file'
  /** IANA media type of the file. */
  mediaType: string
  /** Optional filename of the file. */
  filename?: string
  /** Hosted URL or data URL of the file. */
  url: string
  providerMetadata?: Record<string, unknown>
}

export type SourceDocumentUIPart = {
  type: 'source-document'
  sourceId: string
  mediaType: string
  title: string
  filename?: string
  providerMetadata?: Record<string, unknown>
}

type ToolUIPartState =
  | 'input-streaming'
  | 'input-available'
  | 'approval-requested'
  | 'approval-responded'
  | 'output-available'
  | 'output-error'
  | 'output-denied'

export type ToolUIPart = {
  type: `tool-${string}`
  state: ToolUIPartState
  input?: unknown
  output?: unknown
  errorText?: string
}

export type DynamicToolUIPart = {
  type: 'dynamic-tool'
  toolName: string
  state: ToolUIPartState
  input?: unknown
  output?: unknown
  errorText?: string
}

export type UIMessage = {
  id: string
  role: 'system' | 'user' | 'assistant'
  parts: Array<{ type: string; text?: string }>
}
