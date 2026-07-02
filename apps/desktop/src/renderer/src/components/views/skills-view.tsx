import { useState } from 'react'
import { FolderInput, FolderOpen, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@swarm/ui'
import { Switch } from '@swarm/ui'
import { useSkills } from '@/hooks/use-skills'
import { cn } from '@/lib/utils'
import { SettingsHeader } from './settings-primitives'

export function SkillsView(): React.JSX.Element {
  const { skills, setSkills, reload } = useSkills()
  const [expanded, setExpanded] = useState<string | null>(null)

  const toggle = async (name: string, enabled: boolean): Promise<void> => {
    await window.swarm.toolToggles.setSkillEnabled(name, enabled)
    reload()
  }

  const remove = async (name: string): Promise<void> => {
    const r = await window.swarm.skills.remove(name)
    if (!r.ok) {
      toast.error(r.message)
      return
    }
    setSkills(r.skills)
    setExpanded((cur) => (cur === name ? null : cur))
  }

  const runImport = async (arg?: { sourceDir?: string; overwrite?: boolean }): Promise<void> => {
    const r = await window.swarm.skills.importFolder(arg)
    if (r.ok) {
      setSkills(r.skills)
      toast.success('Skill imported')
      return
    }
    if (r.code === 'cancelled') return
    if (r.code === 'exists' && r.sourceDir) {
      if (window.confirm(`${r.message} Overwrite it?`)) {
        await runImport({ sourceDir: r.sourceDir, overwrite: true })
      }
      return
    }
    toast.error(r.message)
  }

  return (
    <div className="space-y-4">
      <SettingsHeader
        description={
          <>
            Reusable instruction folders. Import a folder containing a{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">SKILL.md</code> plus any scripts or resources. The
            agent sees each skill's name + description and loads the full body on demand via the{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">use_skill</code> tool.
          </>
        }
        title="Skills"
      />

      {/* Toolbar: actions live on their own row below the header, not crammed
          beside the title. */}
      <div className="flex justify-end gap-2">
        <Button className="gap-1.5" onClick={() => void window.swarm.openUserDataDir()} variant="outline">
          <FolderOpen className="size-4" />
          Open data folder
        </Button>
        <Button className="gap-1.5" onClick={() => void runImport()}>
          <FolderInput className="size-4" />
          Import skill folder
        </Button>
      </div>

      {skills.length === 0 ? (
        <p className="text-muted-foreground text-sm">No skills yet. Import one above.</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {skills.map((s) => {
            const isOpen = expanded === s.name
            return (
              // The open card spans the full row so its body has room; collapsed
              // cards stay uniform-height (description clamped to two lines).
              <div
                className={cn('rounded-xl border bg-card p-4', isOpen && 'sm:col-span-2 lg:col-span-3')}
                key={s.name}
              >
                <div className="flex items-start gap-3">
                  <button
                    className="min-w-0 flex-1 text-left"
                    onClick={() => setExpanded(isOpen ? null : s.name)}
                    type="button"
                  >
                    <p className={cn('truncate font-medium text-sm', s.enabled === false && 'text-muted-foreground')}>
                      {s.name}
                    </p>
                    <p className={cn('text-muted-foreground text-sm', !isOpen && 'line-clamp-2')}>{s.description}</p>
                  </button>
                  <Switch
                    aria-label={`${s.enabled === false ? 'Enable' : 'Disable'} ${s.name}`}
                    checked={s.enabled !== false}
                    className="mt-0.5"
                    onCheckedChange={(v) => void toggle(s.name, v)}
                  />
                  <Button
                    aria-label="Delete skill"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => void remove(s.name)}
                    size="icon"
                    variant="ghost"
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
                {isOpen && (
                  <div className="mt-3 flex flex-col gap-3 border-t pt-3">
                    {s.files && s.files.length > 0 && (
                      <div>
                        <p className="mb-1 font-medium text-muted-foreground text-xs">Files</p>
                        <ul className="font-mono text-xs">
                          {s.files.map((f) => (
                            <li className="text-muted-foreground" key={f}>
                              {f}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {s.body && (
                      <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-muted p-3 font-mono text-xs">
                        {s.body}
                      </pre>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
