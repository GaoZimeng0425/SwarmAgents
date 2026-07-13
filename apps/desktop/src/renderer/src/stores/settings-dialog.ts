// SECTIONS_REGISTRY is the single source of truth for the settings sidebar:
// keys, labels, group placement, and colored icon chips. Replaces the former
// triple hand-synced lists (this file's SECTIONS array + the dialog's inline
// SECTIONS + the union). The useSettingsDialog zustand store is gone — open/
// section state is now router-derived (see hooks/use-settings-nav.ts).
import {
  Boxes,
  Cable,
  Calendar,
  CircleDollarSign,
  CloudSun,
  Cpu,
  Globe,
  Info,
  Keyboard,
  Lock,
  type LucideIcon,
  Mail,
  Settings,
  Sparkles,
  Video,
} from 'lucide-react'

import { AboutView } from '@/components/views/about-view'
import { BilibiliSettingsView } from '@/components/views/bilibili-settings-view'
import { BudgetsView } from '@/components/views/budgets-view'
import { CalendarSettingsView } from '@/components/views/calendar-view'
import { GeneralView } from '@/components/views/general-view'
import { GmailSettingsView } from '@/components/views/gmail-view'
import { McpServersView } from '@/components/views/mcp-servers-view'
import { PermissionsView } from '@/components/views/permissions-view'
import { ProvidersView } from '@/components/views/providers-view'
import { QuickPanelSettingsView } from '@/components/views/quick-panel-settings-view'
import { RemoteView } from '@/components/views/remote-view'
import { SkillsView } from '@/components/views/skills-view'
import { WeatherView } from '@/components/views/weather-view'
import { WebSearchView } from '@/components/views/web-search-view'

export type SettingsSection =
  | 'general'
  | 'providers'
  | 'budgets'
  | 'mcp'
  | 'web-search'
  | 'skills'
  | 'weather'
  | 'gmail'
  | 'calendar'
  | 'bilibili'
  | 'permissions'
  | 'about'
  | 'remote'
  | 'quick-panel'

export type SectionGroup = '通用' | '模型' | '工具' | '连接' | '系统'

export type SectionMeta = {
  key: SettingsSection
  label: string
  group: SectionGroup
  iconBg: string
  icon: LucideIcon
  // The view component rendered for this section. Attached here (rather than a
  // separate map in the dialog) so the registry is the single source of truth
  // for the whole settings modal: keys, labels, groups, icons AND views.
  View: React.ComponentType
}

export const SECTIONS_REGISTRY: SectionMeta[] = [
  { key: 'general', label: '通用', group: '通用', iconBg: '#8e8e93', icon: Settings, View: GeneralView },
  {
    key: 'quick-panel',
    label: '快捷面板',
    group: '通用',
    iconBg: '#8e8e93',
    icon: Keyboard,
    View: QuickPanelSettingsView,
  },
  { key: 'providers', label: '模型设置', group: '模型', iconBg: '#3478f6', icon: Cpu, View: ProvidersView },
  { key: 'budgets', label: '预算', group: '模型', iconBg: '#ff9f0a', icon: CircleDollarSign, View: BudgetsView },
  { key: 'mcp', label: 'MCP 服务器', group: '工具', iconBg: '#5e5ce6', icon: Boxes, View: McpServersView },
  { key: 'web-search', label: '网页搜索', group: '工具', iconBg: '#34c759', icon: Globe, View: WebSearchView },
  { key: 'skills', label: '技能', group: '工具', iconBg: '#af52de', icon: Sparkles, View: SkillsView },
  { key: 'weather', label: '天气', group: '连接', iconBg: '#30b0c7', icon: CloudSun, View: WeatherView },
  { key: 'gmail', label: 'Gmail', group: '连接', iconBg: '#ea4335', icon: Mail, View: GmailSettingsView },
  { key: 'calendar', label: '日历', group: '连接', iconBg: '#007aff', icon: Calendar, View: CalendarSettingsView },
  { key: 'bilibili', label: 'Bilibili', group: '连接', iconBg: '#fb7299', icon: Video, View: BilibiliSettingsView },
  { key: 'remote', label: '远程连接', group: '连接', iconBg: '#5e5ce6', icon: Cable, View: RemoteView },
  { key: 'permissions', label: '权限', group: '系统', iconBg: '#30b0c7', icon: Lock, View: PermissionsView },
  { key: 'about', label: '关于', group: '系统', iconBg: '#8e8e93', icon: Info, View: AboutView },
]

export const GROUP_ORDER: SectionGroup[] = ['通用', '模型', '工具', '连接', '系统']

export const SECTION_KEYS = SECTIONS_REGISTRY.map((s) => s.key) as unknown as readonly [
  SettingsSection,
  ...SettingsSection[],
]

const SECTION_KEY_SET = new Set<string>(SECTION_KEYS)

export function isValidSection(value: unknown): value is SettingsSection {
  return typeof value === 'string' && SECTION_KEY_SET.has(value)
}

// Map a legacy /settings[/<section>] route (still sent by the menu / deep-link
// IPC) onto a dialog section. Unknown tails fall back to General.
export function routeToSection(route: string): SettingsSection {
  const tail = route.replace(/^\/settings\/?/, '')
  return SECTION_KEY_SET.has(tail) ? (tail as SettingsSection) : 'general'
}
