// apps/desktop/src/renderer/src/lib/palette/build-items.ts
// Pure aggregator: turns raw renderer data into a flat PaletteItem[] for one scope.
import type { PaletteItem, PaletteScope } from './types'

/** Raw data the builder needs. Gathered by hooks/use-palette-data.ts. */
export type BuildInputs = {
  /** Active session in the composer/preview; null when none is selected. */
  currentSessionId: string | null
  /** Non-system sessions (the 「对话」 group). */
  sessions: { id: string; title: string | null; lastActiveAt: number; agentType?: string }[]
  /** Running or pending runs. */
  runningRuns: {
    id: string
    sessionId: string
    goal: string
    status: string
    summary: string | null
    plan?: { content: string; status: 'pending' | 'in_progress' | 'completed' }[]
  }[]
  /** Scheduled (cron) tasks. */
  cronJobs: {
    id: string
    sessionId: string
    name: string | null
    cron: string
    nextRun: number | null
    lastRun: number | null
    lastStatus: string | null
  }[]
  /** Formation/team options for the dispatch picker. */
  formations: { id: string; label: string }[]
  /** Artifacts for the `/` scope. */
  artifacts: { kind: 'file' | 'bilibili-analysis'; name: string; ref: string; origin: string; modifiedAt?: number }[]
  /** Memory entries. */
  memory: { id: string; key: string; namespace: string; category: string; content: string; timestamp: number }[]
  /** Skills. */
  skills: { name: string; description: string; enabled?: boolean }[]
  /** Service routes for mixed "快捷入口". `detail` is a live count line (e.g. "214 个视频 · 已解析 86"); falls back to the route when absent. */
  services: { id: string; label: string; route: string; detail?: string }[]
}

/** Side-effect callbacks the builder wires into each item's `run`. */
export type Callbacks = {
  navigate: (to: string) => void
  openSettings: (section?: string) => void
  cycleTheme: () => void
  exportMarkdown: (sessionId: string) => void
  setComposerAgent: (agentId: string) => void
  openArtifact: (ref: string) => void
  /** Submit the hero dispatch; returns the new session id for navigation. */
  submitGoal: (goal: string, agentType: string) => Promise<{ sessionId: string }>
  /**
   * Currently picked dispatch formation (lifted in usePaletteState). Optional so
   * pure tests can omit it; heroItem falls back to DEFAULT_FORMATION when unset.
   * Including it here lets usePaletteState rebuild `cb` (via a merged memo) when
   * the picker changes, so the dispatch item's run() captures the latest pick.
   */
  pickedFormation?: string
}

/** Default formation used when the user submits the hero dispatch as-is. */
const DEFAULT_FORMATION = 'ceo'

/**
 * Case-insensitive substring matcher. `term` MUST already be trimmed +
 * lowercased by the caller (we normalize once at the top of `buildItems`).
 * Empty term matches everything.
 */
const matches = (term: string, text: string): boolean => {
  if (!term) return true
  return text.toLowerCase().includes(term)
}

// --- Per-kind builders -------------------------------------------------------

/** Built-in commands surfaced in the `>` scope and the mixed default row. */
function commandItems(inputs: BuildInputs, cb: Callbacks): PaletteItem[] {
  return [
    {
      id: 'cmd:new-chat',
      kind: 'command',
      title: '新建对话',
      icon: 'Plus',
      run: () => cb.navigate('/'),
      searchText: '新建对话 new chat',
      preview: { type: 'info', title: '新建对话', desc: '开启一个新的对话', rows: [] },
    },
    {
      id: 'cmd:new-scheduled',
      kind: 'command',
      title: '新建定时任务',
      icon: 'CalendarPlus',
      run: () => cb.navigate('/scheduled'),
      searchText: '新建定时任务 scheduled cron',
      preview: { type: 'info', title: '新建定时任务', desc: '创建一个按计划执行的任务', rows: [] },
    },
    {
      id: 'cmd:new-formation',
      kind: 'command',
      title: '新建编队',
      icon: 'UsersRound',
      run: () => cb.navigate('/formations'),
      searchText: '新建编队 formation agent',
      preview: { type: 'info', title: '新建编队', desc: '创建新的 Agent 编队', rows: [] },
    },
    {
      id: 'cmd:open-settings',
      kind: 'command',
      title: '打开设置',
      icon: 'Settings',
      run: () => cb.openSettings(),
      searchText: '打开设置 settings',
      preview: { type: 'info', title: '打开设置', desc: '打开应用设置面板', rows: [] },
    },
    {
      id: 'cmd:cycle-theme',
      kind: 'command',
      title: '切换外观',
      icon: 'Palette',
      run: () => cb.cycleTheme(),
      searchText: '切换外观 theme appearance',
      preview: { type: 'info', title: '切换外观', desc: '在浅色 / 深色之间切换', rows: [] },
    },
    {
      id: 'cmd:export-markdown',
      kind: 'command',
      title: '导出当前对话为 Markdown',
      icon: 'Download',
      run: () => cb.exportMarkdown(inputs.currentSessionId!),
      searchText: '导出当前对话为 markdown export',
      preview: { type: 'info', title: '导出当前对话为 Markdown', desc: '将当前对话导出为 .md 文件', rows: [] },
    },
  ]
}

