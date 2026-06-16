import type { PdfDocumentObject, PdfEngine } from '@embedpdf/models'
// local-adapt: bundle pdfium.wasm as a local asset instead of fetching from the jsdelivr
// CDN. The app's CSP is connect-src 'self', so a CDN fetch is blocked, and a desktop app
// must work offline. Vite emits the wasm and resolves a same-origin URL at build time.
import PDFIUM_WASM_URL from '@embedpdf/pdfium/pdfium.wasm?url'

let sharedEnginePromise: Promise<PdfEngine> | null = null
const pdfDocumentCache = new Map<string, Promise<PdfDocumentObject>>()
const thumbnailUrlCache = new Map<string, Promise<string | null>>()

export function loadSharedPdfEngine() {
  sharedEnginePromise ??= import('@embedpdf/engines/pdfium-worker-engine').then(({ createPdfiumEngine }) =>
    createPdfiumEngine(PDFIUM_WASM_URL, {})
  )

  return sharedEnginePromise
}

export async function loadPdfDocument(url: string) {
  let documentPromise = pdfDocumentCache.get(url)

  if (!documentPromise) {
    documentPromise = loadSharedPdfEngine().then((engine) =>
      engine.openDocumentUrl({ id: url, url }, { mode: url.startsWith('blob:') ? 'full-fetch' : 'auto' }).toPromise()
    )
    pdfDocumentCache.set(url, documentPromise)
  }

  return documentPromise
}

export async function getPdfPageCount(url: string) {
  return (await loadPdfDocument(url)).pageCount
}

export function renderPdfThumbnailUrl({
  dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1,
  pageIndex,
  url,
  width,
}: {
  dpr?: number
  pageIndex: number
  url: string
  width: number
}) {
  const cacheKey = `${url}#${pageIndex}@${width}x${dpr}`
  let thumbnailPromise = thumbnailUrlCache.get(cacheKey)

  if (!thumbnailPromise) {
    thumbnailPromise = (async () => {
      const [engine, document] = await Promise.all([loadSharedPdfEngine(), loadPdfDocument(url)])
      const page = document.pages[pageIndex]

      if (!page) return null

      const blob = await engine
        .renderThumbnail(document, page, {
          dpr,
          imageType: 'image/png',
          scaleFactor: width / page.size.width,
          withAnnotations: true,
        })
        .toPromise()

      return URL.createObjectURL(blob)
    })()
    thumbnailUrlCache.set(cacheKey, thumbnailPromise)
  }

  return thumbnailPromise
}
