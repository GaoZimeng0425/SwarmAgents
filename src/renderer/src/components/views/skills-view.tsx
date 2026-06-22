import { useState } from 'react'
import { FolderInput, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { useSkills } from '@/hooks/use-skills'

export function SkillsView(): React.JSX.Element {
  const { skills, setSkills } = useSkills()
  const [expanded, setExpanded] = useState<string | null>(null)

  const remove = async (name: string): Promise<void> => {
    const r = await window.swarm.skills.remove(name)
    if (!r.ok) {
      toast.error(r.message)
      return
    }
    setSkills(r.skills)
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
    <div className="mx-auto flex max-w-2xl flex-col gap-4 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-semibold text-xl">Skills</h2>
          <p className="text-muted-foreground text-sm">
            Reusable instruction folders. Import a folder containing a{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">SKILL.md</code> plus any scripts or resources. The
            agent sees each skill's name + description and loads the full body on demand via the{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">use_skill</code> tool.
          </p>
        </div>
        <Button className="shrink-0 gap-1.5" onClick={() => void runImport()}>
          <FolderInput className="size-4" />
          Import skill folder
        </Button>
      </div>

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
                <p className="truncate font-medium text-sm">{s.name}</p>
                <p className="text-muted-foreground text-sm">{s.description}</p>
              </button>
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
                <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-muted p-3 font-mono text-xs">
                  {s.body}
                </pre>
              </div>
            )}
          </div>
        ))
      )}
    </div>
  )
}
