import { createContext, type ReactNode, useContext, useMemo, useState } from 'react'

export type ColorMode = 'light' | 'dark'

type ColorModeContextValue = {
  colorMode: ColorMode
  setColorMode: (mode: ColorMode) => void
  toggleColorMode: () => void
}

const ColorModeContext = createContext<ColorModeContextValue | null>(null)

// App-wide color mode, controlled by the header toggle. Kept in context so any
// screen (e.g. the details glass back button) can read the active theme instead
// of falling back to the system appearance.
export function ColorModeProvider({ children }: { children: ReactNode }) {
  const [colorMode, setColorMode] = useState<ColorMode>('dark')

  const value = useMemo<ColorModeContextValue>(
    () => ({
      colorMode,
      setColorMode,
      toggleColorMode: () => setColorMode((mode) => (mode === 'dark' ? 'light' : 'dark')),
    }),
    [colorMode]
  )

  return <ColorModeContext.Provider value={value}>{children}</ColorModeContext.Provider>
}

export function useColorMode(): ColorModeContextValue {
  const ctx = useContext(ColorModeContext)
  if (!ctx) {
    throw new Error('useColorMode must be used within a ColorModeProvider')
  }
  return ctx
}
