// src/renderer/src/components/attachment-viewer-sheet.tsx
import { Suspense, lazy, useEffect, useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useTheme } from 'next-themes'

import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { fileKind } from '@/lib/file-kind'

// Heavy viewers (react-xlsx ~3.4MB, react-docx ~1.3MB, @embedpdf ~hundreds of KB)
// are lazy-loaded so they land in async chunks and only download when the user
// actually opens an attachment. Kept static previously, they inflated the shared
// chunk to 6.6MB and crashed vite's WASM-based import-analysis during build.
const CsvViewer = lazy(() =>
  import('@/components/ui/csv-viewer').then((m) => ({ default: m.CsvViewer })),
)
const DocxViewerPreview = lazy(() =>
  import('@/components/ui/docx-viewer').then((m) => ({ default: m.DocxViewerPreview })),
)
const PDFViewer = lazy(() =>
  import('@/components/ui/pdf-viewer').then((m) => ({ default: m.PDFViewer })),
)
const XlsxViewerPreview = lazy(() =>
  import('@/components/ui/xlsx-viewer').then((m) => ({ default: m.XlsxViewerPreview })),
)

export type ViewerFile = { url: string; mediaType?: string; filename?: string }

type Props = {
  file: ViewerFile | null
  onOpenChange: (open: boolean) => void
}

// The composer stores each attachment's `url` as a blob: object URL
// (URL.createObjectURL). The pdf/xlsx/docx viewers take that URL as `src`
// directly; only CSV needs the raw text, which we fetch from the same URL.
function useFetchedText(url: string | null): string | null {
  const [text, setText] = useState<string | null>(null)
  useEffect(() => {
    if (!url) {
      setText(null)
      return
    }
    let cancelled = false
    void fetch(url)
      .then((r) => r.text())
      .then((t) => {
        if (!cancelled) setText(t)
      })
      .catch(() => {
        if (!cancelled) setText(null)
      })
    return () => {
      cancelled = true
    }
  }, [url])
  return text
}

function ViewerFallback(): React.JSX.Element {
  return (
    <div className="flex h-full items-center justify-center text-muted-foreground">
      <Loader2 className="size-5 animate-spin" />
    </div>
  )
}

function ViewerBody({ file }: { file: ViewerFile }): React.JSX.Element {
  const { resolvedTheme } = useTheme()
  const [isDark, setIsDark] = useState(resolvedTheme === 'dark')
  useEffect(() => {
    setIsDark(resolvedTheme === 'dark')
  }, [resolvedTheme])

  const kind = useMemo(() => fileKind(file.mediaType), [file.mediaType])
  const csvText = useFetchedText(kind === 'csv' ? file.url : null)

  if (kind === 'pdf') {
    return <PDFViewer className="h-full" fileName={file.filename} src={file.url} />
  }
  if (kind === 'xlsx') {
    return (
      <XlsxViewerPreview
        className="h-full"
        fileName={file.filename}
        isDark={isDark}
        onIsDarkChange={setIsDark}
        src={file.url}
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
        src={file.url}
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
        <div className="min-h-0 flex-1 overflow-hidden">
          {file !== null && (
            <Suspense fallback={<ViewerFallback />}>
              <ViewerBody file={file} />
            </Suspense>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
