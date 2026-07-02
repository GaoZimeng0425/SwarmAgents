import { useState } from 'react'
import { CheckIcon } from 'lucide-react'

import type { ViewerFile } from '@/components/attachment-viewer-sheet'
import { Button } from '@swarm/ui'
import { cn } from '@/lib/utils'
import { DocumentCard } from './document'

export type UiRendererProps = {
  props: unknown
  /** Interactive cards call this to start a new user turn with the chosen value. */
  onSend?: (text: string) => void
  /** Disabled while a run is in flight to avoid double submits. */
  disabled?: boolean
  /** Document cards call this to open the file in the attachment viewer sheet. */
  onOpenFile?: (file: ViewerFile) => void
}

export type UiRenderer = React.FC<UiRendererProps>

type ChoiceOption = { label: string; value?: string }
type ChoiceSpec = { options?: ChoiceOption[]; mode?: 'single' | 'multi' }

const optionValue = (o: ChoiceOption): string => o.value ?? o.label

// Flat, weather-card-like option row: subtle border, transparent fill, accent
// border + tint on hover/selection — matches the surrounding card aesthetic
// instead of the heavy filled Button look.
const optionRow = (selected: boolean): string =>
  cn(
    'flex w-full items-center gap-2.5 rounded-lg border px-3.5 py-2.5 text-left text-sm transition-colors',
    'enabled:hover:border-primary/40 enabled:hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50',
    selected ? 'border-primary bg-primary/10 text-foreground' : 'border-border bg-transparent text-foreground/90'
  )

const ChoiceCard: UiRenderer = ({ props, onSend, disabled }) => {
  const spec = (props ?? {}) as ChoiceSpec
  const options = (spec.options ?? []).filter((o) => typeof o?.label === 'string' && o.label.trim().length > 0)
  const mode = spec.mode === 'multi' ? 'multi' : 'single'
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const toggle = (v: string): void =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(v)) next.delete(v)
      else next.add(v)
      return next
    })

  // Just the options — full width, no card chrome and no question text. The
  // model already states the question in its message; the selector is purely
  // the choosable rows.
  if (mode === 'single') {
    return (
      <div className="flex w-full flex-col gap-2">
        {options.map((o) => (
          <button
            className={optionRow(false)}
            disabled={disabled}
            key={optionValue(o)}
            onClick={() => onSend?.(optionValue(o))}
            type="button"
          >
            <span className="flex-1">{o.label}</span>
          </button>
        ))}
      </div>
    )
  }

  return (
    <div className="flex w-full flex-col gap-2">
      {options.map((o) => {
        const v = optionValue(o)
        const checked = selected.has(v)
        return (
          <button className={optionRow(checked)} disabled={disabled} key={v} onClick={() => toggle(v)} type="button">
            <span
              className={cn(
                'flex size-4 shrink-0 items-center justify-center rounded-[5px] border transition-colors',
                checked ? 'border-primary bg-primary text-primary-foreground' : 'border-border'
              )}
            >
              {checked && <CheckIcon className="size-3" />}
            </span>
            <span className="flex-1">{o.label}</span>
          </button>
        )
      })}
      <Button
        className="mt-1 w-full"
        disabled={disabled || selected.size === 0}
        onClick={() => onSend?.([...selected].join(', '))}
        size="sm"
      >
        Submit
      </Button>
    </div>
  )
}

type WeatherSpec = { city?: string; tempC?: number; summary?: string }

const WeatherCard: UiRenderer = ({ props }) => {
  const spec = (props ?? {}) as WeatherSpec
  return (
    <div className="flex items-center gap-4 rounded-xl border border-border bg-popover/95 px-4 py-3 shadow-sm">
      <div className="font-medium text-sm">{spec.city ?? 'Unknown'}</div>
      {typeof spec.tempC === 'number' && <div className="text-2xl tabular-nums">{spec.tempC}°C</div>}
      {spec.summary && <div className="text-muted-foreground text-sm">{spec.summary}</div>}
    </div>
  )
}

const REGISTRY: Record<string, UiRenderer> = {
  choice: ChoiceCard,
  weather: WeatherCard,
  pdf: DocumentCard,
  docx: DocumentCard,
  xlsx: DocumentCard,
  csv: DocumentCard,
}

export function getUiRenderer(type: string): UiRenderer | undefined {
  return REGISTRY[type]
}

// Models sometimes send object-typed tool params as a JSON string. Coerce a
// string that parses to an object/array into the value; otherwise return as-is.
export function coerceProps(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}
