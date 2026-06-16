# Extend UI File Viewers in the Composer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users attach PDF / XLSX / DOCX / CSV files in the chat composer and view them (view-only, not sent to the agent) in a side sheet powered by Extend UI viewer components.

**Architecture:** Vendor Extend's viewer source files (MIT) directly into `src/renderer/src/components/ui/` — their `@/components/ui/*` and `@/lib/utils` imports already resolve to this project's existing base-ui primitives. Install only the npm render libraries (`@extend-ai/*`, `@embedpdf/*`, `@glideapps/glide-data-grid`, icons). Add a `AttachmentViewerSheet` that maps a file's mediaType to the matching viewer. Widen the composer's `accept` and render typed chips for non-image attachments that open the sheet on click. The agent submit path (`imageAttachmentsFrom`) is unchanged, so non-image files are never sent — view-only holds by construction.

**Tech Stack:** Electron + electron-vite, React, TypeScript, `@base-ui/react` shadcn primitives, Vitest, Biome, next-themes. Spec: `docs/superpowers/specs/2026-06-16-extend-ui-file-viewers-design.md`.

---

## Reference facts (verified against the repo and Extend's registry)

- Composer file flow lives in `src/renderer/src/components/chat-input.tsx` and `src/renderer/src/components/ai-elements/prompt-input.tsx`.
- `PromptInput` attachment files have shape `{ id, filename?, url, mediaType }` where `url` is a base64 **data URL** (built via `FileReader.readAsDataURL`) and `mediaType` is `file.type`.
- `matchesAccept` in `prompt-input.tsx` (lines ~465-486) supports ONLY `prefix/*` patterns and **exact** mime strings (`f.type === pattern`). It does NOT match by file extension. So `accept` must list exact mime types.
- On submit, `imageAttachmentsFrom(message.files)` (`src/renderer/src/lib/attachments.ts`) keeps only `image/*` data URLs. Non-image files are already dropped here.
- `@/components/ui/sheet.tsx` exports `Sheet, SheetTrigger, SheetClose, SheetContent, SheetHeader, SheetFooter, SheetTitle, SheetDescription`. `SheetContent` takes `side?: "top" | "right" | "bottom" | "left"` (default `"right"`).
- Theme: `useTheme()` from `next-themes`; `ThemeProvider` is mounted with `attribute="class"` + `enableSystem` in `src/renderer/src/entries/main.tsx`. Use `resolvedTheme === 'dark'`.
- Vite alias `@` → `src/renderer/src`; tsconfig path `@/*` matches. `@/lib/utils` exports `cn`.
- Exact public viewer APIs (from `extend-hq/ui` `apps/v4/components/ui/*.tsx`):
  - `PDFViewer` (`React.forwardRef`) — `PDFViewerProps { src?: string; fileName?: string; showToolbar?; showDownload?; showUpload?; ... }`
  - `XlsxViewerPreview` — `{ src?: string; fileName?: string; isDark: boolean; onIsDarkChange: (b: boolean) => void; showUpload?; showDownload?; showToolbar?; ... }` (`isDark`/`onIsDarkChange` are **required**)
  - `DocxViewerPreview` — `{ src?: string; fileName?: string; isDark: boolean; onIsDarkChange: (b: boolean) => void; ... }` (`isDark`/`onIsDarkChange` **required**)
  - `CsvViewer` — `{ className?: string; data?: string; search?: boolean }` (`data` is raw CSV **text**)
- Complete vendored file set + their non-standard imports:
  - `ui/csv-viewer.tsx` — standard primitives only
  - `ui/xlsx-viewer.tsx` — `@extend-ai/react-xlsx` + standard primitives
  - `ui/docx-viewer.tsx` — `@extend-ai/react-docx` + `@/components/ui/{document-viewer-sidebar,docx-annotation-card,file-thumbnail}`
  - `ui/docx-annotation-card.tsx` — `@extend-ai/react-docx` + `@/components/ui/{badge,card}` (both exist)
  - `ui/document-viewer-sidebar.tsx` — `@/lib/utils` only (shared by pdf + docx)
  - `ui/file-thumbnail.tsx` — React only
  - `ui/pdf-viewer.tsx` — `@embedpdf/*` + `@/components/ui/document-viewer-sidebar` + `@/components/pdf-thumbnail-utils`
  - `components/pdf-thumbnail-utils.ts` — `@embedpdf/*`

