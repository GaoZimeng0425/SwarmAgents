import { BarChart3, CalendarClock, Mail, TrendingUp, Video } from 'lucide-react'
import { describe, expect, it } from 'vitest'

import { SERVICES } from '@/components/service-grid'

describe('ServiceGrid SERVICES', () => {
  it('lists the five services with their routes and labels', () => {
    expect(SERVICES.map((s) => ({ to: s.to, label: s.label }))).toEqual([
      { to: '/scheduled', label: '日历' },
      { to: '/usage', label: '用量统计' },
      { to: '/trending', label: 'GitHub 趋势' },
      { to: '/bilibili', label: 'Bilibili 收藏' },
      { to: '/gmail', label: 'Gmail' },
    ])
  })

  it('keeps exactly the five known lucide icons in order', () => {
    // lucide icons are forwardRef objects, not functions — assert identity.
    expect(SERVICES.map((s) => s.icon)).toEqual([CalendarClock, BarChart3, TrendingUp, Video, Mail])
  })
})
