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

  useEffect(() => {
    void swarmApi.bilibiliGetObsidianConfig().then((cfg) => {
      if (cfg) {
        setVaultPath(cfg.vaultPath)
        setSubdir(cfg.subdir)
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
    </div>
  )
}
