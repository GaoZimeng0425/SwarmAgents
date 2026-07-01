// src/renderer/src/components/attachment-viewer-sheet.tsx
import { useEffect, useMemo, useState } from 'react'
import { useTheme } from 'next-themes'

import { CsvViewer } from '@/components/ui/csv-viewer'
import { DocxViewerPreview } from '@/components/ui/docx-viewer'
import { PDFViewer } from '@/components/ui/pdf-viewer'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { XlsxViewerPreview } from '@/components/ui/xlsx-viewer'
import { fileKind } from '@/lib/file-kind'

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
        <div className="min-h-0 flex-1 overflow-hidden">{file !== null && <ViewerBody file={file} />}</div>
      </SheetContent>
    </Sheet>
  )
}
