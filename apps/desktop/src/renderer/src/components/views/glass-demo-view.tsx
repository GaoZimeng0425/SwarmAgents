// Static Liquid Glass demo page. Showcases the CSS-simulated glass recipe
// (see globals.css --glass-* tokens and @utility classes) across common UI
// surfaces. No business logic, no data fetching — pure visual reference.

import { Plus, Settings, Sparkles } from 'lucide-react'

export function GlassDemoView(): React.JSX.Element {
  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-[1088px] flex-col gap-8 px-6 py-8">
          {/* Title */}
          <header className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <Sparkles className="size-7 text-primary" />
              <h1 className="font-semibold text-[28px] text-foreground tracking-tight">Liquid Glass 主题预览</h1>
            </div>
            <p className="text-muted-foreground text-sm">
              纯 CSS 模拟的液态玻璃质感，叠加在窗口原生毛玻璃之上。以下控件均为静态展示。
            </p>
          </header>

          {/* §A Buttons */}
          <Section subtitle="glass-button / glass-button-accent，含 hover / active / disabled 状态" title="按钮">
            <div className="flex flex-wrap items-center gap-3">
              <button className="glass-button rounded-full px-4 py-2 font-medium text-foreground text-sm" type="button">
                玻璃按钮
              </button>
              <button className="glass-button-accent rounded-full px-4 py-2 font-medium text-sm" type="button">
                强调按钮
              </button>
              <button
                className="glass-button rounded-full px-4 py-2 font-medium text-foreground text-sm opacity-40"
                disabled
                type="button"
              >
                禁用按钮
              </button>
              <button
                aria-label="add"
                className="glass-button flex size-9 items-center justify-center rounded-full text-foreground"
                type="button"
              >
                <Plus className="size-4" />
              </button>
              <button
                aria-label="settings"
                className="glass-button-accent flex size-9 items-center justify-center rounded-full"
                type="button"
              >
                <Settings className="size-4" />
              </button>
            </div>
          </Section>
        </div>
      </div>
    </div>
  )
}

// Small section wrapper used by every demo section. Keeps heading + content
// spacing consistent across the page, mirroring home-dashboard.tsx sections.
function Section({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h2 className="font-semibold text-foreground text-lg tracking-tight">{title}</h2>
        {subtitle ? <p className="text-muted-foreground text-xs">{subtitle}</p> : null}
      </div>
      {children}
    </section>
  )
}
