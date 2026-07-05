import {
  BarChart3,
  CalendarClock,
  Clock,
  LayoutDashboard,
  Mail,
  MessageSquare,
  Network,
  TrendingUp,
  Video,
} from 'lucide-react'
import { describe, expect, it } from 'vitest'

import { isActive, isConversationScene, RAIL_SECTIONS, type RailItem } from '@/components/rail-config'

describe('RAIL_SECTIONS', () => {
  it('has exactly two sections: scenes then services', () => {
    expect(RAIL_SECTIONS.map((s) => s.id)).toEqual(['scenes', 'services'])
  })

  it('scenes list matches the design in order with the right icons', () => {
    const scenes = RAIL_SECTIONS[0].items as RailItem[]
    expect(scenes.map((i) => i.label)).toEqual(['任务台', '对话', '编队', '日历', '自动化', '用量'])
    expect(scenes.map((i) => i.icon)).toEqual([
      LayoutDashboard,
      MessageSquare,
      Network,
      CalendarClock,
      Clock,
      BarChart3,
    ])
  })

  it('services list matches the design in order with the right icons', () => {
    const services = RAIL_SECTIONS[1].items as RailItem[]
    expect(services.map((i) => i.label)).toEqual(['Gmail', 'GitHub 趋势', 'Bilibili'])
    expect(services.map((i) => i.icon)).toEqual([Mail, TrendingUp, Video])
  })

  it('routes every route item to its expected path with the expected match mode', () => {
    const routes = RAIL_SECTIONS.flatMap((s) => s.items).filter((i) => i.target.kind === 'route')
    expect(
      routes.map((i) => (i.target.kind === 'route' ? { key: i.key, to: i.target.to, match: i.target.match } : null))
    ).toEqual([
      { key: 'home', to: '/', match: 'exact' },
      { key: 'chat', to: '/session/', match: 'prefix' },
      { key: 'calendar', to: '/scheduled', match: 'exact' },
      { key: 'automation', to: '/scheduled', match: 'exact' },
      { key: 'usage', to: '/usage', match: 'exact' },
      { key: 'gmail', to: '/gmail', match: 'exact' },
      { key: 'trending', to: '/trending', match: 'exact' },
      { key: 'bilibili', to: '/bilibili', match: 'exact' },
    ])
  })

  it('marks only the formation item as an action', () => {
    const actions = RAIL_SECTIONS.flatMap((s) => s.items).filter((i) => i.target.kind === 'action')
    expect(actions.map((i) => i.key)).toEqual(['formation'])
  })
})

describe('isConversationScene', () => {
  it('is true on the home route and any session route', () => {
    expect(isConversationScene('/')).toBe(true)
    expect(isConversationScene('/session/abc')).toBe(true)
    expect(isConversationScene('/session/abc/def')).toBe(true)
  })

  it('is false on every other route', () => {
    expect(isConversationScene('/scheduled')).toBe(false)
    expect(isConversationScene('/usage')).toBe(false)
    expect(isConversationScene('/gmail')).toBe(false)
    expect(isConversationScene('/trending')).toBe(false)
    expect(isConversationScene('/bilibili')).toBe(false)
    expect(isConversationScene('/sessions')).toBe(false) // prefix is '/session/'
  })
})

describe('isActive', () => {
  const find = (key: string): RailItem => RAIL_SECTIONS.flatMap((s) => s.items).find((i) => i.key === key) as RailItem

  it('matches exact routes only on their exact path', () => {
    expect(isActive(find('home'), '/')).toBe(true)
    expect(isActive(find('home'), '/session/x')).toBe(false)
  })

  it('matches prefix routes on any path under them', () => {
    expect(isActive(find('chat'), '/session/abc')).toBe(true)
    expect(isActive(find('chat'), '/')).toBe(false)
  })

  it('lights up both calendar and automation on the shared /scheduled route', () => {
    expect(isActive(find('calendar'), '/scheduled')).toBe(true)
    expect(isActive(find('automation'), '/scheduled')).toBe(true)
  })

  it('is never active for action items', () => {
    expect(isActive(find('formation'), '/')).toBe(false)
    expect(isActive(find('formation'), '/scheduled')).toBe(false)
  })
})
