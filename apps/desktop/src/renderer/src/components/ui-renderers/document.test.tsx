// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { base64ToBlob, DocumentCard } from './document'

// pdf-thumbnail-utils pulls in the pdfium wasm + worker engine — too heavy for happy-dom.
vi.mock('@/components/pdf-thumbnail-utils', () => ({
  renderPdfThumbnailUrl: vi.fn(() => Promise.resolve('blob:thumb')),
}))

const readDocumentFile = vi.fn<(path: string) => Promise<{ mediaType: string; data: string } | null>>()

beforeEach(() => {
  readDocumentFile.mockReset()
  ;(globalThis as unknown as { window: Window }).window.swarm = {
    readDocumentFile,
  } as unknown as Window['swarm']
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('base64ToBlob', () => {
  it('decodes base64 into a typed Blob', async () => {
    // 'AAEC' → bytes 0x00 0x01 0x02
    const blob = base64ToBlob('AAEC', 'application/pdf')
    expect(blob.type).toBe('application/pdf')
    const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()))
    expect(bytes).toEqual([0, 1, 2])
  })
})

describe('DocumentCard', () => {
  it('shows the filename and opens the file on click', async () => {
    readDocumentFile.mockResolvedValueOnce({ mediaType: 'application/pdf', data: 'AAEC' })
    const onOpenFile = vi.fn()

    render(<DocumentCard onOpenFile={onOpenFile} props={{ path: '/abs/report.pdf', name: 'report.pdf' }} />)

    const btn = await screen.findByRole('button', { name: /report\.pdf/ })
    await waitFor(() => expect(btn).not.toBeDisabled())
    fireEvent.click(btn)

    expect(onOpenFile).toHaveBeenCalledWith({
      url: 'blob:mock',
      mediaType: 'application/pdf',
      filename: 'report.pdf',
    })
  })

  it('shows an error state and keeps the name when the file cannot be read', async () => {
    readDocumentFile.mockResolvedValueOnce(null)

    render(<DocumentCard props={{ path: '/missing.pdf' }} />)

    await waitFor(() => expect(screen.getByText('Unable to preview')).toBeInTheDocument())
    expect(screen.getByText('missing.pdf')).toBeInTheDocument()
  })
})
