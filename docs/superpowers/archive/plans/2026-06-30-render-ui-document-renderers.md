# render_ui Document Renderers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an agent call `render_ui({ type: 'pdf' | 'docx' | 'xlsx' | 'csv', props: { path } })` and get an inline file card in the transcript (PDF first-page thumbnail; icon for the rest) that opens the existing `AttachmentViewerSheet` on click.

**Architecture:** Reuse the composer's viewers (`PDFViewer` / `DocxViewerPreview` / `XlsxViewerPreview` / `CsvViewer`) via the existing `AttachmentViewerSheet`. Add document cards to the `render_ui` registry in `ui-renderers/`. Add a sibling `readDocumentFile` IPC next to `readImageFile` (image-only today) so the sandboxed renderer can pull document bytes by path. One `AttachmentViewerSheet` lives at the `TaskTimeline` root, opened through an `onOpenFile` callback threaded into `createSegmentRenderer`.

**Tech Stack:** Electron (ipcMain + contextBridge), React 19, TypeScript, vitest + @testing-library/react (jsdom), @embedpdf (PDF thumbnail via `renderPdfThumbnailUrl`), Tailwind.

## Global Constraints

- **Conversation language: Chinese. Code comments and commit messages: English only.** (CLAUDE.md §0)
- **Run tests via the Electron-node vitest runner:** `npm test` (never bare `npx vitest`). Never run `pnpm rebuild better-sqlite3` (breaks the app's better-sqlite3 ABI). (Memory: run-tests-via-electron-node)
- **Scoped Biome formatting:** use `npx biome check --write <file>` on the files you touched — `pnpm check`/`format` reformat the whole repo. (Memory: biome-check-hardcodes-dot)
- **Every scroll container uses the `ScrollArea` component**, never raw `overflow-auto`. (Memory: all-scroll-uses-scrollarea)
- **Log every business catch** at `warn`/`error` with context before returning — the new IPC handler follows `readImageFile`'s shape exactly. (CLAUDE.md §5)
- **Implement in a dedicated worktree** on its own branch; commit per task. (CLAUDE.md §6, Memory: always-worktree-before-edit)

---

## File Structure

| File | Responsibility |
|---|---|
| `src/main/ipc/swarm-ipc.ts` (modify) | Add `readDocumentFile` IPC handler + `DOCUMENT_MIME` map + `MAX_DOCUMENT_BYTES`; register & dispose. |
| `src/preload/index.ts` (modify) | Expose `window.swarm.readDocumentFile`. |
| `src/shared/types/ui.ts` (modify) | Add `readDocumentFile` to `SwarmBridge`. |
| `src/renderer/src/components/ui-renderers/document.tsx` (create) | `DocumentCard` renderer + `base64ToBlob` helper. Loads bytes via IPC, builds blob URL, renders PDF thumbnail or type-icon card, calls `onOpenFile` on click. |
| `src/renderer/src/components/ui-renderers/document.test.tsx` (create) | Unit tests for `base64ToBlob` and `DocumentCard`. |
| `src/renderer/src/components/ui-renderers/index.tsx` (modify) | Add `onOpenFile?` to `UiRendererProps`; register `pdf`/`docx`/`xlsx`/`csv` → `DocumentCard`. |
| `src/renderer/src/components/ui-renderers/index.test.ts` (create) | Registry resolution test. |
| `src/renderer/src/components/task-transcript.tsx` (modify) | Thread `onOpenFile` into `createSegmentRenderer`; `TaskTimeline` owns one `AttachmentViewerSheet`. |

**Key reuse facts (do not re-derive):**
- The transcript's `render_ui` branch already calls `coerceProps(spec.props)` before passing `props` to the renderer, so `DocumentCard` receives an already-coerced object — it must NOT call `coerceProps` itself (avoids a circular import with `index.tsx`).
- `readImageFile` is **image-only**: `IMAGE_MIME[extname(path)]` gates it (swarm-ipc.ts:255). Do not loosen it; add a sibling.
- The composer's `AttachmentViewerSheet` consumes a `ViewerFile = { url; mediaType?; filename? }`; pdf/xlsx/docx viewers take `url` as `src`, csv is fetched as text from the same URL. Blob URLs already work for all four.
- `renderPdfThumbnailUrl({ url, pageIndex, width })` (in `@/components/pdf-thumbnail-utils`) returns a Promise of a PNG object URL using a shared, long-lived pdfium engine cache. **Do not revoke its returned URL** — that cache owns it; revoke only the blob URL the card created.

---

### Task 1: `readDocumentFile` IPC (main + preload + type)

**Files:**
- Modify: `src/main/ipc/swarm-ipc.ts` (after line 27, and after the `readImageFile` handler at line 266, and in the dispose block around line 323)
- Modify: `src/preload/index.ts:280-282`
- Modify: `src/shared/types/ui.ts:367`

**Interfaces:**
- Produces: `window.swarm.readDocumentFile(path: string): Promise<{ mediaType: string; data: string } | null>` — base64 document bytes (no `data:` prefix) or null when missing/oversized/unsupported.

**No unit test** — matches the `readImageFile` precedent (no dedicated test). Gate is `npm run typecheck`; covered end-to-end by the manual verification in Task 4.

- [ ] **Step 1: Add `DOCUMENT_MIME` + `MAX_DOCUMENT_BYTES` after `MAX_IMAGE_BYTES`**

In `src/main/ipc/swarm-ipc.ts`, immediately after line 27 (`const MAX_IMAGE_BYTES = 25 * 1024 * 1024`), insert:

```ts
// The document extensions render_ui can inline-preview (mirrors renderer fileKind).
const DOCUMENT_MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.csv': 'text/csv',
}
// Documents can be larger than images; cap so a huge PDF doesn't become a giant
// base64 string crossing the IPC bridge.
const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024
```

- [ ] **Step 2: Add the `readDocumentFile` handler + register it**

In `src/main/ipc/swarm-ipc.ts`, immediately after the `ipcMain.handle('system:readImageFile', readImageFile)` line (line 266), insert:

```ts
  const readDocumentFile = async (
    _e: Electron.IpcMainInvokeEvent,
    path: unknown
  ): Promise<{ mediaType: string; data: string } | null> => {
    if (typeof path !== 'string') return null
    const mediaType = DOCUMENT_MIME[extname(path).toLowerCase()]
    if (!mediaType) return null
    try {
      const buf = await readFile(expandHome(path))
      if (buf.byteLength > MAX_DOCUMENT_BYTES) return null
      return { mediaType, data: buf.toString('base64') }
    } catch (err) {
      log.warn({ msg: 'readDocumentFile failed', path, err: String(err) })
      return null
    }
  }
  ipcMain.handle('system:readDocumentFile', readDocumentFile)
```

- [ ] **Step 3: Dispose the handler**

In the dispose block, immediately after `ipcMain.removeHandler('system:readImageFile')` (around line 323), add:

```ts
      ipcMain.removeHandler('system:readDocumentFile')
```

- [ ] **Step 4: Expose it on the preload bridge**

In `src/preload/index.ts`, immediately after the `readImageFile` block (lines 280-281), add:

```ts
  readDocumentFile: (path: string) =>
    ipcRenderer.invoke('system:readDocumentFile', path) as Promise<{ mediaType: string; data: string } | null>,
```

- [ ] **Step 5: Add it to the `SwarmBridge` type**

In `src/shared/types/ui.ts`, immediately after the `readImageFile` doc line (line 367), add:

```ts
  /** Read a local document file (pdf/docx/xlsx/csv) as base64 for inline preview. Returns null if missing, too large, or unsupported. */
  readDocumentFile(path: string): Promise<{ mediaType: string; data: string } | null>
```

- [ ] **Step 6: Verify it typechecks**

Run: `npm run typecheck`
Expected: PASS (no errors). If `readImageFile` is still the only bridge member flagged, recheck the spelling/insertion points.

- [ ] **Step 7: Commit**

```bash
git add src/main/ipc/swarm-ipc.ts src/preload/index.ts src/shared/types/ui.ts
git commit -m "feat(ipc): add readDocumentFile for base64 document reads"
```

---

### Task 2: `DocumentCard` + `base64ToBlob` (TDD)

**Files:**
- Create: `src/renderer/src/components/ui-renderers/document.tsx`
- Test: `src/renderer/src/components/ui-renderers/document.test.tsx`

**Interfaces:**
- Consumes: `window.swarm.readDocumentFile` (Task 1), `renderPdfThumbnailUrl` from `@/components/pdf-thumbnail-utils`, `ViewerFile` type from `@/components/attachment-viewer-sheet` (type-only).
- Produces: `DocumentCard` (a `UiRenderer`), `base64ToBlob(data, mediaType): Blob`.

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/components/ui-renderers/document.test.tsx`:

```tsx
// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { base64ToBlob, DocumentCard } from './document'

// pdf-thumbnail-utils pulls in the pdfium wasm + worker engine — too heavy for jsdom.
vi.mock('@/components/pdf-thumbnail-utils', () => ({
  renderPdfThumbnailUrl: vi.fn(() => Promise.resolve('blob:thumb')),
}))

const readDocumentFile = vi.fn<(path: string) => Promise<{ mediaType: string; data: string } | null>>()

beforeEach(() => {
  readDocumentFile.mockReset()
  ;(globalThis as unknown as { window: Window }).window.swarm = {
    readDocumentFile,
  } as unknown as Window['swarm']
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('base64ToBlob', () => {
  it('decodes base64 into a typed Blob', async () => {
    // 'AAEC' → bytes 0x00 0x01 0x02
    const blob = base64ToBlob('AAEC', 'application/pdf')
    expect(blob.type).toBe('application/pdf')
    const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()))
    expect(bytes).toEqual([0, 1, 2])
  })
})

describe('DocumentCard', () => {
  it('shows the filename and opens the file on click', async () => {
    readDocumentFile.mockResolvedValueOnce({ mediaType: 'application/pdf', data: 'AAEC' })
    const onOpenFile = vi.fn()

    render(<DocumentCard props={{ path: '/abs/report.pdf', name: 'report.pdf' }} onOpenFile={onOpenFile} />)

    const btn = await screen.findByRole('button', { name: /report\.pdf/ })
    await waitFor(() => expect(btn).not.toBeDisabled())
    fireEvent.click(btn)

    expect(onOpenFile).toHaveBeenCalledWith({
      url: 'blob:mock',
      mediaType: 'application/pdf',
      filename: 'report.pdf',
    })
  })

  it('shows an error state and keeps the name when the file cannot be read', async () => {
    readDocumentFile.mockResolvedValueOnce(null)

    render(<DocumentCard props={{ path: '/missing.pdf' }} />)

    await waitFor(() => expect(screen.getByText('Unable to preview')).toBeInTheDocument())
    expect(screen.getByText('missing.pdf')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- document.test`
Expected: FAIL — `Failed to resolve import "./document"` (module does not exist yet).

- [ ] **Step 3: Implement `DocumentCard` + `base64ToBlob`**

Create `src/renderer/src/components/ui-renderers/document.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { FileText } from 'lucide-react'

import type { ViewerFile } from '@/components/attachment-viewer-sheet'
import { renderPdfThumbnailUrl } from '@/components/pdf-thumbnail-utils'

import type { UiRendererProps } from '.'

// Thumbnail width (CSS px) for the PDF first-page preview.
const THUMB_WIDTH = 160

type DocumentSpec = { path?: string; name?: string }

/** Decode a base64 string into a Blob carrying the given media type. */
export function base64ToBlob(data: string, mediaType: string): Blob {
  const bin = atob(data)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type: mediaType })
}

// Inline file card for render_ui document types (pdf/docx/xlsx/csv). Pulls the
// file's bytes over IPC as base64, builds a blob URL, and renders either a PDF
// first-page thumbnail or a type-icon chip. Clicking opens the full viewer via
// onOpenFile. The transcript already coerces `props` to an object before passing
// it in, so no coerceProps call is needed here.
export const DocumentCard = ({ props, onOpenFile }: UiRendererProps): React.JSX.Element => {
  const spec = (props ?? {}) as DocumentSpec
  const path = typeof spec.path === 'string' ? spec.path : ''
  const filename = spec.name?.trim() || (path ? (path.split('/').pop() as string) : 'document')

  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [mediaType, setMediaType] = useState<string | undefined>(undefined)
  const [thumbUrl, setThumbUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  // Load bytes → blob URL. Memoized by path; revoked on change/unmount.
  useEffect(() => {
    let alive = true
    let madeUrl: string | null = null
    setBlobUrl(null)
    setMediaType(undefined)
    setThumbUrl(null)
    setFailed(false)
    void (async () => {
      const file = path ? await window.swarm.readDocumentFile(path) : null
      if (!alive) return
      if (!file) {
        setFailed(true)
        return
      }
      madeUrl = URL.createObjectURL(base64ToBlob(file.data, file.mediaType))
      setBlobUrl(madeUrl)
      setMediaType(file.mediaType)
    })()
    return () => {
      alive = false
      if (madeUrl) URL.revokeObjectURL(madeUrl)
    }
  }, [path])

  // PDF first-page thumbnail (cache owned by pdf-thumbnail-utils; do not revoke).
  useEffect(() => {
    if (!blobUrl || mediaType !== 'application/pdf') return
    let alive = true
    void renderPdfThumbnailUrl({ url: blobUrl, pageIndex: 0, width: THUMB_WIDTH }).then((u) => {
      if (alive && u) setThumbUrl(u)
    })
    return () => {
      alive = false
    }
  }, [blobUrl, mediaType])

  const open = (): void => {
    if (blobUrl) onOpenFile?.({ url: blobUrl, mediaType, filename })
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        className="flex w-full items-center gap-3 rounded-lg border border-border bg-transparent px-3 py-2.5 text-left text-sm transition-colors enabled:hover:border-primary/40 enabled:hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
        disabled={!blobUrl}
        onClick={open}
        type="button"
      >
        {thumbUrl ? (
          <img
            alt={filename}
            className="size-16 shrink-0 rounded border border-border/40 object-cover"
            src={thumbUrl}
          />
        ) : (
          <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <FileText className="size-5" />
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{filename}</span>
          {failed && <span className="block text-muted-foreground text-xs">Unable to preview</span>}
        </span>
      </button>
    </div>
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- document.test`
Expected: PASS — 3 tests (`base64ToBlob`, `DocumentCard` open-on-click, `DocumentCard` error state).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/ui-renderers/document.tsx src/renderer/src/components/ui-renderers/document.test.tsx
git commit -m "feat(renderer): add DocumentCard for inline document preview"
```

---

### Task 3: Register document types + extend `UiRendererProps` (TDD)

**Files:**
- Modify: `src/renderer/src/components/ui-renderers/index.tsx`
- Test: `src/renderer/src/components/ui-renderers/index.test.ts`

**Interfaces:**
- Consumes: `DocumentCard` from Task 2.
- Produces: `UiRendererProps.onOpenFile?: (file: ViewerFile) => void`; REGISTRY entries for `pdf`/`docx`/`xlsx`/`csv`.

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/components/ui-renderers/index.test.ts`:

```tsx
import { describe, expect, it, vi } from 'vitest'

// document.tsx imports the heavy pdf-thumbnail-utils; stub it so loading the
// registry doesn't pull in the pdfium wasm + worker engine.
vi.mock('@/components/pdf-thumbnail-utils', () => ({
  renderPdfThumbnailUrl: vi.fn(),
}))

import { getUiRenderer } from './index'

describe('ui renderers registry', () => {
  it.each(['pdf', 'docx', 'xlsx', 'csv'])('resolves a renderer for %s', (type) => {
    expect(getUiRenderer(type)).toBeDefined()
  })

  it('returns undefined for an unknown type', () => {
    expect(getUiRenderer('nope')).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- ui-renderers/index.test`
Expected: FAIL — `getUiRenderer('pdf')` returns undefined (not yet registered).

- [ ] **Step 3: Extend `UiRendererProps` and register the cards**

In `src/renderer/src/components/ui-renderers/index.tsx`:

Add the type-only import at the top (with the other imports near line 1-5):

```tsx
import type { ViewerFile } from '@/components/attachment-viewer-sheet'

import { DocumentCard } from './document'
```

Add `onOpenFile` to `UiRendererProps` (replacing the existing type alias):

```tsx
export type UiRendererProps = {
  props: unknown
  /** Interactive cards call this to start a new user turn with the chosen value. */
  onSend?: (text: string) => void
  /** Disabled while a run is in flight to avoid double submits. */
  disabled?: boolean
  /** Document cards call this to open the file in the attachment viewer sheet. */
  onOpenFile?: (file: ViewerFile) => void
}
```

Register the four document types in `REGISTRY` (replacing the existing const):

```tsx
const REGISTRY: Record<string, UiRenderer> = {
  choice: ChoiceCard,
  weather: WeatherCard,
  pdf: DocumentCard,
  docx: DocumentCard,
  xlsx: DocumentCard,
  csv: DocumentCard,
}
```

(`DocumentCard` is generic across the four types: the IPC returns the correct `mediaType` from the file's extension, so a single component drives all four — PDF shows a thumbnail, the rest show an icon.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- ui-renderers/index.test`
Expected: PASS — 5 tests (4 resolutions + unknown-returns-undefined).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/ui-renderers/index.tsx src/renderer/src/components/ui-renderers/index.test.ts
git commit -m "feat(renderer): register pdf/docx/xlsx/csv render_ui cards"
```

---

### Task 4: Thread `onOpenFile` through the transcript + mount one sheet

**Files:**
- Modify: `src/renderer/src/components/task-transcript.tsx` (imports; `createSegmentRenderer` opts + render_ui branch; `TaskTimeline` body + both return paths)

**Interfaces:**
- Consumes: `UiRendererProps.onOpenFile` (Task 3), `AttachmentViewerSheet` + `ViewerFile` from `@/components/attachment-viewer-sheet`.
- Produces: a transcript where a `render_ui` document card opens the sheet on click.

**No automated component test** — the card's behavior is unit-tested in Task 2; Task 4 is wiring (thread one callback + mount one Sheet). A `TaskTimeline` component test would need a heavy `TaskRecord`/`UIEvent` fixture and has no precedent (`timeline.test.ts` covers only pure helpers). Gate: `npm run typecheck` + the manual verification below (which the spec designates as the transcript-integration proof).

- [ ] **Step 1: Add the `AttachmentViewerSheet` import**

At the top of `src/renderer/src/components/task-transcript.tsx`, with the other `@/components/...` imports, add:

```tsx
import { AttachmentViewerSheet, type ViewerFile } from '@/components/attachment-viewer-sheet'
```

- [ ] **Step 2: Add `onOpenFile` to `createSegmentRenderer`'s opts**

Change the `createSegmentRenderer` opts type and destructure (around line 213-219) to:

```tsx
function createSegmentRenderer(opts: {
  busy: boolean
  onSend?: (text: string) => void
  onCopy: (text: string) => void
  onDelete?: (taskId: string) => void
  onOpenFile?: (file: ViewerFile) => void
}): (seg: Segment, isLiveTail: boolean) => React.JSX.Element {
  const { busy, onSend, onCopy, onDelete, onOpenFile } = opts
```

- [ ] **Step 3: Pass `onOpenFile` to the renderer in the `render_ui` branch**

In the `render_ui` branch (around line 292), change the `<Renderer .../>` line to:

```tsx
          <Renderer disabled={busy} onOpenFile={onOpenFile} onSend={onSend} props={coerceProps(spec.props)} />
```

- [ ] **Step 4: Make `TaskTimeline` own the sheet + wire `setViewerFile`**

In `TaskTimeline` (around line 355-364), add the state hook and pass `onOpenFile` into the renderer. Change:

```tsx
  const ordered = sortBy(tasks, ['startedAt'])
  const renderSegment = createSegmentRenderer({ busy, onSend, onCopy, onDelete })
```

to:

```tsx
  const [viewerFile, setViewerFile] = useState<ViewerFile | null>(null)
  const ordered = sortBy(tasks, ['startedAt'])
  const renderSegment = createSegmentRenderer({
    busy,
    onCopy,
    onDelete,
    onOpenFile: setViewerFile,
    onSend,
  })
```

(`useState` is already imported in this file — confirm at top; if not, add it to the existing `react` import.)

- [ ] **Step 5: Mount the sheet in both return paths**

Change the early return (around line 405-407):

```tsx
  if (!showDayDividers) {
    return <>{items.map((it) => it.node)}</>
  }
```

to:

```tsx
  if (!showDayDividers) {
    return (
      <>
        {items.map((it) => it.node)}
        <AttachmentViewerSheet file={viewerFile} onOpenChange={(open) => !open && setViewerFile(null)} />
      </>
    )
  }
```

And change the final return (around line 426) from `return <>{out}</>` to:

```tsx
  return (
    <>
      {out}
      <AttachmentViewerSheet file={viewerFile} onOpenChange={(open) => !open && setViewerFile(null)} />
    </>
  )
```

- [ ] **Step 6: Verify it typechecks and the full suite passes**

Run: `npm run typecheck`
Expected: PASS.

Run: `npm test`
Expected: PASS (all existing tests + the new document/registry tests). No existing test should regress — `AttachmentViewerSheet` is already mocked in `chat-input.test.tsx`, and the new sheet mount in `TaskTimeline` is inert when `viewerFile` is null.

- [ ] **Step 7: Manual verification (run-desktop)**

Launch the app (run-desktop skill). In a session, get the agent to emit a render_ui document card — e.g. ask it to call `render_ui({ type: 'pdf', props: { path: '<abs path to a real .pdf>', name: 'sample.pdf' } })` for a PDF you placed on disk. Confirm:

- The transcript shows an inline card; for PDF the first-page thumbnail appears, for docx/xlsx/csv a type-icon chip with the filename.
- Clicking the card opens the `AttachmentViewerSheet` on the right with the full viewer (PDF: paging `PDFViewer`; docx/xlsx/csv: their respective viewers).
- A non-existent path renders the card with "Unable to preview" and the filename still visible.

Repeat for one docx, one xlsx, one csv. If the thumbnail or sheet is blank, check `userData/swarm-dev.log` for a `readDocumentFile failed` warn line (CLAUDE.md §5 — the catch logs the path + error).

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/components/task-transcript.tsx
git commit -m "feat(renderer): open AttachmentViewerSheet from render_ui document cards"
```

---

## Self-Review

**Spec coverage:**
- New `readDocumentFile` IPC (main + preload + type) → Task 1. ✓
- `DocumentCard` + `base64ToBlob`, PDF thumbnail via `renderPdfThumbnailUrl`, error state, `onOpenFile` on click → Task 2. ✓
- `UiRendererProps.onOpenFile` + REGISTRY entries for pdf/docx/xlsx/csv → Task 3. ✓
- Thread `onOpenFile` through `createSegmentRenderer`; single `AttachmentViewerSheet` at `TaskTimeline` root → Task 4. ✓
- Blob URL lifecycle (create on path, revoke on change/unmount) → Task 2 effect. ✓
- Error handling (null/oversized/missing → degraded card) → Task 1 handler returns null; Task 2 "Unable to preview" state. ✓
- Testing (unit for card + registry; typecheck + manual for transcript) → Tasks 2-4. ✓

**Placeholder scan:** none — every code step shows complete code; every command shows expected output.

**Type consistency:** `readDocumentFile` returns `{ mediaType: string; data: string } | null` in all three layers (IPC, preload, `SwarmBridge`). `UiRendererProps.onOpenFile?: (file: ViewerFile) => void` matches the `ViewerFile` shape `DocumentCard` emits (`{ url, mediaType, filename }`) and what `AttachmentViewerSheet` accepts. `DocumentCard` is registered under all four type keys and is a valid `UiRenderer` (typed via `UiRendererProps`).

**Note on spec refinement:** the spec offered an optional `onOpenFile` prop on `TaskTimelineProps` so a parent could supply its own sheet. Dropped as YAGNI — no current parent owns a sheet for transcript cards, and `TaskTimeline` mounting its own is simpler and matches the spec's "when omitted, TaskTimeline mounts the sheet itself" fallback. The sheet is inert (`file === null`) until a card is clicked, so mounting it unconditionally is free.
