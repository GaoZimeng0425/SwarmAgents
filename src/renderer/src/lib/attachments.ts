import type { Attachment } from '@shared/types/task'

// The minimal shape we need from the composer's FileUIPart.
type FileLike = { mediaType?: string; filename?: string; url?: string }

/** Keep only image/* files whose url is a base64 data URL; convert to Attachment[]. */
export function imageAttachmentsFrom(files: readonly FileLike[]): Attachment[] {
  const out: Attachment[] = []
  for (const f of files) {
    if (!f.mediaType?.startsWith('image/')) continue
    const match = f.url?.match(/^data:([^;]+);base64,(.+)$/)
    if (!match) continue
    out.push({ data: match[2], mimeType: f.mediaType, ...(f.filename ? { name: f.filename } : {}) })
  }
  return out
}
