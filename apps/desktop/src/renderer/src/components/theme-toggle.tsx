import { Monitor, Moon, Sun } from 'lucide-react'
import { useTheme } from 'next-themes'

import { cn } from '@/lib/utils'

const OPTIONS = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
] as const

export function ThemeToggle(): React.JSX.Element {
  const { theme, setTheme } = useTheme()
  const active = theme ?? 'system'

  return (
    <div className="flex items-center gap-0.5 rounded-md bg-sidebar-accent/40 p-0.5">
      {OPTIONS.map(({ value, label, icon: Icon }) => (
        <button
          aria-label={label}
          aria-pressed={active === value}
          className={cn(
            'flex flex-1 items-center justify-center rounded-[5px] px-2.5 py-1 text-muted-foreground transition-colors hover:text-foreground',
            active === value && 'bg-background text-foreground shadow-sm'
          )}
          key={value}
          onClick={() => setTheme(value)}
          title={label}
          type="button"
        >
          <Icon className="size-3.5" />
        </button>
      ))}
    </div>
  )
}
