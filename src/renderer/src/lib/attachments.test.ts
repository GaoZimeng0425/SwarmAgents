import { describe, expect, it } from 'vitest'

import { imageAttachmentsFrom } from './attachments'

describe('imageAttachmentsFrom', () => {
  it('parses image data URLs into Attachments', () => {
    const out = imageAttachmentsFrom([
      { type: 'file', mediaType: 'image/png', filename: 'a.png', url: 'data:image/png;base64,AAAB' },
    ])
    expect(out).toEqual([{ data: 'AAAB', mimeType: 'image/png', name: 'a.png' }])
  })

  it('skips non-image files', () => {
    const out = imageAttachmentsFrom([{ type: 'file', mediaType: 'text/plain', url: 'data:text/plain;base64,AAAB' }])
    expect(out).toEqual([])
  })

  it('skips files without a base64 data URL', () => {
    const out = imageAttachmentsFrom([{ type: 'file', mediaType: 'image/png', url: 'https://example.com/a.png' }])
    expect(out).toEqual([])
  })
})
