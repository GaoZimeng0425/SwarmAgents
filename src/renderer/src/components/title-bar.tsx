// src/renderer/src/components/title-bar.tsx
//
// Full-width window drag region on macOS. On Windows/Linux this is invisible
// (the OS still supplies its own title bar because we don't set
// `titleBarStyle: 'hiddenInset'` there). 06-native-conventions § Windowing:
// drag must work on the full title bar, not a centered handle.
export function TitleBar(): React.JSX.Element {
  return (
    <div
      aria-hidden="true"
      className="fixed inset-x-0 top-0 z-50 h-7"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    />
  )
}
