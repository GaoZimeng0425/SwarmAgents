// Pure rail configuration and navigation predicates. No React rendering, no
// router imports — keeps the rail's source of truth testable without a router
// context (a pure-logic test pattern used elsewhere in this codebase).

import type { ComponentType } from 'react'
import {
  CalendarClock,
  LayoutDashboard,
  Mail,
  MessageSquare,
  Network,
  Newspaper,
  Rocket,
  Sparkles,
  TrendingUp,
  Video,
} from 'lucide-react'

export type RailTarget =
  // Navigates to a router path. `match` controls active-state matching:
  //   - 'exact': active only when pathname === to (e.g. '/' for 任务台)
  //   - 'prefix': active when pathname starts with to (e.g. '/session/' for 对话)
  | { kind: 'route'; to: string; match: 'exact' | 'prefix' }
  // Fires an in-component handler instead of navigating (e.g. 编队 → settings modal).
  // Never shows an active state.
  | { kind: 'action' }

export type RailItem = {
  key: string
  label: string
  icon: ComponentType<{ className?: string }>
  target: RailTarget
}

export type RailSection = {
  id: 'scenes' | 'services'
  items: RailItem[]
}

// Single source of truth for the 64px rail. The footer 设置 item is NOT here:
// it is an action with no route, rendered directly in app-rail.tsx. The theme
// toggle lives in Settings → 通用 (general-view.tsx), not in the rail.
export const RAIL_SECTIONS: RailSection[] = [
  {
    id: 'scenes',
    items: [
      { key: 'home', label: '任务台', icon: LayoutDashboard, target: { kind: 'route', to: '/', match: 'exact' } },
      { key: 'chat', label: '对话', icon: MessageSquare, target: { kind: 'route', to: '/session', match: 'prefix' } },
      { key: 'formation', label: '编队', icon: Network, target: { kind: 'route', to: '/formations', match: 'exact' } },
      {
        key: 'calendar',
        label: '日历',
        icon: CalendarClock,
        target: { kind: 'route', to: '/scheduled', match: 'exact' },
      },
    ],
  },
  {
    id: 'services',
    items: [
      { key: 'gmail', label: 'Gmail', icon: Mail, target: { kind: 'route', to: '/gmail', match: 'exact' } },
      {
        key: 'trending',
        label: 'GitHub 趋势',
        icon: TrendingUp,
        target: { kind: 'route', to: '/trending', match: 'exact' },
      },
      { key: 'bilibili', label: 'Bilibili', icon: Video, target: { kind: 'route', to: '/bilibili', match: 'exact' } },
      { key: 'article', label: '文章', icon: Newspaper, target: { kind: 'route', to: '/articles', match: 'exact' } },
      {
        key: 'workbench',
        label: '工作面板',
        icon: Rocket,
        target: { kind: 'route', to: '/workbench', match: 'exact' },
      },
      { key: 'glass', label: '玻璃主题', icon: Sparkles, target: { kind: 'route', to: '/glass', match: 'exact' } },
    ],
  },
]

// A scene where the conversation surface (and thus the session list) is the
// focus: the /session index and any /session/<id> detail. The home route '/' is
// the dashboard (full width, no list), so it is NOT a conversation scene.
// SessionPanel renders iff true.
export function isConversationScene(pathname: string): boolean {
  return pathname.startsWith('/session')
}

export function isActive(item: RailItem, pathname: string): boolean {
  if (item.target.kind !== 'route') return false
  return item.target.match === 'exact' ? pathname === item.target.to : pathname.startsWith(item.target.to)
}
