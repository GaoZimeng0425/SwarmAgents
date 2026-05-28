import { Monitor, Moon, Sun } from 'lucide-react'
import { useTheme } from 'next-themes'

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

export function ThemeToggle(): React.JSX.Element {
  const { theme, setTheme } = useTheme()
  return (
    <Select onValueChange={(value) => setTheme(value || 'system')} value={theme ?? ''}>
      <SelectTrigger className="w-[160px]">
        <SelectValue placeholder="Theme" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="light">
          <Sun className="mr-2 inline size-4" /> Light
        </SelectItem>
        <SelectItem value="dark">
          <Moon className="mr-2 inline size-4" /> Dark
        </SelectItem>
        <SelectItem value="system">
          <Monitor className="mr-2 inline size-4" /> System
        </SelectItem>
      </SelectContent>
    </Select>
  )
}
