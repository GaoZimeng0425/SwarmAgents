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
    vi.spyOn(swarmApi, 'bilibiliGetTranscribeConfig').mockResolvedValue(null)
    vi.spyOn(swarmApi, 'bilibiliPickVault').mockResolvedValue('/new/vault')
    const set = vi.spyOn(swarmApi, 'bilibiliSetObsidianConfig').mockResolvedValue(undefined)
    render(<BilibiliSettingsView />)
    expect(await screen.findByDisplayValue('/old/vault')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /选择文件夹/ }))
    await waitFor(() => expect(set).toHaveBeenCalledWith({ vaultPath: '/new/vault', subdir: 'bili' }))
  })

  it('saves the transcription config (ffmpeg path + picked model dir)', async () => {
    vi.spyOn(swarmApi, 'bilibiliGetObsidianConfig').mockResolvedValue(null)
    vi.spyOn(swarmApi, 'bilibiliGetTranscribeConfig').mockResolvedValue(null)
    vi.spyOn(swarmApi, 'bilibiliPickModelDir').mockResolvedValue('/models/sv')
    const set = vi.spyOn(swarmApi, 'bilibiliSetTranscribeConfig').mockResolvedValue(undefined)
    render(<BilibiliSettingsView />)

    const ffmpeg = await screen.findByPlaceholderText(/ffmpeg/)
    fireEvent.change(ffmpeg, { target: { value: '/usr/bin/ffmpeg' } })
    fireEvent.click(screen.getByRole('button', { name: /选择目录/ }))
    await screen.findByDisplayValue('/models/sv')
    fireEvent.click(screen.getByRole('button', { name: /保存转写配置/ }))
    await waitFor(() => expect(set).toHaveBeenCalledWith({ ffmpegPath: '/usr/bin/ffmpeg', modelDir: '/models/sv' }))
  })
})
