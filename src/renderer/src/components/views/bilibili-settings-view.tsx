import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { swarmApi } from '@/lib/api'
import { Section, SettingsHeader } from './settings-primitives'

// Lets the user pick the Obsidian vault folder and a subdirectory the AI summary
// notes are written into. Reads/writes through swarmApi so the view is testable.
export function BilibiliSettingsView(): React.JSX.Element {
  const [vaultPath, setVaultPath] = useState('')
  const [subdir, setSubdir] = useState('')
  const [ffmpegPath, setFfmpegPath] = useState('')
  const [modelDir, setModelDir] = useState('')

  useEffect(() => {
    void swarmApi.bilibiliGetObsidianConfig().then((cfg) => {
      if (cfg) {
        setVaultPath(cfg.vaultPath)
        setSubdir(cfg.subdir)
      }
    })
    void swarmApi.bilibiliGetTranscribeConfig().then((cfg) => {
      if (cfg) {
        setFfmpegPath(cfg.ffmpegPath)
        setModelDir(cfg.modelDir)
      }
    })
  }, [])

  const pick = async (): Promise<void> => {
    const picked = await swarmApi.bilibiliPickVault()
    if (!picked) return
    setVaultPath(picked)
    await swarmApi.bilibiliSetObsidianConfig({ vaultPath: picked, subdir })
  }

  const saveSubdir = async (): Promise<void> => {
    if (!vaultPath) return
    await swarmApi.bilibiliSetObsidianConfig({ vaultPath, subdir })
  }

  const pickModel = async (): Promise<void> => {
    const picked = await swarmApi.bilibiliPickModelDir()
    if (!picked) return
    setModelDir(picked)
  }

  const saveTranscribe = async (): Promise<void> => {
    await swarmApi.bilibiliSetTranscribeConfig({ ffmpegPath, modelDir })
  }

  return (
    <div className="space-y-5">
      <SettingsHeader description="AI 总结生成的笔记会写入这个 Obsidian 库。" title="Bilibili" />
      <Section label="Obsidian 库路径">
        <div className="flex items-center gap-2">
          <Input className="flex-1" placeholder="尚未选择" readOnly value={vaultPath} />
          <Button onClick={() => void pick()} variant="outline">
            选择文件夹
          </Button>
        </div>
      </Section>
      <Section label="子目录（可选）">
        <Input
          onBlur={() => void saveSubdir()}
          onChange={(e) => setSubdir(e.target.value)}
          placeholder="例如 bilibili"
          value={subdir}
        />
      </Section>
      <SettingsHeader
        description="无字幕视频可下载音轨本地转写。需自行安装 ffmpeg，并下载 SenseVoice 模型后填写其所在目录。"
        title="本地转写 (ASR)"
      />
      <Section label="ffmpeg 路径">
        <Input
          onChange={(e) => setFfmpegPath(e.target.value)}
          placeholder="例如 /opt/homebrew/bin/ffmpeg 或 ffmpeg"
          value={ffmpegPath}
        />
      </Section>
      <Section label="模型目录">
        <div className="flex items-center gap-2">
          <Input className="flex-1" placeholder="尚未选择" readOnly value={modelDir} />
          <Button onClick={() => void pickModel()} variant="outline">
            选择目录
          </Button>
        </div>
      </Section>
      <Button className="w-fit" onClick={() => void saveTranscribe()} variant="outline">
        保存转写配置
      </Button>
    </div>
  )
}
