// src/renderer/src/hooks/use-native-confirm.ts
//
// Thin wrapper over window.swarm.showConfirm. Used by the events bridge to
// raise a native dialog.showMessageBox for high-risk permission requests
// (spec §9). Returns the chosen role.
import { useCallback } from 'react'
import type { ConfirmRequest, ConfirmResponse } from '@shared/types/ipc'

export function useNativeConfirm(): (req: ConfirmRequest) => Promise<ConfirmResponse> {
  return useCallback((req) => window.swarm.showConfirm(req), [])
}
