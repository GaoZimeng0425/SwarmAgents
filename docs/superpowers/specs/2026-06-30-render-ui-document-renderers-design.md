# render_ui document renderers (PDF / docx / xlsx / csv)

**Date:** 2026-06-30
**Status:** Approved (design), pending implementation plan
**Scope:** Renderer + main IPC — no agent-tool semantics change

## Problem

`render_ui` is the agent's "render a UI card in the conversation" tool. The
renderer dispatches on `details.type` via a registry in
`src/renderer/src/components/ui-renderers/index.tsx`, which today only contains
`choice` and `weather`. There is no way for an agent to surface a document file
(a PDF report, a generated docx/xlsx, a CSV dump) inline in the transcript.

The viewer infrastructure already exists and is already wired into the composer's
`AttachmentViewerSheet`: `PDFViewer` (@embedpdf, full plugin suite),
`DocxViewerPreview`, `XlsxViewerPreview`, `CsvViewer`, plus
`renderPdfThumbnailUrl` for PDF page thumbnails. None of it is reachable from a
`render_ui` call.

## Goal

An agent call

```ts
render_ui({ type: 'pdf' | 'docx' | 'xlsx' | 'csv', props: { path: string; name?: string } })
```

renders an inline **file card** in the transcript:

- PDF cards show the first page as a thumbnail (via `renderPdfThumbnailUrl`).
- docx / xlsx / csv cards show a type icon + filename chip.
- Clicking any card opens the existing `AttachmentViewerSheet` with the full
  viewer for that file type, reusing the composer preview verbatim.

The `render_ui` tool itself is unchanged (it is already a generic type+props
mechanism); only the renderer registry and the byte-delivery path are extended.

## Non-goals (YAGNI)

- No inline full-viewer embed in the transcript (decided: thumbnail + sheet).
- No change to `render_ui` tool semantics, no new `terminate` behavior, no
  changes to interactive (`choice`) card logic.
- No remote-URL support — local filesystem paths only, matching `ToolImage`.
- No new document MIME types beyond what `fileKind` already classifies
  (`pdf` / `xlsx` / `docx` / `csv`).

## Background / existing mechanisms relied on

- **`render_ui` tool** (`src/service/tools/render-ui.ts`): emits
  `details: { type, props }`; non-blocking; `type` is the registry key.
- **Transcript dispatch** (`src/renderer/src/components/task-transcript.tsx`,
  `createSegmentRenderer`): when `seg.tool === 'render_ui'`, looks up
  `getUiRenderer(spec.type)`; on hit renders `<Renderer .../>` inside a
  `<Message from="assistant">`, on miss falls through to the generic Tool card.
- **Registry** (`src/renderer/src/components/ui-renderers/index.tsx`):
  `REGISTRY: Record<string, UiRenderer>` plus `getUiRenderer` and `coerceProps`
  (coerces a JSON-stringified `props` back to an object — models sometimes send
  object params as a JSON string).
- **`UiRendererProps`**: `{ props: unknown; onSend?; disabled? }`. This type gains
  one optional field, `onOpenFile?: (file: ViewerFile) => void`, which document
  cards call to open the sheet. Existing cards (`choice`, `weather`) ignore it;
  adding an optional field is non-breaking. The render_ui branch in
  `createSegmentRenderer` passes `onOpenFile` alongside `onSend`/`disabled`.
- **Byte delivery for tool-produced images** (`ToolImage` in task-transcript):
  the sandboxed renderer cannot read local files, so it pulls bytes over IPC —
  `window.swarm.readImageFile(path)` → `{ mimeType, data: base64 }` → `data:`
  URL. `readImageFile` (`src/main/ipc/swarm-ipc.ts`) is **image-only**: it
  returns null unless `IMAGE_MIME[extname(path)]` matches. A generic read path
  is required for documents.
- **`AttachmentViewerSheet`** (`src/renderer/src/components/attachment-viewer-sheet.tsx`):
  takes a `ViewerFile = { url: string; mediaType?: string; filename?: string }`,
  dispatches on `fileKind(mediaType)` to the right viewer. The pdf/xlsx/docx
  viewers consume the `url` directly as `src`; CSV is fetched as text from the
  same URL. Composer stores each attachment url as a `blob:` object URL, so
  blob URLs are known to work for all four viewers.
- **PDF thumbnails** (`src/renderer/src/components/pdf-thumbnail-utils.ts`):
  `renderPdfThumbnailUrl({ url, pageIndex, width })` returns a Promise of a PNG
  object URL using the shared pdfium engine; memoized by `(url, page, width, dpr)`.

## Design

### Data flow

```
agent → render_ui({ type:'pdf', props:{ path:'/a/b.pdf', name? } })
  → persisted in the task event (path string only — small)
transcript: seg.tool === 'render_ui' → REGISTRY['pdf'] → <DocumentCard .../>
DocumentCard (on mount):
  window.swarm.readDocumentFile(path)        // NEW IPC → { mediaType, data: base64 }
    → base64 → Blob → URL.createObjectURL     // blobUrl, memoized by path; revoked on unmount
  PDF only: renderPdfThumbnailUrl({ url: blobUrl, pageIndex: 0, width: THUMB_W }) → thumb URL
click card → onOpenFile({ url: blobUrl, mediaType, filename }) → AttachmentViewerSheet
```

### Components / files

