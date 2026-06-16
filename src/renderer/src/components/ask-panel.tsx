import { useState } from 'react'
import { MessageSquare } from 'lucide-react'

import { Button } from '@/components/ui/button'
import type { AskOption, AskPrompt } from '@/stores/ask'

type Props = {
  prompt: AskPrompt | null
  /** Submit the chosen answer text back to the waiting agent. */
  onAnswer: (prompt: AskPrompt, answer: string) => void
  /** Dismiss the panel and route the next composer message as the answer. */
  onChat: (prompt: AskPrompt) => void
}

const optionValue = (o: AskOption): string => o.value ?? o.label

/**
 * Human-in-the-loop choice card shown above the composer when the agent calls
 * `ask_user`. Single mode submits on click; multi mode collects checks then
 * submits; "Chat about this" hands the answer off to the composer.
 */
export function AskPanel({ prompt, onAnswer, onChat }: Props): React.JSX.Element | null {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  if (!prompt) return null

  const toggle = (v: string): void =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(v)) next.delete(v)
      else next.add(v)
      return next
    })

  return (
    <div className="mx-auto mb-2 w-full max-w-3xl rounded-xl border border-border bg-popover/95 px-4 py-3 shadow-sm">
      <p className="mb-3 font-medium text-sm">{prompt.question}</p>

      {prompt.mode === 'single' ? (
        <div className="flex flex-wrap gap-2">
          {prompt.options.map((o) => (
            <Button key={optionValue(o)} onClick={() => onAnswer(prompt, optionValue(o))} size="sm" variant="secondary">
              {o.label}
            </Button>
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            {prompt.options.map((o) => {
              const v = optionValue(o)
              const on = selected.has(v)
              return (
                <Button key={v} onClick={() => toggle(v)} size="sm" variant={on ? 'default' : 'secondary'}>
                  {o.label}
                </Button>
              )
            })}
          </div>
          <div>
            <Button disabled={selected.size === 0} onClick={() => onAnswer(prompt, [...selected].join(', '))} size="sm">
              Submit
            </Button>
          </div>
        </div>
      )}

      <button
        className="mt-3 flex items-center gap-1.5 text-muted-foreground text-xs hover:text-foreground"
        onClick={() => onChat(prompt)}
        type="button"
      >
        <MessageSquare className="size-3.5" />
        Chat about this
      </button>
    </div>
  )
}
