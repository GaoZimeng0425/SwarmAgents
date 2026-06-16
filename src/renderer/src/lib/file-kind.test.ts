import { describe, expect, it } from 'vitest'

import { ATTACHMENT_ACCEPT, DOCUMENT_ACCEPT, fileKind } from './file-kind'

describe('fileKind', () => {
  it('classifies the supported document types', () => {
    expect(fileKind('application/pdf')).toBe('pdf')
    expect(fileKind('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe('xlsx')
    expect(fileKind('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe('docx')
    expect(fileKind('text/csv')).toBe('csv')
  })

  it('classifies images', () => {
    expect(fileKind('image/png')).toBe('image')
    expect(fileKind('image/jpeg')).toBe('image')
  })

  it('falls back to "other" for unknown types', () => {
    expect(fileKind('text/plain')).toBe('other')
    expect(fileKind(undefined)).toBe('other')
  })

  it('exposes an accept string covering images + the four doc types', () => {
    expect(ATTACHMENT_ACCEPT).toContain('image/*')
    expect(ATTACHMENT_ACCEPT).toContain('application/pdf')
    expect(ATTACHMENT_ACCEPT).toContain('text/csv')
    expect(ATTACHMENT_ACCEPT).toContain('spreadsheetml.sheet')
    expect(ATTACHMENT_ACCEPT).toContain('wordprocessingml.document')
  })

  it('document accept covers the four doc types but excludes images', () => {
    expect(DOCUMENT_ACCEPT).not.toContain('image')
    expect(DOCUMENT_ACCEPT).toContain('application/pdf')
    expect(DOCUMENT_ACCEPT).toContain('text/csv')
    expect(DOCUMENT_ACCEPT).toContain('spreadsheetml.sheet')
    expect(DOCUMENT_ACCEPT).toContain('wordprocessingml.document')
  })
})
