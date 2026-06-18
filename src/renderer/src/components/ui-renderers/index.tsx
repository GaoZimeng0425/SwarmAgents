import { useState } from 'react'

import { Button } from '@/components/ui/button'

export type UiRendererProps = {
  props: unknown
  /** Interactive cards call this to start a new user turn with the chosen value. */
  onSend?: (text: string) => void
  /** Disabled while a run is in flight to avoid double submits. */
  disabled?: boolean
}

export type UiRenderer = React.FC<UiRendererProps>

type ChoiceOption = { label: string; value?: string }
type ChoiceSpec = { question?: string; options?: ChoiceOption[]; mode?: 'single' | 'multi' }

const optionValue = (o: ChoiceOption): string => o.value ?? o.label

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

  return (
    <div className="rounded-xl border border-border bg-popover/95 px-4 py-3 shadow-sm">
      {spec.question && <p className="mb-3 font-medium text-sm">{spec.question}</p>}
      {mode === 'single' ? (
        <div className="flex flex-wrap gap-2">
          {options.map((o) => (
            <Button
              disabled={disabled}
              key={optionValue(o)}
              onClick={() => onSend?.(optionValue(o))}
              size="sm"
              variant="secondary"
            >
              {o.label}
            </Button>
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            {options.map((o) => {
              const v = optionValue(o)
              return (
                <Button
                  disabled={disabled}
                  key={v}
                  onClick={() => toggle(v)}
                  size="sm"
                  variant={selected.has(v) ? 'default' : 'secondary'}
                >
                  {o.label}
                </Button>
              )
            })}
          </div>
          <Button
            disabled={disabled || selected.size === 0}
            onClick={() => onSend?.([...selected].join(', '))}
            size="sm"
          >
            Submit
          </Button>
        </div>
      )}
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
