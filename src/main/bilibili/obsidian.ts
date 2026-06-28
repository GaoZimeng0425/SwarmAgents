// Renders an AI summary into an Obsidian "experience note" markdown file and
// writes it into the configured vault. Pure render/filename helpers are split
// from the fs write so they can be unit-tested without disk. Same-named notes
// are overwritten (latest summary wins).
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createLogger } from '@shared/logger'
import type { BiliSaveResult, BiliSummary, BiliVideo, ObsidianConfig } from '@shared/types/bilibili'

const log = createLogger({ process: 'main' }).child({ component: 'bilibili-obsidian' })

function fmtDuration(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

// Replace characters illegal in file names (and path separators) with a space,
// trim, cap length; fall back to the bvid if nothing remains.
export function noteFilename(title: string, bvid: string): string {
  const safe = title
    .replace(/[/\\:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
  return `${safe || bvid}-${bvid}.md`
}

export function renderNote(video: BiliVideo, summary: BiliSummary, processed: string): string {
  const q = (s: string): string => `"${s.replace(/"/g, '\\"')}"`
  const url = `https://www.bilibili.com/video/${video.bvid}`
  const lines: string[] = [
    '---',
    `title: ${q(video.title)}`,
    `bvid: ${video.bvid}`,
    `url: ${url}`,
    `author: ${q(video.author)}`,
    `duration: ${fmtDuration(video.durationSec)}`,
    `source: ${q(video.source)}`,
    `processed: ${processed}`,
    'tags: [bilibili]',
    '---',
    '',
    '## 一句话主旨',
    '',
    summary.gist,
  ]
  const bulleted = (heading: string, items: string[]): void => {
    if (items.length === 0) return
    lines.push('', `## ${heading}`, '')
    for (const it of items) lines.push(`- ${it}`)
  }
  bulleted('核心要点', summary.points)
  bulleted('可复用经验 / 方法论', summary.experience)
  bulleted('踩坑 / 注意', summary.pitfalls)
  if (summary.steps.length > 0) {
    lines.push('', '## 可执行步骤', '')
    summary.steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`))
  }
  lines.push('', '## 原视频', '', `[${video.title}](${url})`)
  return `${lines.join('\n')}\n`
}

export async function writeNote(
  cfg: ObsidianConfig | null,
  video: BiliVideo,
  summary: BiliSummary,
  processed: string
): Promise<BiliSaveResult> {
  if (!cfg || !cfg.vaultPath) {
    log.warn({ msg: 'save requested but no vault configured', bvid: video.bvid })
    return { ok: false, code: 'no_vault', message: '未配置 Obsidian 库路径，请在设置中配置。' }
  }
  const dir = cfg.subdir ? join(cfg.vaultPath, cfg.subdir) : cfg.vaultPath
  const path = join(dir, noteFilename(video.title, video.bvid))
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(path, renderNote(video, summary, processed), 'utf8')
    log.info({ msg: 'note written', bvid: video.bvid, path })
    return { ok: true, path }
  } catch (err) {
    log.error({ msg: 'note write failed', bvid: video.bvid, err: err instanceof Error ? err.message : String(err) })
    return { ok: false, code: 'write_failed', message: `写入失败：${err instanceof Error ? err.message : String(err)}` }
  }
}
