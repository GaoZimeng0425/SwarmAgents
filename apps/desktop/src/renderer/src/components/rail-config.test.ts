import {
  CalendarClock,
  LayoutDashboard,
  Mail,
  MessageSquare,
  Network,
  Newspaper,
  TrendingUp,
  Video,
} from 'lucide-react'
import { describe, expect, it } from 'vitest'

import { isActive, isConversationScene, RAIL_SECTIONS, type RailItem } from '@/components/rail-config'

describe('RAIL_SECTIONS', () => {
  it('has exactly two sections: scenes then services', () => {
    expect(RAIL_SECTIONS.map((s) => s.id)).toEqual(['scenes', 'services'])
  })

  it('scenes list matches the design in order with the right icons (4 items; 自动化 merged into 日历, 用量 moved to footer)', () => {
    const scenes = RAIL_SECTIONS[0].items
    expect(scenes.map((i) => i.label)).toEqual(['任务台', '对话', '编队', '日历'])
    expect(scenes.map((i) => i.icon)).toEqual([LayoutDashboard, MessageSquare, Network, CalendarClock])
  })

  it('services list matches the design in order with the right icons', () => {
    const services = RAIL_SECTIONS[1].items
    expect(services.map((i) => i.label)).toEqual(['Gmail', 'GitHub 趋势', 'Bilibili', '文章'])
    expect(services.map((i) => i.icon)).toEqual([Mail, TrendingUp, Video, Newspaper])
  })

  it('routes every route item to its expected path with the expected match mode (formations included, no automation/usage)', () => {
    const routes = RAIL_SECTIONS.flatMap((s) => s.items).filter((i) => i.target.kind === 'route')
    expect(
      routes.map((i) => (i.target.kind === 'route' ? { key: i.key, to: i.target.to, match: i.target.match } : null))
    ).toEqual([
      { key: 'home', to: '/', match: 'exact' },
      { key: 'chat', to: '/session', match: 'prefix' },
      { key: 'formation', to: '/formations', match: 'exact' },
      { key: 'calendar', to: '/scheduled', match: 'exact' },
      { key: 'gmail', to: '/gmail', match: 'exact' },
      { key: 'trending', to: '/trending', match: 'exact' },
      { key: 'bilibili', to: '/bilibili', match: 'exact' },
      { key: 'article', to: '/articles', match: 'exact' },
    ])
  })

  it('has no action items (编队 is now a route)', () => {
    const actions = RAIL_SECTIONS.flatMap((s) => s.items).filter((i) => i.target.kind === 'action')
    expect(actions.map((i) => i.key)).toEqual([])
  })
})

describe('isConversationScene', () => {
  it('is true only on session routes (NOT the home route, which is the dashboard)', () => {
    expect(isConversationScene('/')).toBe(false)
    expect(isConversationScene('/session')).toBe(true)
    expect(isConversationScene('/session/abc')).toBe(true)
    expect(isConversationScene('/session/abc/def')).toBe(true)
  })

  it('is false on every other route', () => {
    expect(isConversationScene('/scheduled')).toBe(false)
    expect(isConversationScene('/formations')).toBe(false)
    expect(isConversationScene('/gmail')).toBe(false)
    expect(isConversationScene('/trending')).toBe(false)
    expect(isConversationScene('/bilibili')).toBe(false)
    expect(isConversationScene('/usage')).toBe(false)
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

  it('lights up the formation item on /formations', () => {
    expect(isActive(find('formation'), '/formations')).toBe(true)
    expect(isActive(find('formation'), '/')).toBe(false)
  })
})
