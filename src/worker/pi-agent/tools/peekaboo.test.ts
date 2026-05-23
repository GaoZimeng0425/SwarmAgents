import { describe, expect, it } from 'vitest'

import { buildPeekabooTools } from './peekaboo'

describe('peekaboo tools (pi)', () => {
  it('exposes see_screen and list_apps with TypeBox schemas', () => {
    const tools = buildPeekabooTools({
      send: () => {},
      requestPermission: async () => 'grant',
    })

    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual(['list_apps', 'see_screen'])

    const see = tools.find((t) => t.name === 'see_screen')
    expect(see?.label).toBeDefined()
    expect(see?.description).toMatch(/screen|UI/i)
    expect(see?.parameters).toBeDefined()
    // TypeBox object schemas expose `properties` on the JSON schema.
    expect((see?.parameters as { properties?: unknown }).properties).toBeDefined()
  })
})
