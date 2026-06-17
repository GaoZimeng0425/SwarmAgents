# Extend UI File Viewers in the Composer — Design

**Date:** 2026-06-16
**Status:** Proposed
**Author:** GaoZimeng (with Claude)

## Summary

Let users attach **PDF, XLSX, DOCX, and CSV** files in the chat composer and
**view** them in a side sheet, using viewer components from
[Extend UI](https://github.com/extend-hq/ui) (`@extend/*` shadcn registry, MIT).

Scope is **view-only**: attached non-image files are previewed by the user and
are **not** sent to the agent. This matches the existing image-attachment flow,
which is the only thing fed to the model today.

## Background

Extend UI is a shadcn-style, source-distributed component library for
document-heavy apps. The viewer wrappers are thin UI; the actual rendering is
done by npm packages:

| Viewer | Render lib(s) | Icons |
|---|---|---|
| `pdf-viewer` | `@embedpdf/*` (14 pkgs) + `pdf-lib` | `@hugeicons/*` |
| `xlsx-viewer` | `@extend-ai/react-xlsx` | `@hugeicons/*` |
| `docx-viewer` | `@extend-ai/react-docx` | `@hugeicons/*` |
| `csv-viewer` | `@glideapps/glide-data-grid` + `papaparse` | `@hugeicons/*` |

Each wrapper imports `@/lib/utils` (`cn`) and `@/components/ui/{button,
dropdown-menu, input, popover, scroll-area, select, separator, spinner, tabs,
tooltip}` — **all of which already exist in this project** (base-ui-backed
shadcn primitives). `pdf-viewer`/`docx-viewer` also reference internal helpers
`document-viewer-sidebar` and `file-thumbnail`, which are vendored too.

Project facts that make this clean:
- Vite alias `@` → `src/renderer/src`; tsconfig path `@/*` matches. Extend's
  `@/...` imports resolve as-is.
- Project already uses `@base-ui/react@^1.5.0`; Extend's components target the
  same family (their `docx-editor` depends on `@base-ui/react`).

## Current composer attachment flow

- `chat-input.tsx` renders `PromptInput` (from `@/components/ai-elements/
  prompt-input`) with `accept="image/*"`, `maxFiles=4`, `maxFileSize=5MB`.
- `PromptInput` holds attachments in context: each file has `{ id, filename,
  url (base64 data URL), mediaType }`, plus `openFileDialog()` / `remove(id)`.
- `AttachBar` renders a thumbnail strip — currently hardcoded `<img src={f.url}>`
  for every file (assumes images) — and the attach button.
- On submit, `imageAttachmentsFrom(message.files)` keeps **only** `image/*`
  base64 files and converts them to `Attachment[]` for the agent. Non-image
  files are dropped here.

## Approach

### Install: vendor source manually (chosen)

Copy the viewer wrappers + internal helpers into
`src/renderer/src/components/ui/viewers/`, and `npm install` only the render
libs. No `components.json`, no shadcn CLI run.

Rationale: the wrappers' imports already resolve in this project, so vendoring
is a copy + dependency install. It avoids the shadcn CLI resolving
`registryDependencies` (button/select/tabs…) against the **default Radix
registry** and overwriting our base-ui primitives.

Rejected alternative — shadcn CLI (`npx shadcn add @extend/pdf-viewer`):
easier future updates, but risks clobbering existing base-ui primitives and
requires a `components.json` tuned to skip overwrites. Not worth the risk for a
one-time integration of 4 viewers.

### Components & data flow

1. **`chat-input.tsx` — widen accept.** Change `PromptInput accept` from
   `image/*` to also allow `application/pdf`, the OOXML/legacy spreadsheet and
   document mimetypes, and `text/csv`. Vision-gating (`supportsImages`) stays
   image-specific — the attach button is always enabled now, but the tooltip /
   gating logic for *images* is preserved.

2. **`AttachBar` — typed chips.** Branch on `mediaType`:
   - `image/*` → existing thumbnail `<img>`.
   - else → a file chip (type icon + filename + remove button). Clicking the
     chip opens the viewer sheet for that file.

3. **New `AttachmentViewerSheet` component**
   (`src/renderer/src/components/attachment-viewer-sheet.tsx`): a `Sheet`
   (side panel, reusing `@/components/ui/sheet`) that takes the selected
   attachment, switches on mimetype, and renders the matching Extend viewer.
   Input is the attachment's base64 data URL, decoded to the bytes/`Blob`/
   `ArrayBuffer` shape each viewer expects.

4. **Submit path unchanged.** `imageAttachmentsFrom` still filters to images, so
   view-only holds by construction — no backend / `Attachment` type changes.

### Files touched / added

- **Add (vendored from Extend, MIT):** the viewer source files go **directly in
  `src/renderer/src/components/ui/`** (not a `viewers/` subdir) so Extend's
  internal `@/components/ui/*` cross-imports resolve with zero rewriting. Full
  set, derived from the registry's `files` + `registryDependencies`:
  - `ui/csv-viewer.tsx` (self-contained)
  - `ui/xlsx-viewer.tsx` (self-contained)
  - `ui/docx-viewer.tsx` + `ui/docx-annotation-card.tsx` + `ui/document-viewer-sidebar.tsx` + `ui/file-thumbnail.tsx`
  - `ui/pdf-viewer.tsx` + `components/pdf-thumbnail-utils.ts` + `ui/document-viewer-sidebar.tsx` (shared with docx)
- **Add:** `src/renderer/src/components/attachment-viewer-sheet.tsx`.
- **Edit:** `src/renderer/src/components/chat-input.tsx` (accept list + AttachBar
  branch + sheet wiring).
- **Edit:** `electron.vite.config.ts` if PDF WASM needs asset/worker config.
- **Edit:** `package.json` (new deps).

### New dependencies

`@extend-ai/react-xlsx`, `@extend-ai/react-docx`, `@embedpdf/*` (14),
`pdf-lib`, `@glideapps/glide-data-grid`, `papaparse`, `@hugeicons/core-free-icons`,
`@hugeicons/react`.

## Risks & mitigations

1. **PDF / pdfium WASM under electron-vite (highest risk).**
   `@embedpdf/engines` loads a pdfium `.wasm` in the renderer. electron-vite +
   the Electron sandbox may need explicit asset/worker handling (and CSP allowance
   if a policy exists). **Mitigation:** spike PDF first as a standalone render
   test. If it fights the sandbox, ship XLSX/DOCX/CSV first and defer/iterate on
   PDF (or use a simpler PDF fallback). PDF is isolated to its own viewer file, so
   deferring it does not block the others.

2. **Primitive API drift.** Viewers call our base-ui `Tabs/Select/Tooltip/
   DropdownMenu`. Names follow shadcn convention but a prop/sub-component may
   differ. **Mitigation:** typecheck after vendoring; apply small per-viewer
   adapter fixes. Localized to vendored files.

3. **New icon library.** `@hugeicons/*` lands alongside `lucide-react`.
   Acceptable (scoped to vendored files). Optional: swap to lucide during
   vendoring if we want a single icon lib.

4. **Bundle size.** ~16 new packages, mostly for PDF. Renderer-only; acceptable
   for a desktop app. No code-splitting work planned beyond what Vite does.

## Testing / verification

- **Unit:** extend the existing `attachments.test.ts` to assert non-image files
  are still excluded from `imageAttachmentsFrom` (view-only invariant).
- **Manual (run-desktop skill):** attach one file of each type → open sheet →
  confirm it renders; confirm remove works; confirm non-image files are not sent
  to the agent.
- **Gate:** `pnpm run verify` (typecheck + lint + test + native-feel) passes.

## Out of scope

- Sending PDF/XLSX/DOCX/CSV content to the agent.
- Editing documents (Extend's `*-editor` components).
- File browser / Finder, e-signature, bounding-box citations, document split.
- Rendering these file types in the transcript / tool results.
