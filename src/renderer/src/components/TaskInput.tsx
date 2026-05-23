import { useEffect, useRef, useState } from 'react'

type Props = {
  onSubmit: (goal: string) => void | Promise<void>
  disabled?: boolean
}

export default function TaskInput({ onSubmit, disabled }: Props): React.JSX.Element {
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
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
      className="flex shrink-0 items-center gap-2 border-b border-white/5 px-4 py-3"
    >
      <input
        ref={inputRef}
        type="text"
        placeholder="Give the swarm a goal — e.g., 整理桌面文件 / Summarize today's slack threads"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        disabled={disabled}
        className="selectable mono flex-1 rounded-md bg-white/5 px-3 py-2 text-sm placeholder:text-white/30 focus:bg-white/10 focus:outline-none"
      />
      <button
        type="submit"
        disabled={disabled || value.trim().length === 0}
        className="rounded-md bg-sky-500/80 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-30"
      >
        Submit
      </button>
    </form>
  )
}
