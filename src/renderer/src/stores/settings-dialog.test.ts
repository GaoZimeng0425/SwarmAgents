import { beforeEach, describe, expect, it } from 'vitest'

import { routeToSection, useSettingsDialog } from './settings-dialog'

beforeEach(() => {
  useSettingsDialog.setState({ open: false, section: 'general' })
})

describe('useSettingsDialog', () => {
  it('opens with default general section', () => {
    useSettingsDialog.getState().openSettings()
    expect(useSettingsDialog.getState().open).toBe(true)
    expect(useSettingsDialog.getState().section).toBe('general')
  })

  it('opens at a specific section', () => {
    useSettingsDialog.getState().openSettings('mcp')
    expect(useSettingsDialog.getState().section).toBe('mcp')
  })

  it('close() resets open to false', () => {
    useSettingsDialog.getState().openSettings('about')
    useSettingsDialog.getState().close()
    expect(useSettingsDialog.getState().open).toBe(false)
  })
})

describe('routeToSection', () => {
  it('maps /settings to general', () => {
    expect(routeToSection('/settings')).toBe('general')
    expect(routeToSection('/settings/')).toBe('general')
  })
  it('maps known sub-routes to their section', () => {
    expect(routeToSection('/settings/mcp')).toBe('mcp')
    expect(routeToSection('/settings/web-search')).toBe('web-search')
    expect(routeToSection('/settings/permissions')).toBe('permissions')
  })
  it('falls back to general for unknown routes', () => {
    expect(routeToSection('/settings/nope')).toBe('general')
  })
})
