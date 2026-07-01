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

// The composer's matchesAccept only supports `prefix/*` and exact mime strings —
// extensions like `.csv` are NOT matched, so every non-image type is listed by exact mime.
const DOCUMENT_MIMES = ['application/pdf', XLSX_MIME, DOCX_MIME, 'text/csv']

/** `accept` for documents only (no images) — used when the model has no vision support. */
export const DOCUMENT_ACCEPT = DOCUMENT_MIMES.join(',')

/** `accept` for images + documents — used when the model supports images. */
export const ATTACHMENT_ACCEPT = ['image/*', ...DOCUMENT_MIMES].join(',')
