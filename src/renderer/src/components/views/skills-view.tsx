import { useState } from 'react'
import { FolderInput, FolderOpen, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { useSkills } from '@/hooks/use-skills'
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
        action={
          <div className="flex shrink-0 gap-2">
            <Button className="gap-1.5" onClick={() => void window.swarm.openUserDataDir()} variant="outline">
              <FolderOpen className="size-4" />
              Open data folder
            </Button>
            <Button className="gap-1.5" onClick={() => void runImport()}>
              <FolderInput className="size-4" />
              Import skill folder
            </Button>
          </div>
        }
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

      {skills.length === 0 ? (
        <p className="text-muted-foreground text-sm">No skills yet. Import one above.</p>
      ) : (
        skills.map((s) => (
          <div className="rounded-xl border bg-card p-4" key={s.name}>
            <div className="flex items-start gap-3">
              <button
                className="min-w-0 flex-1 text-left"
                onClick={() => setExpanded(expanded === s.name ? null : s.name)}
                type="button"
              >
                <p className={`truncate font-medium text-sm ${s.enabled === false ? 'text-muted-foreground' : ''}`}>
                  {s.name}
                </p>
                <p className="text-muted-foreground text-sm">{s.description}</p>
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
            {expanded === s.name && (
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
        ))
      )}
    </div>
  )
}
