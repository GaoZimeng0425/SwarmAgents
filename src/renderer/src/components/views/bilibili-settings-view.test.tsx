// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { swarmApi } from '@/lib/api'
import { BilibiliSettingsView } from './bilibili-settings-view'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('BilibiliSettingsView', () => {
  it('loads the existing vault path and saves a newly picked folder', async () => {
    vi.spyOn(swarmApi, 'bilibiliGetObsidianConfig').mockResolvedValue({ vaultPath: '/old/vault', subdir: 'bili' })
    vi.spyOn(swarmApi, 'bilibiliPickVault').mockResolvedValue('/new/vault')
    const set = vi.spyOn(swarmApi, 'bilibiliSetObsidianConfig').mockResolvedValue(undefined)
    render(<BilibiliSettingsView />)
    expect(await screen.findByDisplayValue('/old/vault')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /选择文件夹/ }))
    await waitFor(() => expect(set).toHaveBeenCalledWith({ vaultPath: '/new/vault', subdir: 'bili' }))
  })
})
