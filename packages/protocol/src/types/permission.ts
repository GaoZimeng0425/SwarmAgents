import { z } from 'zod'

import { RiskSchema } from './ipc'

export const PermissionRequestPayloadSchema = z.object({
  actionId: z.string(),
  messageId: z.string(),
  toolName: z.string(),
  risk: RiskSchema,
  summary: z.string(),
  payload: z.unknown(),
})
export type PermissionRequestPayload = z.infer<typeof PermissionRequestPayloadSchema>
