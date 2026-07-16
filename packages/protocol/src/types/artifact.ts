import { z } from 'zod'

export const ArtifactSchema = z.object({
  kind: z.enum(['file', 'note', 'image']),
  path: z.string().optional(),
  text: z.string().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
})
export type Artifact = z.infer<typeof ArtifactSchema>

export const AttachmentSchema = z.object({
  data: z.string(), // base64-encoded bytes (no data: prefix)
  mimeType: z.string(),
  name: z.string().optional(),
})
export type Attachment = z.infer<typeof AttachmentSchema>
