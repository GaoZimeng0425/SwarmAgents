// Static Liquid Glass demo page. Showcases the CSS-simulated glass recipe
// (see globals.css --glass-* tokens and @utility classes) across common UI
// surfaces. No business logic, no data fetching — pure visual reference.

import { Bell, Plus, Search, Settings, Sparkles, Star } from 'lucide-react'

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

          {/* §B Panels & cards */}
          <Section subtitle="glass-panel，单面板 + 卡片墙（1/2/3 列响应式）" title="面板与卡片">
            {/* Single panel */}
            <div className="glass-panel rounded-2xl p-5">
              <h3 className="font-medium text-base text-foreground">单层面板</h3>
              <p className="mt-1.5 text-muted-foreground text-sm leading-relaxed">
                这是一个独立的玻璃面板，半透明背景叠加 backdrop-filter 模糊，inset
                高光边模拟玻璃边缘反光，双层投影营造悬浮感。
              </p>
            </div>
            {/* Card wall */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {[
                { icon: Star, title: '卡片一', body: '网格布局卡片，响应式 1/2/3 列。' },
                { icon: Bell, title: '卡片二', body: '每张卡片独立应用 glass-panel 配方。' },
                { icon: Settings, title: '卡片三', body: '卡片内容为静态占位文案。' },
              ].map((card) => (
                <div className="glass-panel rounded-2xl p-4" key={card.title}>
                  <card.icon className="size-5 text-primary" />
                  <h4 className="mt-2 font-medium text-foreground text-sm">{card.title}</h4>
                  <p className="mt-1 text-muted-foreground text-xs leading-relaxed">{card.body}</p>
                </div>
              ))}
            </div>
          </Section>

          {/* §C Toolbar (sticky) */}
          <Section subtitle="glass-panel-strong，吸顶时保持模糊" title="工具栏">
            <div className="glass-panel-strong sticky top-0 z-10 flex items-center gap-2 rounded-2xl p-2">
              <div className="flex flex-1 items-center gap-2 px-3">
                <Search className="size-4 text-muted-foreground" />
                <input
                  className="flex-1 bg-transparent text-foreground text-sm outline-none placeholder:text-muted-foreground"
                  placeholder="搜索…"
                  type="text"
                />
              </div>
              <button className="glass-button rounded-full px-3 py-1.5 text-foreground text-xs" type="button">
                筛选
              </button>
              <button className="glass-button-accent rounded-full px-3 py-1.5 text-xs" type="button">
                新建
              </button>
            </div>
            {/* Spacer so the sticky effect is visible when scrolling */}
            <div className="glass-panel flex h-24 items-center justify-center rounded-2xl text-muted-foreground text-xs">
              向上滚动以查看工具栏的吸顶模糊效果
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