| File | Change |
|---|---|
| `src/main/ipc/swarm-ipc.ts` | Add `readDocumentFile` handler: read an arbitrary local file by path → `{ mediaType, data: base64 }`. Infer `mediaType` from extension via the same mapping `fileKind`/`DOCUMENT_MIMES` uses (pdf / xlsx / docx / csv; reject others by returning null). Apply a document-size cap (e.g. `MAX_DOCUMENT_BYTES = 50 * 1024 * 1024`) returning null over the cap. Reuse `expandHome` + `readFile` + the existing `log.warn`-on-failure shape. Register `ipcMain.handle('system:readDocumentFile', …)` and `removeHandler` it in `dispose` next to `readImageFile`. |
| `src/preload/index.ts` | Expose `readDocumentFile: (path: string) => ipcRenderer.invoke('system:readDocumentFile', path) as Promise<{ mediaType: string; data: string } \| null>`. |
| `src/shared/types/ui.ts` | Add `readDocumentFile(path: string): Promise<{ mediaType: string; data: string } \| null>` to `SwarmBridge`, with a one-line doc comment, next to `readImageFile`. |
| `src/renderer/src/components/ui-renderers/document.tsx` | **New file.** Exports `DocumentCard: UiRenderer` (internally branches on `mediaType`) plus thin `PdfCard` / `DocxCard` / `XlsxCard` / `CsvCard` wrappers (or registry entries) so the four `type` keys map cleanly. Responsibilities: read `path`/`name` from `props`; load bytes via `window.swarm.readDocumentFile`; build + memoize the blob URL by path and revoke on unmount; for PDF render the first-page thumbnail via `renderPdfThumbnailUrl`; render a compact file card (thumbnail or type icon + filename); on click call `onOpenFile`. Shows a "file unreadable" state with the filename + an `openPath` fallback when the IPC returns null. |
| `src/renderer/src/components/ui-renderers/index.tsx` | Extend `UiRendererProps` with `onOpenFile?: (file: ViewerFile) => void`. Add `pdf` / `docx` / `xlsx` / `csv` entries to `REGISTRY`, each delegating to the corresponding card from `document.tsx`. Keep `coerceProps` usage so JSON-stringified `props` still works. |
| `src/renderer/src/components/task-transcript.tsx` | Thread a new optional callback through `createSegmentRenderer`: `onOpenFile?: (file: ViewerFile) => void`. The render_ui branch passes it to document cards. `TaskTimeline` owns a single `viewerFile` state and mounts **one** `AttachmentViewerSheet` (avoids N sheets across a long transcript). `TaskTimelineProps` gains optional `onOpenFile` so a parent that already owns a sheet can supply its own; when omitted, `TaskTimeline` mounts the sheet itself. |

`DocumentCard` consumes `onOpenFile` from its props (the new optional field on
`UiRendererProps`). The render_ui branch in `createSegmentRenderer` passes the
threaded `onOpenFile` to every renderer alongside `onSend`/`disabled`; non-document
cards simply ignore it.

### The new IPC, concretely

`readImageFile` is image-only by design (it gates on `IMAGE_MIME`). Rather than
loosen that gate (which would change the contract every `ToolImage` caller relies
on), add a sibling handler dedicated to documents. It mirrors `readImageFile`:

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
```

`DOCUMENT_MIME` is the ext→mime map for the four supported types (the inverse of
what `fileKind` accepts). This keeps the trusted renderer → main file-read
surface consistent with the existing one (same process boundary, same
base64-over-IPC shape, same size-cap + null-on-failure contract).

### Blob URL lifecycle

`DocumentCard` keeps `blobUrl` in state keyed by `path`. On `path` change it
fetches bytes, builds a `Blob` (`[Uint8Array.fromBase64(data)]`, `type:
mediaType`), and `URL.createObjectURL`. A cleanup effect `revokeObjectURL`s the
previous URL whenever `path` changes or the card unmounts, preventing leaks
across long transcripts. The PDF thumbnail URL from `renderPdfThumbnailUrl` is
likewise an object URL the card revokes on unmount.

## Error handling

- IPC returns null (missing / too large / unreadable / unsupported ext): card
  shows filename + "Unable to preview" + a working `openPath` ("Open in Finder")
  link, so the user is never stuck.
- Blob construction failure: same degraded state.
- File moved/deleted after the event was persisted: preview breaks, `openPath`
  still attempted — acceptable, identical to how `ToolImage` behaves.
- IPC handler never throws across the bridge: it logs at `warn` and resolves
  null (per CLAUDE.md §5 — every catch logs with context before returning).

## Testing & verification

- **Unit (`*.test.tsx`):** `document.tsx` pure helpers — ext→mediaType mapping,
  and the base64→Blob success/failure branches — with `window.swarm
  .readDocumentFile` mocked. A registry test asserting `getUiRenderer('pdf'
  \|'docx'\|'xlsx'\|'csv')` all resolve. (Run via `npm test`, the Electron-node
  vitest runner — never bare `npx vitest`.)
- **Type/build:** `npm run typecheck` clean.
- **Manual (run-desktop):** drop a PDF into a known path; have the agent call
  `render_ui({ type:'pdf', props:{ path } })`; confirm the transcript shows the
  first-page thumbnail and clicking opens `AttachmentViewerSheet` with a paging
  `PDFViewer`. Repeat for docx / xlsx / csv. Confirm a missing path renders the
  degraded card with a working "Open in Finder".
- **IPC handler:** no dedicated unit test — matches `readImageFile`, which has
  none; covered by the manual path.

## Open questions resolved during brainstorming

- **Which file types:** PDF + docx + xlsx + csv (all four; viewers already
  present).
- **Presentation:** thumbnail + click-to-open sheet (not full inline viewer) —
  keeps the chat flow light and reuses the composer sheet verbatim.
- **Byte delivery:** new `readDocumentFile` IPC (base64 over IPC), matching the
  `readImageFile` precedent — not a custom streaming protocol.
- **Sheet ownership:** one `AttachmentViewerSheet` at the `TaskTimeline` root,
  opened via an `onOpenFile` callback threaded through `createSegmentRenderer`
  — not one sheet per card.
