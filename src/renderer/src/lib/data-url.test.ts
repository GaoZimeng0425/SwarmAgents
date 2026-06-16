import { describe, expect, it } from 'vitest'

import { dataUrlToBlob } from './data-url'

describe('dataUrlToBlob', () => {
  it('decodes a base64 data URL into a Blob with the right type and bytes', async () => {
    // "Hi" -> base64 "SGk="
    const blob = dataUrlToBlob('data:text/csv;base64,SGk=')
    expect(blob.type).toBe('text/csv')
    expect(await blob.text()).toBe('Hi')
  })

  it('throws on a non-base64 data URL', () => {
    expect(() => dataUrlToBlob('https://example.com/a.pdf')).toThrow()
  })
})
