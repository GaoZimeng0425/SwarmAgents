// apps/desktop/src/renderer/src/components/palette/palette-input.tsx
// Top row of the palette: scope icon + pill + the free-text input + result
// count. Scope is derived from the raw query in usePaletteState; this just
// renders from SCOPE_META. Clearing the query (× or lone Backspace) resets
// scope back to mixed because the prefix char lives in the query itself.
import { useEffect, useRef } from 'react'
import { cn } from '@swarm/ui'

import { type PaletteScope, SCOPE_META } from '../../lib/palette/scope'
import { resolveIcon } from './palette-item'

export type PaletteInputProps = {
  scope: PaletteScope
  query: string
  onQueryChange: (next: string) => void
  flatCount: number
}

export function PaletteInput({ scope, query, onQueryChange, flatCount }: PaletteInputProps): React.JSX.Element {
  const meta = SCOPE_META[scope]
  const Icon = resolveIcon(meta.icon)
  const showPill = scope !== 'mixed' && meta.pill !== null
  // The prefix char that the user typed to enter this scope; hidden for mixed.
  const prefix = scope === 'mixed' ? '' : query.trimStart().slice(0, 1)

  // Focus the input on mount so typing flows straight in. The palette lives in
  // a dialog that mounts fresh on each open, so a mount effect is enough; we
  // avoid the `autoFocus` attr (biome a11y/noAutofocus) intentionally.
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  return (
    <div className="flex items-center gap-2.5 border-border/60 border-b px-3.5 py-3">
      <Icon aria-hidden className={cn('size-[18px] shrink-0', meta.color)} />
      {showPill ? (
        <span
          className={cn(
            'flex shrink-0 items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 font-medium text-[11px]',
            meta.color
          )}
        >
          <span className="text-muted-foreground/70">{prefix}</span>
          {meta.pill}
        </span>
      ) : null}
      <input
        className="h-9 min-w-0 flex-1 bg-transparent text-[20px] text-foreground outline-none placeholder:text-muted-foreground/70"
        onChange={(e) => onQueryChange(e.target.value)}
        placeholder={meta.placeholder}
        ref={inputRef}
        spellCheck={false}
        value={query}
      />
      {showPill ? (
        <button
          className="shrink-0 rounded-md px-1 py-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          onClick={() => onQueryChange('')}
          title="清除"
          type="button"
        >
          <span aria-hidden>×</span>
        </button>
      ) : null}
      <span className="shrink-0 text-muted-foreground text-xs">{flatCount} 结果</span>
    </div>
  )
}