---

## File structure

**Vendored (downloaded verbatim from Extend, keep their license header):**
- `src/renderer/src/components/ui/csv-viewer.tsx`
- `src/renderer/src/components/ui/xlsx-viewer.tsx`
- `src/renderer/src/components/ui/docx-viewer.tsx`
- `src/renderer/src/components/ui/docx-annotation-card.tsx`
- `src/renderer/src/components/ui/document-viewer-sidebar.tsx`
- `src/renderer/src/components/ui/file-thumbnail.tsx`
- `src/renderer/src/components/ui/pdf-viewer.tsx`
- `src/renderer/src/components/pdf-thumbnail-utils.ts`

**New (our code):**
- `src/renderer/src/lib/file-kind.ts` — pure mediaType → viewer-kind classifier (+ test)
- `src/renderer/src/lib/data-url.ts` — data-URL → Blob / text helpers (+ test)
- `src/renderer/src/components/attachment-viewer-sheet.tsx` — the side-sheet viewer host

**Modified:**
- `src/renderer/src/components/chat-input.tsx` — widen `accept`, typed chips, open sheet, raise size cap
- `src/renderer/src/lib/attachments.test.ts` — assert non-image types stay excluded (view-only invariant)
- `electron.vite.config.ts` — only if the PDF WASM needs explicit asset handling (Task 8)

---

## Task 1: Install render-library dependencies

**Files:**
- Modify: `package.json` (via package manager; do not hand-edit)

- [ ] **Step 1: Add the viewer render libs and icons**

This project uses pnpm (see `pnpm-lock.yaml`, `pnpm-workspace.yaml`).

```bash
pnpm add \
  @extend-ai/react-xlsx@^0.10.0 \
  @extend-ai/react-docx@^0.7.1 \
  @tanstack/react-virtual@^3.13.12 \
  pdf-lib@^1.17.1 \
  papaparse@^5.5.3 \
  @glideapps/glide-data-grid@6.0.4-alpha24 \
  @hugeicons/core-free-icons@^4.2.0 \
  @hugeicons/react@^1.1.6 \
  @embedpdf/core@^2.14.4 @embedpdf/engines@^2.14.4 @embedpdf/models@^2.14.4 \
  @embedpdf/plugin-document-manager@^2.14.4 @embedpdf/plugin-interaction-manager@^2.14.4 \
  @embedpdf/plugin-render@^2.14.4 @embedpdf/plugin-rotate@^2.14.4 @embedpdf/plugin-scroll@^2.14.4 \
  @embedpdf/plugin-search@^2.14.4 @embedpdf/plugin-selection@^2.14.4 @embedpdf/plugin-thumbnail@^2.14.4 \
  @embedpdf/plugin-tiling@^2.14.4 @embedpdf/plugin-viewport@^2.14.4 @embedpdf/plugin-zoom@^2.14.4
```

- [ ] **Step 2: Add `@types/papaparse` (dev)**

```bash
pnpm add -D @types/papaparse
```

- [ ] **Step 3: Install and check for unmet peer deps**

`@glideapps/glide-data-grid` declares peer dependencies. Read the pnpm output: if it warns about missing peers (commonly `lodash`, `marked`, `react-number-format`), install exactly those it names, e.g.:

```bash
pnpm add lodash marked react-number-format   # only those pnpm reported missing
pnpm add -D @types/lodash                     # only if you installed lodash
```

If pnpm reports no missing peers, skip this step.

- [ ] **Step 4: Verify the install did not break the existing build**

