// Inline mention autocomplete for the composer textarea. Listens for `/` (skill)
// and `@` (file path) typed at a word boundary, and renders a popover above the
// input with candidates. Both triggers commit plain text — the agent reads them
// lazily. Anchored to the composer box (not the caret) via a ref, opened above it.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Popover, PopoverContent } from '@swarm/ui'
import { ChevronRight, FileText, Folder, Sparkles } from 'lucide-react'

import { useSkills } from '@/hooks/use-skills'
import { callableSkills, extractMention, type Mention, matchSkills } from '@/lib/mention'
import { cn } from '@/lib/utils'

type DirEntry = { name: string; isDir: boolean }

export function ComposerMention({
  anchor,
  cwd,
}: {
  anchor: React.RefObject<HTMLElement | null>
  cwd?: string
}): React.JSX.Element | null {
  const { skills } = useSkills()
  const [mention, setMention] = useState<Mention | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  // Skill candidates (derived); file candidates (fetched via IPC, debounced).
  const [files, setFiles] = useState<DirEntry[]>([])
  // The textarea element, queried from the DOM (same pattern as insertPathReference).
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  // Debounce timer handle for listDir.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Skill candidates for the current mention.
  const skillItems = useMemo(() => {
    if (!mention || mention.trigger !== '/') return []
    return matchSkills(callableSkills(skills), mention.query)
  }, [mention, skills])

  const open = mention !== null
  const maxIndex = mention?.trigger === '/' ? skillItems.length - 1 : files.length - 1

  // --- DOM listener: find the textarea and attach input/keydown handlers ---
  // The textarea lives inside PromptInput (prompt-input.tsx), which we don't
  // control. It may mount after our first render (PromptInput children commit
  // before our effect runs, so the textarea is usually present — but poll
  // briefly to be safe against lazy/async rendering).
  useEffect(() => {
    const find = (): HTMLTextAreaElement | null =>
      anchor.current?.querySelector('textarea[name="message"]') as HTMLTextAreaElement | null

    const recheck = (): void => {
      const ta = find()
      if (!ta) return
      textareaRef.current = ta
      const m = extractMention(ta.value, ta.selectionStart ?? ta.value.length)
      setMention(m)
      setActiveIndex(0)
    }

    const attachTo = (ta: HTMLTextAreaElement): void => {
      ta.addEventListener('input', recheck)
      ta.addEventListener('keyup', recheck)
      ta.addEventListener('click', recheck)
    }
    const detachFrom = (ta: HTMLTextAreaElement): void => {
      ta.removeEventListener('input', recheck)
      ta.removeEventListener('keyup', recheck)
      ta.removeEventListener('click', recheck)
    }

    let cleanup = (): void => {}
    const ta = find()
    if (ta) {
      textareaRef.current = ta
      attachTo(ta)
      cleanup = () => detachFrom(ta)
    } else {
      // Retry on the next tick — covers async PromptInput mount.
      const timer = setTimeout(() => {
        const found = find()
        if (found) {
          textareaRef.current = found
          attachTo(found)
          cleanup = () => detachFrom(found)
        }
      }, 0)
      cleanup = () => {
        clearTimeout(timer)
      }
    }
    return cleanup
  }, [anchor])

  // --- Fetch file candidates when the @ query changes (debounced) ---
  useEffect(() => {
    if (!mention || mention.trigger !== '@' || !cwd) {
      setFiles([])
      return
    }
    // Split query into a directory part + a leaf prefix.
    const lastSlash = mention.query.lastIndexOf('/')
    const dirPart = lastSlash >= 0 ? mention.query.slice(0, lastSlash) : ''
    const leaf = lastSlash >= 0 ? mention.query.slice(lastSlash + 1) : mention.query
    const targetDir = dirPart ? `${cwd}/${dirPart}` : cwd

    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      void window.swarm.listDir(targetDir, leaf).then(setFiles)
    }, 80)

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [mention, cwd])

  // --- Commit: replace the mention range with the chosen text ---
  const commit = (replacement: string, keepOpen: boolean): void => {
    const ta = textareaRef.current
    if (!ta || !mention) return
    const before = ta.value.slice(0, mention.start)
    const after = ta.value.slice(mention.end)
    const next = `${before}${replacement}${after}`
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(ta, next)
    const caret = before.length + replacement.length
    ta.setSelectionRange(caret, caret)
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    ta.focus()
    if (keepOpen) {
      // Re-extract at the new caret to keep the popover open for drill-down.
      setMention(extractMention(next, caret))
      setActiveIndex(0)
    } else {
      setMention(null)
    }
  }

  // --- Keyboard handling on the textarea ---
  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    const onKey = (e: KeyboardEvent): void => {
      if (!mention) return
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIndex((i) => (maxIndex <= 0 ? 0 : (i + 1) % (maxIndex + 1)))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIndex((i) => (maxIndex <= 0 ? 0 : (i - 1 + maxIndex + 1) % (maxIndex + 1)))
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        if (maxIndex < 0) return
        e.preventDefault()
        selectActive()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        setMention(null)
      }
    }
    ta.addEventListener('keydown', onKey)
    return () => ta.removeEventListener('keydown', onKey)
  })

  const selectActive = (): void => {
    if (!mention) return
    if (mention.trigger === '/') {
      const skill = skillItems[activeIndex]
      if (skill) commit(`/${skill.name} `, false)
    } else {
      const file = files[activeIndex]
      if (!file) return
      // Reconstruct the path prefix already typed (minus the leaf being replaced).
      const query = mention.query
      const lastSlash = query.lastIndexOf('/')
      const dirPart = lastSlash >= 0 ? query.slice(0, lastSlash + 1) : ''
      const rel = `${dirPart}${file.name}`
      if (file.isDir) {
        commit(`@${rel}/`, true) // keep open for drill-down
      } else {
        commit(`@${rel} `, false)
      }
    }
  }

  const candidates: React.ReactNode[] =
    mention?.trigger === '/'
      ? skillItems.map((s, i) => (
          <button
            className={cn(
              'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted',
              i === activeIndex && 'bg-muted'
            )}
            key={s.name}
            onClick={() => {
              setActiveIndex(i)
              commit(`/${s.name} `, false)
            }}
            type="button"
          >
            <Sparkles className="size-4 shrink-0 text-indigo-500" />
            <span className="flex flex-col">
              <span className="font-mono">{s.name}</span>
              <span className="text-muted-foreground text-xs">{s.description}</span>
            </span>
          </button>
        ))
      : files.map((f, i) => (
          <button
            className={cn(
              'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted',
              i === activeIndex && 'bg-muted'
            )}
            key={f.name}
            onClick={() => {
              setActiveIndex(i)
              selectActive()
            }}
            type="button"
          >
            {f.isDir ? (
              <Folder className="size-4 shrink-0 text-emerald-500" />
            ) : (
              <FileText className="size-4 shrink-0 text-muted-foreground" />
            )}
            <span className="truncate">{f.name}</span>
            {f.isDir && <ChevronRight className="ml-auto size-3 text-muted-foreground" />}
          </button>
        ))

  if (!open || candidates.length === 0) return null

  return (
    <Popover
      onOpenChange={(o) => {
        if (!o) setMention(null)
      }}
      open={open}
    >
      {/* Invisible trigger: Base UI Popover needs a trigger in the tree, but we
          position against the composer anchor ref, not this element. */}
      <PopoverContent
        align="start"
        anchor={anchor}
        className="max-h-64 w-72 overflow-y-auto p-0"
        finalFocus={false}
        side="top"
        sideOffset={8}
      >
        {candidates}
      </PopoverContent>
    </Popover>
  )
}