function agentItems(formations: BuildInputs['formations'], cb: Callbacks): PaletteItem[] {
  return formations.map((f) => ({
    id: `agent:${f.id}`,
    kind: 'agent',
    title: f.label,
    icon: 'Users',
    run: () => {
      cb.setComposerAgent(f.id)
      cb.navigate('/')
    },
    searchText: `${f.label} ${f.id}`,
    preview: { type: 'info', title: f.label, rows: [{ label: '编队 ID', value: f.id }] },
  }))
}

function chatItems(sessions: BuildInputs['sessions'], cb: Callbacks): PaletteItem[] {
  return sessions.map((s) => ({
    id: `chat:${s.id}`,
    kind: 'chat',
    title: s.title ?? '未命名对话',
    subtitle: s.agentType ?? undefined,
    icon: 'MessageSquare',
    run: () => cb.navigate(`/session/${s.id}`),
    searchText: `${s.title ?? ''} ${s.agentType ?? ''}`,
    preview: { type: 'chat', sessionId: s.id, title: s.title ?? '未命名对话' },
  }))
}

function taskRunItems(runs: BuildInputs['runningRuns'], cb: Callbacks): PaletteItem[] {
  return runs.map((r) => {
    const plan = r.plan ?? []
    const done = plan.filter((p) => p.status === 'completed').length
    const progress = plan.length ? done / plan.length : undefined
    return {
      id: `run:${r.id}`,
      kind: 'taskRun',
      title: r.goal,
      subtitle: r.summary ?? undefined,
      badge: r.status,
      progress,
      icon: 'LoaderCircle',
      run: () => cb.navigate(`/session/${r.sessionId}`),
      searchText: `${r.goal} ${r.summary ?? ''} ${r.status}`,
      preview: {
        type: 'taskRun',
        run: { id: r.id, goal: r.goal, summary: r.summary, status: r.status, plan: r.plan },
        sessionId: r.sessionId,
      },
    }
  })
}

function taskSchedItems(jobs: BuildInputs['cronJobs'], cb: Callbacks): PaletteItem[] {
  return jobs.map((j) => ({
    id: `cron:${j.id}`,
    kind: 'taskSched',
    title: j.name ?? j.cron,
    subtitle: j.cron,
    badge: j.lastStatus ?? undefined,
    icon: 'CalendarClock',
    run: () => cb.navigate('/scheduled'),
    searchText: `${j.name ?? ''} ${j.cron} ${j.lastStatus ?? ''}`,
    preview: {
      type: 'taskSched',
      task: {
        id: j.id,
        name: j.name,
        cron: j.cron,
        nextRun: j.nextRun,
        lastRun: j.lastRun,
        lastStatus: j.lastStatus,
        sessionId: j.sessionId,
      },
    },
  }))
}

function fileItems(artifacts: BuildInputs['artifacts'], cb: Callbacks): PaletteItem[] {
  return artifacts.map((a) => ({
    id: `file:${a.ref}`,
    kind: 'file',
    title: a.name,
    subtitle: a.origin,
    icon: a.kind === 'bilibili-analysis' ? 'PlayCircle' : 'FileText',
    run: () => cb.openArtifact(a.ref),
    searchText: `${a.name} ${a.origin} ${a.ref}`,
    preview: {
      type: 'info',
      title: a.name,
      rows: [
        { label: '来源', value: a.origin },
        { label: '引用', value: a.ref },
      ],
    },
  }))
}

