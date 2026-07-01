import { useEffect, useState } from 'react'
import { FileText } from 'lucide-react'

import type { ViewerFile } from '@/components/attachment-viewer-sheet'

// Thumbnail width (CSS px) for the PDF first-page preview.
const THUMB_WIDTH = 160

// DocumentCard types its own props inline rather than importing UiRendererProps
// so this file typechecks before the registry adds onOpenFile to that type.
// Once registered, DocumentCard is structurally assignable to UiRenderer
// (UiRendererProps ⊆ DocumentCardProps).
type DocumentCardProps = {
  props: unknown
  onOpenFile?: (file: ViewerFile) => void
}

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
export const DocumentCard = ({ props, onOpenFile }: DocumentCardProps): React.JSX.Element => {
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
  // Dynamically imported so the pdfium wasm engine stays out of this module's
  // static graph — document.tsx is pulled in widely via the ui-renderers
  // registry, and consumers (hooks, etc.) must not drag the wasm into tests.
  useEffect(() => {
    if (!blobUrl || mediaType !== 'application/pdf') return
    let alive = true
    void import('@/components/pdf-thumbnail-utils').then(({ renderPdfThumbnailUrl }) =>
      renderPdfThumbnailUrl({ url: blobUrl, pageIndex: 0, width: THUMB_WIDTH }).then((u) => {
        if (alive && u) setThumbUrl(u)
      })
    )
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
