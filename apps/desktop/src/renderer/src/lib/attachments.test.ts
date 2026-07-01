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

  it('never carries document attachments to the agent (view-only)', () => {
    const docs = [
      { type: 'file', mediaType: 'application/pdf', filename: 'a.pdf', url: 'data:application/pdf;base64,AAAB' },
      {
        type: 'file',
        mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        filename: 'a.xlsx',
        url: 'data:application/octet-stream;base64,AAAB',
      },
      {
        type: 'file',
        mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        filename: 'a.docx',
        url: 'data:application/octet-stream;base64,AAAB',
      },
      { type: 'file', mediaType: 'text/csv', filename: 'a.csv', url: 'data:text/csv;base64,AAAB' },
    ]
    expect(imageAttachmentsFrom(docs)).toEqual([])
  })
})
