// Orchestrates one video: subtitle text -> trigger analysis. Each stage logs
// entry/outcome with the bvid so a failure is locatable from the log alone.
// The analysis itself runs async in the service process; this pipeline only
// fetches the subtitle and triggers the agent (sync ack). The structured
// summary streams back via bilibili.analysis* events.
import { createLogger } from '@shared/logger'
import type { BiliAnalysisSource, BiliCredentials, BiliProcessResult, ProviderInjection } from '@swarm/protocol'

const log = createLogger({ process: 'main' }).child({ component: 'bilibili-pipeline' })

export type PipelineDeps = {
  getInjection: () => ProviderInjection | null
  getMeta: (bvid: string) => { title: string; author: string } | null
  getSubtitleText: (c: BiliCredentials, bvid: string) => Promise<string | null>
  triggerAnalyze: (
    inj: ProviderInjection,
    input: { bvid: string; title: string; author: string; text: string; source: BiliAnalysisSource }
  ) => Promise<void>
}

export async function processVideo(deps: PipelineDeps, c: BiliCredentials, bvid: string): Promise<BiliProcessResult> {
  const started = Date.now()
  log.info({ msg: 'process started', bvid })
  const inj = deps.getInjection()
  if (!inj) {
    log.warn({ msg: 'process no provider', bvid })
    return { ok: false, code: 'no_provider', message: '未配置 AI Provider，请在设置中添加。' }
  }
  let text: string | null
  try {
    text = await deps.getSubtitleText(c, bvid)
  } catch (err) {
    log.error({ msg: 'subtitle stage failed', bvid, err: err instanceof Error ? err.message : String(err) })
    return { ok: false, code: 'unknown', message: '获取字幕失败' }
  }
  if (text === null) {
    log.warn({ msg: 'process no subtitle', bvid })
    return { ok: false, code: 'no_subtitle', message: '该视频没有字幕，暂不支持（语音转写为后续里程碑）。' }
  }
  const meta = deps.getMeta(bvid) ?? { title: '', author: '' }
  const source: BiliAnalysisSource = 'subtitle'
  try {
    await deps.triggerAnalyze(inj, { bvid, ...meta, text, source })
    log.info({ msg: 'process ok', bvid, durationMs: Date.now() - started })
    return { ok: true, text, source }
  } catch (err) {
    log.error({ msg: 'analyze trigger failed', bvid, err: err instanceof Error ? err.message : String(err) })
    return { ok: false, code: 'llm_failed', message: 'AI 总结失败，请稍后重试。' }
  }
}