Run: `pnpm run typecheck`
Expected: PASS (no usage added yet — this only confirms the new packages didn't introduce type-level breakage). Do NOT run `pnpm rebuild` for native modules; if a postinstall ran, leave it.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "build: add Extend UI viewer render dependencies"
```

---

## Task 2: Vendor the Extend viewer source files

**Files (all created):** the 8 vendored files listed in File Structure.

- [ ] **Step 1: Download the viewer + helper files from Extend into the right locations**

Run from the repo root. These paths mirror Extend's `apps/v4/components/` so the files' internal `@/components/ui/*` imports resolve unchanged in this project (`@` → `src/renderer/src`).

```bash
GH="repos/extend-hq/ui/contents/apps/v4/components"
UI="src/renderer/src/components/ui"
CMP="src/renderer/src/components"

# ui/*.tsx viewers + helpers
for f in csv-viewer xlsx-viewer docx-viewer docx-annotation-card document-viewer-sidebar file-thumbnail pdf-viewer; do
  gh api "$GH/ui/$f.tsx" --jq '.content' | base64 -d > "$UI/$f.tsx"
done

# components/pdf-thumbnail-utils.ts (note: .ts, lives one level up)
gh api "$GH/pdf-thumbnail-utils.ts" --jq '.content' | base64 -d > "$CMP/pdf-thumbnail-utils.ts"
```

- [ ] **Step 2: Confirm all 8 files downloaded non-empty**

Run: `wc -l src/renderer/src/components/ui/{csv,xlsx,docx,pdf}-viewer.tsx src/renderer/src/components/ui/{docx-annotation-card,document-viewer-sidebar,file-thumbnail}.tsx src/renderer/src/components/pdf-thumbnail-utils.ts`
Expected: every file has a non-zero line count (viewers are hundreds–thousands of lines). If any is 0/1 lines, the download failed — re-run that file.

- [ ] **Step 3: Verify imports resolve and primitive APIs are compatible**

This is the key compatibility gate — it proves Extend's wrappers type-check against this project's base-ui primitives.

Run: `pnpm run typecheck:web`
Expected: PASS.

If there are errors, they will be one of:
  - **Missing module `@/components/...`** → a transitive Extend file was not downloaded. Identify it from the error path and download it the same way as Step 1.
  - **Prop / sub-component mismatch** (e.g. a `Tabs`/`Select`/`Tooltip` prop the viewer uses that this project's base-ui version names differently) → apply a minimal edit *inside the vendored file* to match the local primitive's API. Keep edits surgical; note each one with a `// local-adapt:` comment.

- [ ] **Step 4: Lint the vendored files (do not reformat the whole repo)**

Per project convention, scope Biome to the new files:

```bash
npx biome check --write src/renderer/src/components/ui/csv-viewer.tsx src/renderer/src/components/ui/xlsx-viewer.tsx src/renderer/src/components/ui/docx-viewer.tsx src/renderer/src/components/ui/docx-annotation-card.tsx src/renderer/src/components/ui/document-viewer-sidebar.tsx src/renderer/src/components/ui/file-thumbnail.tsx src/renderer/src/components/ui/pdf-viewer.tsx src/renderer/src/components/pdf-thumbnail-utils.ts
```

Expected: completes; auto-fixes formatting. If Biome reports unfixable lint errors in vendored code, prefer a targeted `// biome-ignore` over rewriting third-party logic.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/ui/csv-viewer.tsx src/renderer/src/components/ui/xlsx-viewer.tsx src/renderer/src/components/ui/docx-viewer.tsx src/renderer/src/components/ui/docx-annotation-card.tsx src/renderer/src/components/ui/document-viewer-sidebar.tsx src/renderer/src/components/ui/file-thumbnail.tsx src/renderer/src/components/ui/pdf-viewer.tsx src/renderer/src/components/pdf-thumbnail-utils.ts
git commit -m "feat(ui): vendor Extend PDF/XLSX/DOCX/CSV viewer components"
```

---

## Task 3: `file-kind.ts` — classify an attachment's mediaType (TDD)

**Files:**
- Create: `src/renderer/src/lib/file-kind.ts`
- Test: `src/renderer/src/lib/file-kind.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/renderer/src/lib/file-kind.test.ts
import { describe, expect, it } from 'vitest'

import { ATTACHMENT_ACCEPT, fileKind } from './file-kind'

describe('fileKind', () => {
  it('classifies the supported document types', () => {
    expect(fileKind('application/pdf')).toBe('pdf')
    expect(fileKind('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe('xlsx')
    expect(fileKind('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe('docx')
    expect(fileKind('text/csv')).toBe('csv')
  })

  it('classifies images', () => {
    expect(fileKind('image/png')).toBe('image')
    expect(fileKind('image/jpeg')).toBe('image')
  })

  it('falls back to "other" for unknown types', () => {
    expect(fileKind('text/plain')).toBe('other')
    expect(fileKind(undefined)).toBe('other')
  })

  it('exposes an accept string covering images + the four doc types', () => {
    expect(ATTACHMENT_ACCEPT).toContain('image/*')
    expect(ATTACHMENT_ACCEPT).toContain('application/pdf')
    expect(ATTACHMENT_ACCEPT).toContain('text/csv')
    expect(ATTACHMENT_ACCEPT).toContain('spreadsheetml.sheet')
    expect(ATTACHMENT_ACCEPT).toContain('wordprocessingml.document')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- src/renderer/src/lib/file-kind.test.ts`
Expected: FAIL — cannot find module `./file-kind`.

- [ ] **Step 3: Write the implementation**

```ts
// src/renderer/src/lib/file-kind.ts

/** Viewer category for a composer attachment, derived from its mediaType. */
export type FileKind = 'image' | 'pdf' | 'xlsx' | 'docx' | 'csv' | 'other'

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

export function fileKind(mediaType: string | undefined): FileKind {
  if (!mediaType) return 'other'
  if (mediaType.startsWith('image/')) return 'image'
  if (mediaType === 'application/pdf') return 'pdf'
  if (mediaType === XLSX_MIME) return 'xlsx'
  if (mediaType === DOCX_MIME) return 'docx'
  if (mediaType === 'text/csv') return 'csv'
  return 'other'
}

/**
 * `accept` for the composer file input. The composer's matchesAccept only
 * supports `prefix/*` and exact mime strings — extensions like `.csv` are NOT
 * matched, so every non-image type is listed by exact mime.
 */
export const ATTACHMENT_ACCEPT = ['image/*', 'application/pdf', XLSX_MIME, DOCX_MIME, 'text/csv'].join(',')
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test -- src/renderer/src/lib/file-kind.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/file-kind.ts src/renderer/src/lib/file-kind.test.ts
git commit -m "feat: add attachment file-kind classifier and accept list"
```

---

## Task 4: `data-url.ts` — decode a data URL to a Blob (TDD)

**Files:**
- Create: `src/renderer/src/lib/data-url.ts`
- Test: `src/renderer/src/lib/data-url.test.ts`

Viewers that take `src` (PDF/XLSX/DOCX) get a stable object URL; CSV needs raw text. Both derive from a Blob.

- [ ] **Step 1: Write the failing test**

```ts
// src/renderer/src/lib/data-url.test.ts
import { describe, expect, it } from 'vitest'

import { dataUrlToBlob } from './data-url'

describe('dataUrlToBlob', () => {
  it('decodes a base64 data URL into a Blob with the right type and bytes', async () => {
    // "Hi" -> base64 "SGk="
    const blob = dataUrlToBlob('data:text/csv;base64,SGk=')
    expect(blob.type).toBe('text/csv')
    expect(await blob.text()).toBe('Hi')
  })

  it('throws on a non-base64 data URL', () => {
    expect(() => dataUrlToBlob('https://example.com/a.pdf')).toThrow()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- src/renderer/src/lib/data-url.test.ts`
Expected: FAIL — cannot find module `./data-url`.

- [ ] **Step 3: Write the implementation**

```ts
// src/renderer/src/lib/data-url.ts

/** Decode a `data:<mime>;base64,<payload>` URL into a Blob. Throws if not a base64 data URL. */
export function dataUrlToBlob(dataUrl: string): Blob {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
  if (!match) throw new Error('Not a base64 data URL')
  const mime = match[1]
  const binary = atob(match[2])
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test -- src/renderer/src/lib/data-url.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/data-url.ts src/renderer/src/lib/data-url.test.ts
git commit -m "feat: add data-url to Blob decoder"
```

---

## Task 5: `AttachmentViewerSheet` — host the viewers in a side sheet

**Files:**
- Create: `src/renderer/src/components/attachment-viewer-sheet.tsx`

- [ ] **Step 1: Write the component**

```tsx
// src/renderer/src/components/attachment-viewer-sheet.tsx
import { useEffect, useMemo, useState } from 'react'
import { useTheme } from 'next-themes'

import { CsvViewer } from '@/components/ui/csv-viewer'
import { DocxViewerPreview } from '@/components/ui/docx-viewer'
import { PDFViewer } from '@/components/ui/pdf-viewer'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { XlsxViewerPreview } from '@/components/ui/xlsx-viewer'
import { dataUrlToBlob } from '@/lib/data-url'
import { fileKind } from '@/lib/file-kind'

export type ViewerFile = { url: string; mediaType?: string; filename?: string }

type Props = {
  file: ViewerFile | null
  onOpenChange: (open: boolean) => void
}

/** Convert a base64 data URL to an object URL for the lifetime of `dataUrl`. */
function useObjectUrl(dataUrl: string | null): string | null {
  const [objectUrl, setObjectUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!dataUrl) {
      setObjectUrl(null)
      return
    }
    const url = URL.createObjectURL(dataUrlToBlob(dataUrl))
    setObjectUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [dataUrl])
  return objectUrl
}

/** Read a base64 data URL as text (for CSV). */
function useTextContent(dataUrl: string | null): string | null {
  const [text, setText] = useState<string | null>(null)
  useEffect(() => {
    if (!dataUrl) {
      setText(null)
      return
    }
    let cancelled = false
    dataUrlToBlob(dataUrl)
      .text()
      .then((t) => {
        if (!cancelled) setText(t)
      })
    return () => {
      cancelled = true
    }
  }, [dataUrl])
  return text
}

function ViewerBody({ file }: { file: ViewerFile }): React.JSX.Element {
  const { resolvedTheme } = useTheme()
  const [isDark, setIsDark] = useState(resolvedTheme === 'dark')
  useEffect(() => {
    setIsDark(resolvedTheme === 'dark')
  }, [resolvedTheme])

  const kind = useMemo(() => fileKind(file.mediaType), [file.mediaType])
  // `src`-based viewers (pdf/xlsx/docx) take an object URL; csv takes text.
  const objectUrl = useObjectUrl(kind === 'csv' ? null : file.url)
  const csvText = useTextContent(kind === 'csv' ? file.url : null)

  if (kind === 'pdf') {
    return <PDFViewer className="h-full" fileName={file.filename} src={objectUrl ?? undefined} />
  }
  if (kind === 'xlsx') {
    return (
      <XlsxViewerPreview
        className="h-full"
        fileName={file.filename}
        isDark={isDark}
        onIsDarkChange={setIsDark}
        src={objectUrl ?? undefined}
      />
    )
  }
  if (kind === 'docx') {
    return (
      <DocxViewerPreview
        className="h-full"
        fileName={file.filename}
        isDark={isDark}
        onIsDarkChange={setIsDark}
        src={objectUrl ?? undefined}
      />
    )
  }
  if (kind === 'csv') {
    return <CsvViewer className="h-full" data={csvText ?? undefined} search />
  }
  return <p className="p-4 text-muted-foreground text-sm">No preview available for this file type.</p>
}

export function AttachmentViewerSheet({ file, onOpenChange }: Props): React.JSX.Element {
  return (
    <Sheet onOpenChange={onOpenChange} open={file !== null}>
      <SheetContent className="w-full gap-0 p-0 sm:max-w-3xl" side="right">
        <SheetHeader className="border-b px-4 py-3">
          <SheetTitle className="truncate">{file?.filename ?? 'Preview'}</SheetTitle>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-hidden">{file !== null && <ViewerBody file={file} />}</div>
      </SheetContent>
    </Sheet>
  )
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `pnpm run typecheck:web`
Expected: PASS.

If a viewer's prop names differ from the Reference facts (e.g. `src` vs `url`), open the corresponding vendored file, confirm the actual exported prop, and adjust the call here. The exported names verified at plan time are `PDFViewer`, `XlsxViewerPreview`, `DocxViewerPreview`, `CsvViewer`.

- [ ] **Step 3: Lint the new file (scoped)**

Run: `npx biome check --write src/renderer/src/components/attachment-viewer-sheet.tsx`
Expected: completes.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/attachment-viewer-sheet.tsx
git commit -m "feat(ui): add AttachmentViewerSheet hosting Extend viewers"
```

---

## Task 6: Wire the composer — accept all four types, typed chips, open the sheet

**Files:**
- Modify: `src/renderer/src/components/chat-input.tsx`

- [ ] **Step 1: Update imports and the file-size cap**

In `src/renderer/src/components/chat-input.tsx`, add imports near the existing ones:

```tsx
import { useState } from 'react'
import { FileText, Paperclip, X } from 'lucide-react'

import { AttachmentViewerSheet, type ViewerFile } from '@/components/attachment-viewer-sheet'
import { ATTACHMENT_ACCEPT, fileKind } from '@/lib/file-kind'
```

Notes:
- The file already imports `useMemo` from `'react'` (line 1) and `{ Paperclip, X }` from `'lucide-react'` (line 5). Merge `useState` into the existing `react` import and `FileText` into the existing `lucide-react` import rather than adding duplicate import lines.

Raise the size cap so documents fit (line 43):

```tsx
const MAX_FILE_SIZE = 25 * 1024 * 1024
```

- [ ] **Step 2: Replace the `AttachBar` thumbnail strip with type-aware chips**

Replace the `AttachBar` function (currently lines ~70-100). It must accept a callback to open the viewer for non-image files:

```tsx
// Thumbnail strip + attach button; must be a child of PromptInput (uses its attachments context).
function AttachBar({
  supportsImages,
  onOpenFile,
}: {
  supportsImages: boolean
  onOpenFile: (file: ViewerFile) => void
}): React.JSX.Element {
  const attachments = usePromptInputAttachments()
  return (
    <>
      {attachments.files.length > 0 && (
        <div className="flex flex-wrap gap-2 px-1 pb-1">
          {attachments.files.map((f) => {
            const kind = fileKind(f.mediaType)
            return (
              <div className="relative" key={f.id}>
                {kind === 'image' ? (
                  <img alt={f.filename ?? 'attachment'} className="size-14 rounded-md border object-cover" src={f.url} />
                ) : (
                  <button
                    className="flex h-14 max-w-40 items-center gap-2 rounded-md border bg-muted/40 px-2.5 text-left hover:bg-muted"
                    onClick={() => onOpenFile({ url: f.url, mediaType: f.mediaType, filename: f.filename })}
                    title={f.filename ?? 'attachment'}
                    type="button"
                  >
                    <FileText className="size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate text-xs">{f.filename ?? kind.toUpperCase()}</span>
                  </button>
                )}
                <button
                  aria-label="Remove attachment"
                  className="absolute -top-1.5 -right-1.5 rounded-full bg-background p-0.5 text-muted-foreground shadow hover:text-foreground"
                  onClick={() => attachments.remove(f.id)}
                  type="button"
                >
                  <X className="size-3" />
                </button>
              </div>
            )
          })}
        </div>
      )}
      <PromptInputButton
        disabled={!supportsImages}
        onClick={() => attachments.openFileDialog()}
        tooltip={supportsImages ? 'Attach files' : "This model can't read images"}
      >
        <Paperclip className="size-4" />
      </PromptInputButton>
    </>
  )
}
```

Note: the attach button stays gated on `supportsImages` because image-sending requires a vision model; document viewing is always allowed but the same button opens the dialog. This preserves current behavior (the tooltip wording is the only copy change). If product wants the attach button always enabled, that is a follow-up — out of scope here.

- [ ] **Step 3: Add viewer state and the `accept` change in `ChatInput`**

Inside the `ChatInput` component body, add state for the file being previewed:

```tsx
const [viewerFile, setViewerFile] = useState<ViewerFile | null>(null)
```

Change the `PromptInput` `accept` prop (line ~148) from `accept="image/*"` to:

```tsx
accept={ATTACHMENT_ACCEPT}
```

Pass the open callback to `AttachBar` (line ~159):

```tsx
<AttachBar onOpenFile={setViewerFile} supportsImages={supportsImages} />
```

Render the sheet once, inside the component's returned tree (e.g. immediately after the closing `</PromptInput>`, still inside the outer `<div>`):

```tsx
<AttachmentViewerSheet file={viewerFile} onOpenChange={(open) => !open && setViewerFile(null)} />
```

- [ ] **Step 4: Verify type-check and lint**

Run: `pnpm run typecheck:web`
Expected: PASS.

Run: `npx biome check --write src/renderer/src/components/chat-input.tsx`
Expected: completes.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/chat-input.tsx
git commit -m "feat(ui): accept PDF/XLSX/DOCX/CSV in composer and open viewer sheet"
```

---

## Task 7: Lock the view-only invariant with a test

**Files:**
- Modify: `src/renderer/src/lib/attachments.test.ts`

The agent submit path must never carry these new types. `imageAttachmentsFrom` already drops non-images; this adds explicit regression coverage for the four document types.

- [ ] **Step 1: Add a failing-then-passing assertion**

Append inside the `describe('imageAttachmentsFrom', ...)` block in `src/renderer/src/lib/attachments.test.ts`:

```ts
it('never carries document attachments to the agent (view-only)', () => {
  const docs = [
    { type: 'file', mediaType: 'application/pdf', filename: 'a.pdf', url: 'data:application/pdf;base64,AAAB' },
    {
      type: 'file',
      mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      filename: 'a.xlsx',
      url: 'data:application/octet-stream;base64,AAAB',
    },
    {
      type: 'file',
      mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      filename: 'a.docx',
      url: 'data:application/octet-stream;base64,AAAB',
    },
    { type: 'file', mediaType: 'text/csv', filename: 'a.csv', url: 'data:text/csv;base64,AAAB' },
  ]
  expect(imageAttachmentsFrom(docs)).toEqual([])
})
```

- [ ] **Step 2: Run the test**

Run: `pnpm test -- src/renderer/src/lib/attachments.test.ts`
Expected: PASS (existing 3 tests + this new one = 4). It passes immediately because `imageAttachmentsFrom` already filters to `image/*` — this is a regression guard, not new behavior.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/lib/attachments.test.ts
git commit -m "test: assert document attachments are never sent to the agent"
```

---

## Task 8: Verify viewers render in the running app; fix PDF WASM if needed

**Files:**
- Modify (only if required): `electron.vite.config.ts`

This is the highest-risk task. PDF rendering loads a pdfium WASM via `@embedpdf/engines`; electron-vite may not serve it correctly out of the box. XLSX/DOCX/CSV have no WASM dependency and should work once they type-check.

- [ ] **Step 1: Launch the app**

Use the `run-desktop` skill (or `pnpm dev`) to start the SwarmAgents desktop app.

- [ ] **Step 2: Manually exercise each viewer**

For each of a sample `.csv`, `.xlsx`, `.docx`, and `.pdf` file:
  1. Click the attach (paperclip) button in the composer and select the file.
  2. Confirm a typed chip (not a broken image) appears with the filename.
  3. Click the chip → the right-side sheet opens.
  4. Confirm the document renders. Confirm the remove (×) button clears the chip.
  5. Confirm sending a message does NOT attach the document (only text/image attachments reach the agent).

Expected: CSV, XLSX, DOCX render. PDF may fail (see Step 3).

- [ ] **Step 3: If the PDF viewer fails to load the WASM**

Symptoms: console error about fetching/instantiating a `.wasm`, a missing worker, or a blank PDF pane while the other viewers work.

Fix options, in order of preference:
  1. Ensure the renderer can load the pdfium WASM as an asset. In `electron.vite.config.ts`, under the `renderer` config, confirm `optimizeDeps`/`assetsInclude` does not strip `.wasm`, and that `@embedpdf/engines` is not externalized. Add `assetsInclude: ['**/*.wasm']` to the renderer config if absent.
  2. If `@embedpdf/engines` ships the WASM as a separate file fetched at runtime, it may need to be copied to the renderer output or served from `resources/`. Follow EmbedPDF's docs for bundler setup and wire the engine's WASM URL accordingly inside `pdf-thumbnail-utils.ts` / `pdf-viewer.tsx` initialization.
  3. **Fallback if WASM cannot be made to work in this Electron build (do not block the other three viewers):** in `attachment-viewer-sheet.tsx`, render the "No preview available" message for `kind === 'pdf'` and log a TODO referencing this task. Ship XLSX/DOCX/CSV; track PDF as a follow-up. Update the spec's Risks section to record the outcome.

- [ ] **Step 4: Re-verify after any config change**

If you changed `electron.vite.config.ts`, restart the app and repeat Step 2 for the PDF.

- [ ] **Step 5: Commit (only if files changed)**

```bash
git add electron.vite.config.ts src/renderer/src/components/attachment-viewer-sheet.tsx
git commit -m "fix(ui): load pdfium WASM in the renderer for the PDF viewer"
```

(If nothing changed because everything rendered, skip this commit.)

---

## Task 9: Full verification gate

**Files:** none (verification only)

- [ ] **Step 1: Run the project's full verify pipeline**

Run: `pnpm run verify`
(This runs typecheck + lint + tests + the native-feel check.)
Expected: PASS.

If `lint` flags vendored third-party files with rules that conflict with their style and the issues are non-functional, add the narrowest `// biome-ignore` justified by a short reason rather than rewriting third-party logic. Re-run until green.

- [ ] **Step 2: Final commit if the verify step required fixes**

```bash
git add -A
git commit -m "chore: satisfy verify gate for Extend UI viewers"
```

---

## Self-review notes (addressed in this plan)

- **Spec coverage:** accept widening + typed chips + side sheet (Tasks 6, 5); view-only invariant (Task 7 + unchanged `imageAttachmentsFrom`); vendoring approach with full transitive file set (Task 2); new deps (Task 1); PDF/WASM risk with explicit fallback (Task 8); primitive-API-drift mitigation (Task 2 Step 3); `pnpm run verify` gate (Task 9).
- **`@hugeicons` new icon lib:** accepted as scoped to vendored files (spec risk #3); no task swaps it to lucide. If a single-icon-lib policy is desired later, that is a follow-up.
- **Type consistency:** viewer component/prop names (`PDFViewer`/`XlsxViewerPreview`/`DocxViewerPreview`/`CsvViewer`, `src`/`data`/`isDark`/`onIsDarkChange`) verified against Extend source and used identically in Task 5; `ViewerFile`, `fileKind`, `ATTACHMENT_ACCEPT`, `dataUrlToBlob` defined in Tasks 3-5 and consumed in Tasks 5-6 with matching signatures.
- **Known limitation:** CSV files whose OS-reported mime is empty or `application/vnd.ms-excel` won't match `text/csv` in the composer's exact-mime `matchesAccept`. Documented; broadening would require editing the shared `prompt-input.tsx` matcher and is out of scope.
```