function memoryItems(memory: BuildInputs['memory'], cb: Callbacks): PaletteItem[] {
  return memory.map((m) => ({
    id: `memory:${m.id}`,
    kind: 'memory',
    title: m.key,
    subtitle: m.category,
    icon: 'Brain',
    run: () => cb.openSettings('general'),
    searchText: `${m.key} ${m.category} ${m.content}`,
    preview: {
      type: 'info',
      title: m.key,
      desc: m.content,
      rows: [
        { label: '命名空间', value: m.namespace },
        { label: '分类', value: m.category },
      ],
    },
  }))
}

function skillItems(skills: BuildInputs['skills'], cb: Callbacks): PaletteItem[] {
  return skills.map((s) => ({
    id: `skill:${s.name}`,
    kind: 'skill',
    title: s.name,
    subtitle: s.description,
    badge: s.enabled === false ? '已禁用' : undefined,
    icon: 'Sparkles',
    run: () => cb.openSettings('skills'),
    searchText: `${s.name} ${s.description}`,
    preview: { type: 'info', title: s.name, desc: s.description, rows: [] },
  }))
}

/** Per-service lucide icon; falls back to the generic ArrowRight. */
const SERVICE_ICON: Record<string, string> = {
  bilibili: 'PlayCircle',
  gmail: 'Mail',
  scheduled: 'CalendarClock',
  trending: 'Flame',
}

function serviceItems(services: BuildInputs['services'], cb: Callbacks): PaletteItem[] {
  return services.map((sv) => ({
    id: `service:${sv.id}`,
    kind: 'service',
    title: sv.label,
    subtitle: sv.detail ?? sv.route,
    icon: SERVICE_ICON[sv.id] ?? 'ArrowRight',
    run: () => cb.navigate(sv.route),
    searchText: `${sv.label} ${sv.route} ${sv.detail ?? ''}`,
    preview: { type: 'info', title: sv.label, desc: sv.detail ?? sv.route, rows: [] },
  }))
}

/**
 * 「继续未完成」rows: the running / pending / awaiting_user runs, restyled as
 * resume cards. Reuses taskRunItems (progress + live-log preview) but rewrites
 * the title/subtitle to the design's 继续:… / 上次进行到 N%·点此继续 form.
 */
function resumeItems(runs: BuildInputs['runningRuns'], cb: Callbacks): PaletteItem[] {
  return taskRunItems(runs, cb).map((it) => {
    const pct = typeof it.progress === 'number' ? Math.round(it.progress * 100) : null
    return {
      ...it,
      title: `继续:${it.title}`,
      subtitle: pct != null ? `上次进行到 ${pct}%·点此继续` : '进行中·点此继续',
      icon: 'Sparkles',
    }
  })
}

/**
 * 「建议操作」rows: 新建对话 (⌘N) · 新建定时任务 · 研究编队. The first two reuse the
 * command builders (with the design's descriptions); 研究编队 dispatches a
 * research formation when one exists, else opens the formations page.
 */
function suggestionItems(inputs: BuildInputs, cb: Callbacks): PaletteItem[] {
  const cmds = commandItems(inputs, cb)
  const newChat: PaletteItem = {
    ...cmds.find((i) => i.id === 'cmd:new-chat')!,
    subtitle: '开始一个空白会话',
    shortcut: '⌘N',
  }
  const newSched: PaletteItem = {
    ...cmds.find((i) => i.id === 'cmd:new-scheduled')!,
    subtitle: '让 Agent 按计划自动执行',
  }
  const research = inputs.formations.find((f) => /research|研究|检索/i.test(`${f.id} ${f.label}`))
  const researchTeam: PaletteItem = {
    id: 'suggest:research-team',
    kind: research ? 'agent' : 'command',
    title: '研究编队',
    subtitle: '检索 · 阅读 · 归纳',
    icon: 'Users',
    run: () => {
      if (research) {
        cb.setComposerAgent(research.id)
        cb.navigate('/')
      } else {
        cb.navigate('/formations')
      }
    },
    searchText: '研究编队 research team 检索 阅读 归纳',
    preview: { type: 'info', title: '研究编队', desc: '检索 · 阅读 · 归纳', rows: [] },
  }
  return [newChat, newSched, researchTeam]
}

/** Tag every item with an explicit section heading for selectPalette (mixed scope). */
function withSection(items: PaletteItem[], section: string): PaletteItem[] {
  return items.map((i) => ({ ...i, section }))
}

/**
 * Hero dispatch item for the mixed scope. When `trimmed` is non-empty it
 * submits that goal; when empty it acts as a placeholder entry until the user
 * types. `trimmed` is the already-trimmed (but original-case) term, so
 * `submitGoal` never sees trailing spaces and the subtitle stays
 * human-readable.
 */
