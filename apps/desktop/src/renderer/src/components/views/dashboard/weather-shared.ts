// Pure, JSX-free helpers shared by the weather strip, drawer, and detail body:
// icon-code → emoji, AQI/severity band colors, relative-time formatting, and the
// theme-aware recharts tooltip style. No React, no store access.

// Severity color per QWeather `severityColor` (semantic, theme-independent).
export const SEVERITY_HEX: Record<string, string> = {
  Yellow: '#c99700',
  Blue: '#2f6bd8',
  Orange: '#e2650f',
  Red: '#d92d20',
  White: '#6b7280',
}

export const severityHex = (c: string): string => SEVERITY_HEX[c] ?? '#6b7280'

// Theme-aware recharts tooltip (the default renders white-on-white in dark mode).
export const TOOLTIP_STYLE = {
  contentStyle: {
    background: 'var(--popover)',
    border: '1px solid var(--border)',
    borderRadius: '8px',
    fontSize: '12px',
    padding: '6px 10px',
    boxShadow: '0 4px 12px rgb(0 0 0 / 0.18)',
  },
  labelStyle: { color: 'var(--popover-foreground)', fontWeight: 600, marginBottom: '2px' },
  itemStyle: { color: 'var(--popover-foreground)' },
  cursor: { stroke: 'var(--border)', strokeWidth: 1 },
} as const

// Map a QWeather icon code (e.g. "302") to an emoji. Codes are grouped by range
// per the QWeather icon set: 1xx clear/cloud, 3xx rain, 4xx snow, 5xx fog/haze.
export function weatherEmoji(code: string): string {
  const n = Number(code)
  if (!Number.isFinite(n)) return '🌡️'
  if (n === 100) return '☀️'
  if (n === 150) return '🌙' // 晴 (night)
  if (n >= 101 && n <= 103) return '⛅' // 多云/少云/晴间多云
  if (n >= 151 && n <= 153) return '⛅'
  if (n === 104 || n === 154) return '☁️' // 阴
  if (n >= 300 && n <= 303) return n >= 302 ? '⛈️' : '🌦️' // 阵雨/雷阵雨
  if (n === 304) return '⛈️' // 雷阵雨伴冰雹
  if (n >= 305 && n <= 399) return '🌧️' // 各类雨
  if (n >= 400 && n <= 499) return '🌨️' // 雪
  if (n >= 500 && n <= 515) return '🌫️' // 雾/霾/沙尘
  if (n === 900) return '🥵'
  if (n === 901) return '🥶'
  return '🌡️'
}

// CN AQI category → representative band color.
export function aqiHex(category: string): string {
  if (category === '优') return '#4a9e46'
  if (category === '良') return '#b78a00'
  if (category.includes('轻度')) return '#e2650f'
  if (category.includes('中度')) return '#d92d20'
  if (category.includes('重度') || category.includes('严重')) return '#8b1a1a'
  return '#6b7280'
}

export function relativeTime(epochMs: number): string {
  const sec = Math.floor((Date.now() - epochMs) / 1000)
  if (sec < 60) return '刚刚更新'
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟前`
  return `${Math.floor(sec / 3600)} 小时前`
}
