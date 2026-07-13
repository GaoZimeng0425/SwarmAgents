// Renders the palette results list for the quick panel. Reuses the PaletteItem
// and PaletteSection types from the existing palette, but with a simpler
// single-column layout (no preview aside — the panel is too narrow).
import { ChevronRight } from 'lucide-react'

import type { PaletteItem, PaletteSection } from '@/lib/palette/types'

type Props = {
  flat: PaletteItem[]
  sections: PaletteSection[]
  selIndex: number
  onSetSelIndex: (i: number) => void
}

export function QuickPanelResults(props: Props): React.JSX.Element | null {
  if (props.flat.length === 0) return null

  return (
    <div className="cmdscroll min-h-0 flex-1 overflow-y-auto py-1">
      {props.sections.map((section) => {
        if (section.items.length === 0) return null
        return (
          <div key={section.heading}>
            <div className="px-4 pt-2 pb-1 text-muted-foreground text-xs">{section.heading}</div>
            {section.items.map((item) => {
              const globalIndex = props.flat.indexOf(item)
              const isSelected = globalIndex === props.selIndex
              return (
                <button
                  className={`flex w-full items-center gap-2.5 px-4 py-1.5 text-left text-sm ${isSelected ? 'bg-accent text-accent-foreground' : 'text-foreground hover:bg-accent/50'}`}
                  key={item.id}
                  onClick={() => {
                    props.onSetSelIndex(globalIndex)
                    item.run()
                  }}
                  onMouseEnter={() => props.onSetSelIndex(globalIndex)}
                  type="button"
                >
                  <ChevronRight className="size-3.5 shrink-0 opacity-50" />
                  <span className="min-w-0 flex-1 truncate">{item.title}</span>
                  {item.subtitle && <span className="shrink-0 text-muted-foreground text-xs">{item.subtitle}</span>}
                </button>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}
