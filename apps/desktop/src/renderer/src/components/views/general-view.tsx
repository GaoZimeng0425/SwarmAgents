import { ThemeToggle } from '@/components/theme-toggle'
import { Section, SettingsHeader } from './settings-primitives'

export function GeneralView(): React.JSX.Element {
  return (
    <div className="space-y-5">
      <SettingsHeader description="外观与启动偏好。" title="通用" />
      <Section label="外观">
        <div className="flex items-center justify-between py-1">
          <div className="flex flex-col">
            <span className="font-medium text-sm">主题</span>
            <span className="text-muted-foreground text-xs">跟随系统、浅色或深色。</span>
          </div>
          <ThemeToggle />
        </div>
      </Section>
    </div>
  )
}
