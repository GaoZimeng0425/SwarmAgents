import { describe, expect, it } from 'vitest'

import { buildPeekabooTools, clickArgs, hotkeyArgs, scrollArgs, typeArgs } from './peekaboo'

describe('peekaboo tools', () => {
  it('exposes see_screen and list_apps with TypeBox schemas', () => {
    const tools = buildPeekabooTools({
      requestPermission: async () => 'grant',
    })

    const see = tools.find((t) => t.name === 'see_screen')
    expect(see?.label).toBeDefined()
    expect(see?.description).toMatch(/screen|UI/i)
    expect(see?.parameters).toBeDefined()
    // TypeBox object schemas expose `properties` on the JSON schema.
    expect((see?.parameters as { properties?: unknown }).properties).toBeDefined()
  })

  it('exposes the interaction tools alongside the read-only ones', () => {
    const tools = buildPeekabooTools({ requestPermission: async () => 'grant' })
    expect(tools.map((t) => t.name).sort()).toEqual(['click', 'hotkey', 'list_apps', 'scroll', 'see_screen', 'type'])
  })
})

describe('clickArgs', () => {
  it('prefers element id, then coords, then query', () => {
    expect(clickArgs({ id: 'B1' })).toEqual(['click', '--on', 'B1'])
    expect(clickArgs({ coords: '10,20' })).toEqual(['click', '--coords', '10,20'])
    expect(clickArgs({ query: 'Save' })).toEqual(['click', 'Save'])
    expect(clickArgs({ id: 'B1', query: 'Save' })).toEqual(['click', '--on', 'B1'])
  })
  it('appends double and right flags', () => {
    expect(clickArgs({ id: 'B1', double: true, right: true })).toEqual(['click', '--on', 'B1', '--double', '--right'])
  })
  it('throws when no target is given', () => {
    expect(() => clickArgs({})).toThrow(/id|coords|query/i)
  })
})

describe('typeArgs', () => {
  it('passes text positionally and maps flags', () => {
    expect(typeArgs({ text: 'hello' })).toEqual(['type', 'hello'])
    expect(typeArgs({ text: 'hi', clear: true, pressReturn: true })).toEqual(['type', 'hi', '--clear', '--return'])
  })
  it('throws on empty text', () => {
    expect(() => typeArgs({ text: '' })).toThrow(/text/i)
  })
})

describe('scrollArgs', () => {
  it('defaults amount to 3 and supports a target element', () => {
    expect(scrollArgs({ direction: 'down' })).toEqual(['scroll', '--direction', 'down', '--amount', '3'])
    expect(scrollArgs({ direction: 'up', amount: 5, id: 'T2' })).toEqual([
      'scroll',
      '--direction',
      'up',
      '--amount',
      '5',
      '--on',
      'T2',
    ])
  })
  it('rejects an invalid direction', () => {
    expect(() => scrollArgs({ direction: 'sideways' as never })).toThrow(/direction/i)
  })
})

describe('hotkeyArgs', () => {
  it('maps keys to --keys', () => {
    expect(hotkeyArgs({ keys: 'cmd,c' })).toEqual(['hotkey', '--keys', 'cmd,c'])
  })
  it('throws without keys', () => {
    expect(() => hotkeyArgs({ keys: '' })).toThrow(/keys/i)
  })
})
