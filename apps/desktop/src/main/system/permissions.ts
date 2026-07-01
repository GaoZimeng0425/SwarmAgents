// src/main/system/permissions.ts
//
// macOS TCC permission status + deep-links to the right System Settings pane.
// The peekaboo screen tools (see_screen, list_apps) need Screen Recording and
// Accessibility. These are granted at runtime by the user — there is no
// Info.plist key to pre-declare them — so the app can only report status and
// open the correct settings pane.
import { shell, systemPreferences } from 'electron'
import type { MacPermissions, MacPermissionState } from '@swarm/protocol'

const isMac = process.platform === 'darwin'

function screenRecordingState(): MacPermissionState {
  // getMediaAccessStatus('screen'): 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown'
  const s = systemPreferences.getMediaAccessStatus('screen')
  if (s === 'granted') return 'granted'
  if (s === 'not-determined' || s === 'unknown') return 'not-determined'
  return 'denied' // denied | restricted
}

export function getMacPermissions(): MacPermissions {
  if (!isMac) return { screenRecording: 'unsupported', accessibility: 'unsupported' }
  return {
    screenRecording: screenRecordingState(),
    // `false` => check without triggering the system prompt.
    accessibility: systemPreferences.isTrustedAccessibilityClient(false) ? 'granted' : 'denied',
  }
}

export function openPrivacySettings(pane: 'screen' | 'accessibility'): Promise<void> {
  if (!isMac) return Promise.resolve()
  const anchor = pane === 'screen' ? 'Privacy_ScreenCapture' : 'Privacy_Accessibility'
  return shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${anchor}`)
}
