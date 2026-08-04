// useCommandRecorder — capture a new hotkey and bind it to a command.
//
// Thin wrapper over TanStack's useHotkeyRecorder that persists the result into
// the command-bindings store. A settings UI calls `start(commandId)` when the
// user begins rebinding, reads `isRecording`/`recordedHotkey` for live preview,
// and the recorded hotkey is committed automatically via `onRecord`.
//
// The "which command are we rebinding" id is kept in a ref (not component
// state) because the recorder's onRecord/onCancel fire from the recorder's own
// event loop and need to read the latest id synchronously. TanStack's
// useHotkeyRecorder re-syncs its callbacks every render (via setOptions), so
// the closures below always observe the current ref value.

import { useRef, useState } from 'react'
import { useHotkeyRecorder } from '@tanstack/react-hotkeys'

import type { CommandId } from '@/lib/commands/definitions'
import { useCommandBindingsStore } from '@/stores/command-bindings'

export interface UseCommandRecorderResult {
  /** Whether a recording is currently in progress. */
  isRecording: boolean
  /** The hotkey as recorded so far (for live preview), or null. */
  recordedHotkey: string | null
  /** Command id currently being rebound, or null when idle. */
  recordingFor: CommandId | null
  /** Begin recording a new binding for `id`. Replaces any prior in-flight run. */
  start: (id: CommandId) => void
  /** Abort recording without saving. */
  cancel: () => void
}

export function useCommandRecorder(): UseCommandRecorderResult {
  const setBinding = useCommandBindingsStore((s) => s.setBinding)
  const recordingForRef = useRef<CommandId | null>(null)
  // `recordingFor` is exposed to the UI, so mirror it into state for reactivity.
  const [recordingFor, setRecordingFor] = useState<CommandId | null>(null)

  const recorder = useHotkeyRecorder({
    onRecord: (hotkey) => {
      const id = recordingForRef.current
      if (id) setBinding(id, hotkey)
      recordingForRef.current = null
      setRecordingFor(null)
    },
    onCancel: () => {
      recordingForRef.current = null
      setRecordingFor(null)
    },
  })

  return {
    isRecording: recorder.isRecording,
    recordedHotkey: recorder.recordedHotkey,
    recordingFor,
    start: (id) => {
      recordingForRef.current = id
      setRecordingFor(id)
      recorder.startRecording()
    },
    cancel: () => {
      recordingForRef.current = null
      setRecordingFor(null)
      recorder.cancelRecording()
    },
  }
}