function heroItem(trimmed: string, inputs: BuildInputs, cb: Callbacks): PaletteItem {
  return {
    id: 'dispatch:hero',
    kind: 'dispatch',
    title: '把目标交给 Agent',
    subtitle: trimmed || undefined,
    icon: 'Rocket',
    run: async () => {
      // Empty-goal guard: in the mixed-empty state the hero is the default
      // selection (flat[0]), so a bare Enter must NOT submit a blank goal and
      // navigate to a dead new session. Only dispatch when there is a term.
      if (!trimmed) return
      const { sessionId } = await cb.submitGoal(trimmed, cb.pickedFormation ?? DEFAULT_FORMATION)
      cb.navigate(`/session/${sessionId}`)
    },
    searchText: '把目标交给 agent dispatch',
    preview: { type: 'dispatch', term: trimmed, formations: inputs.formations },
  }
}

/**
 * Mixed scope. Empty term shows the design's curated home (继续未完成 · 建议操作 ·
 * 最近对话 · 快捷入口, no hero row); non-empty term shows the dispatch hero first
 * then everything matching the term, grouped by search section.
 */
function mixedItems(t: string, trimmed: string, inputs: BuildInputs, cb: Callbacks): PaletteItem[] {
  // Empty-term home: four curated sections. No hero row — there is nothing to
  // dispatch until the user types, so a bare Enter runs the first real row
  // (a resume card, or the first suggestion when no runs are active).
  if (!t) {
    const recent = [...inputs.sessions].sort((a, b) => b.lastActiveAt - a.lastActiveAt).slice(0, 5)
    return [
      ...withSection(resumeItems(inputs.runningRuns, cb), '继续未完成'),
      ...withSection(suggestionItems(inputs, cb), '建议操作'),
      ...withSection(chatItems(recent, cb), '最近对话'),
      ...withSection(serviceItems(inputs.services, cb), '快捷入口'),
    ]
  }

  // With-query: hero always first, then everything that matches the term.
  const hero = { ...heroItem(trimmed, inputs, cb), section: '指派给 Agent' }
  const commands = withSection(
    commandItems(inputs, cb).filter((i) => matches(t, i.searchText)),
    '命令'
  )
  const chats = withSection(
    chatItems(inputs.sessions, cb).filter((i) => matches(t, i.searchText)),
    '对话'
  )
  const files = withSection(
    fileItems(inputs.artifacts, cb).filter((i) => matches(t, i.searchText)),
    '文件 & 产出'
  )
  const runs = withSection(
    taskRunItems(inputs.runningRuns, cb).filter((i) => matches(t, i.searchText)),
    '任务'
  )
  const crons = withSection(
    taskSchedItems(inputs.cronJobs, cb).filter((i) => matches(t, i.searchText)),
    '任务'
  )
  const memory = withSection(
    memoryItems(inputs.memory, cb).filter((i) => matches(t, i.searchText)),
    '记忆'
  )
  const skills = withSection(
    skillItems(inputs.skills, cb).filter((i) => matches(t, i.searchText)),
    '技能'
  )

  return [hero, ...commands, ...chats, ...files, ...runs, ...crons, ...memory, ...skills]
}

// --- Public entry ------------------------------------------------------------

/**
 * Build the flat PaletteItem[] for one scope, already filtered by `term`.
 * Pure: no React, no hooks, no I/O beyond the supplied callbacks' own bodies.
 */
export function buildItems(scope: PaletteScope, term: string, inputs: BuildInputs, cb: Callbacks): PaletteItem[] {
  // Normalize the term ONCE: trim, then lowercase. Everything downstream
  // (matches(), the empty-check in mixedItems, and the hero dispatch payload)
  // uses these two values, so leading/trailing whitespace is treated uniformly
  // rather than only in some code paths.
  const trimmed = term.trim()
  const t = trimmed.toLowerCase()
  switch (scope) {
    case 'command':
      return commandItems(inputs, cb).filter((i) => matches(t, i.searchText))
    case 'agent':
      return agentItems(inputs.formations, cb).filter((i) => matches(t, i.searchText))
    case 'task':
      return [...taskRunItems(inputs.runningRuns, cb), ...taskSchedItems(inputs.cronJobs, cb)].filter((i) =>
        matches(t, i.searchText)
      )
    case 'file':
      return fileItems(inputs.artifacts, cb).filter((i) => matches(t, i.searchText))
    case 'mixed':
      return mixedItems(t, trimmed, inputs, cb)
  }
}
