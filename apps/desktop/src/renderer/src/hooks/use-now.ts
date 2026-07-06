import { useEffect, useState } from 'react'

// A ticking "current time" hook for live-derived UI (elapsed wall time on
// running cards, "X 天后" countdowns on scheduled rows). Re-renders the caller
// every `intervalMs`. The interval is suspended in the SSR/test default (no
// effect runs), so callers can pass a fixed `now` in tests by not mounting.
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}
