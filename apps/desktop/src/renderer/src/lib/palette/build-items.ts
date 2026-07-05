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
  /** Phase 3a artifacts for the `/` scope. */
  artifacts: { kind: 'file' | 'bilibili-analysis'; name: string; ref: string; origin: string; modifiedAt?: number }[]
  /** Memory entries. */
  memory: { id: string; key: string; namespace: string; category: string; content: string; timestamp: number }[]
  /** Skills. */
  skills: { name: string; description: string; enabled?: boolean }[]
  /** Service routes for mixed "快捷入口". */
  services: { id: string; label: string; route: string }[]
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
      run: () => cb.openSettings('agents'),
      searchText: '新建编队 formation agent',
      preview: { type: 'info', title: '新建编队', desc: '在设置中创建新的 Agent 编队', rows: [] },
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

function serviceItems(services: BuildInputs['services'], cb: Callbacks): PaletteItem[] {
  return services.map((sv) => ({
    id: `service:${sv.id}`,
    kind: 'service',
    title: sv.label,
    subtitle: sv.route,
    icon: 'ArrowRight',
    run: () => cb.navigate(sv.route),
    searchText: `${sv.label} ${sv.route}`,
    preview: { type: 'info', title: sv.label, desc: sv.route, rows: [] },
  }))
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

/** Mixed scope. Empty term shows a curated home row; non-empty term searches across sources. */
function mixedItems(t: string, trimmed: string, inputs: BuildInputs, cb: Callbacks): PaletteItem[] {
  const hero = heroItem(trimmed, inputs, cb)

  // Empty-term home: hero + new-chat command + top-3 recent chats + services.
  if (!t) {
    const recent = [...inputs.sessions].sort((a, b) => b.lastActiveAt - a.lastActiveAt).slice(0, 3)
    const newChat = commandItems(inputs, cb).find((i) => i.id === 'cmd:new-chat')!
    return [hero, newChat, ...chatItems(recent, cb), ...serviceItems(inputs.services, cb)]
  }

  // With-query: hero always first, then everything that matches the term.
  const commands = commandItems(inputs, cb).filter((i) => matches(t, i.searchText))
  const chats = chatItems(inputs.sessions, cb).filter((i) => matches(t, i.searchText))
  const files = fileItems(inputs.artifacts, cb).filter((i) => matches(t, i.searchText))
  const runs = taskRunItems(inputs.runningRuns, cb).filter((i) => matches(t, i.searchText))
  const crons = taskSchedItems(inputs.cronJobs, cb).filter((i) => matches(t, i.searchText))
  const memory = memoryItems(inputs.memory, cb).filter((i) => matches(t, i.searchText))
  const skills = skillItems(inputs.skills, cb).filter((i) => matches(t, i.searchText))

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
