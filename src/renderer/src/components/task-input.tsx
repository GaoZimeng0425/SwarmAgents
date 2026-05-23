import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

type Props = {
  onSubmit: (goal: string) => void | Promise<void>
  disabled?: boolean
}

export function TaskInput({ onSubmit, disabled }: Props): React.JSX.Element {
  const [value, setValue] = useState('')
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    ref.current?.focus()
  }, [])

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    const goal = value.trim()
    if (!goal) return
    await onSubmit(goal)
    setValue('')
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex shrink-0 items-center gap-2 border-b px-4 py-3"
    >
      <Input
        ref={ref}
        type="text"
        placeholder="Give the swarm a goal — e.g., 整理桌面文件 / Summarize today's slack threads"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        disabled={disabled}
        className="flex-1"
      />
      <Button type="submit" disabled={disabled || value.trim().length === 0}>
        Submit
      </Button>
    </form>
  )
}
