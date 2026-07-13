import { useEffect, useRef } from 'react'
import { Search } from 'lucide-react'

import type { SlashCommand } from './use-quick-panel-state'

type Props = {
  query: string
  onQueryChange: (q: string) => void
  onKeyDown: (e: React.KeyboardEvent) => void
  showSlashList: boolean
  slashItems: SlashCommand[]
  selIndex: number
}

export function QuickPanelInput(props: Props): React.JSX.Element {
  // Focus the input on mount so typing flows straight in. The panel window
  // mounts fresh each time it's shown, so a mount effect is enough; we avoid
  // the `autoFocus` attr (biome a11y/noAutofocus) — same pattern as palette-input.
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  return (
    <div className="relative flex items-center gap-2 border-border/60 border-b px-4 py-3">
      <Search className="size-4 shrink-0 text-muted-foreground" />
      <input
        className="flex-1 bg-transparent text-foreground text-sm outline-none placeholder:text-muted-foreground"
        onChange={(e) => props.onQueryChange(e.target.value)}
        onKeyDown={props.onKeyDown}
        placeholder="搜索、输入命令,或 / 进入对话…"
        ref={inputRef}
        value={props.query}
      />
      {/* Slash command popover */}
      {props.showSlashList && (
        <div className="absolute top-full left-0 z-50 w-full border-border/60 border-b bg-popover/95 backdrop-blur-md">
          {props.slashItems.map((cmd, i) => (
            <div
              className={`flex items-center gap-2 px-4 py-2 text-sm ${i === props.selIndex ? 'bg-accent text-accent-foreground' : 'text-muted-foreground'}`}
              key={cmd.id}
            >
              <span className="font-mono text-primary">{cmd.label}</span>
              <span className="text-muted-foreground text-xs">{cmd.desc}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
