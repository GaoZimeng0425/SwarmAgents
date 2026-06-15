import { useState } from 'react'
import type { Skill } from '@shared/types/skill'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useSkills } from '@/hooks/use-skills'

type Draft = { original: string | null; name: string; description: string; body: string }

const BODY_PLACEHOLDER = `Markdown instructions the agent loads when this skill applies.

## Steps
1. ...
2. ...`

function SkillEditor({
  draft,
  onSaved,
  onCancel,
}: {
  draft: Draft
  onSaved: (skills: Skill[]) => void
  onCancel: () => void
}): React.JSX.Element {
  const [name, setName] = useState(draft.name)
  const [description, setDescription] = useState(draft.description)
  const [body, setBody] = useState(draft.body)
  const isEdit = draft.original !== null

  const save = async (): Promise<void> => {
    if (!name.trim() || !description.trim()) {
      toast.error('Name and description are required')
      return
    }
    const r = await window.swarm.skills.save({ name: name.trim(), description: description.trim(), body })
    if (!r.ok) {
      toast.error(r.message)
      return
    }
    toast.success(isEdit ? `Saved "${name.trim()}"` : `Created "${name.trim()}"`)
    onSaved(r.skills)
  }

  return (
    <div className="rounded-xl border bg-card p-4">
      <h3 className="mb-3 font-medium text-sm">{isEdit ? 'Edit skill' : 'New skill'}</h3>
      <div className="flex flex-col gap-3">
        <Input
          disabled={isEdit}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name — lowercase, digits and hyphens (e.g. release-notes)"
          value={name}
        />
        <Input
          onChange={(e) => setDescription(e.target.value)}
          placeholder="One-line description — shown to the agent so it knows when to use this skill"
          value={description}
        />
        <Textarea
          className="min-h-48 font-mono text-xs"
          onChange={(e) => setBody(e.target.value)}
          placeholder={BODY_PLACEHOLDER}
          value={body}
        />
        <div className="flex justify-end gap-2">
          <Button onClick={onCancel} variant="ghost">
            Cancel
          </Button>
          <Button onClick={() => void save()}>Save</Button>
        </div>
      </div>
    </div>
  )
}

export function SkillsView(): React.JSX.Element {
  const { skills, setSkills } = useSkills()
  const [draft, setDraft] = useState<Draft | null>(null)

  const remove = async (name: string): Promise<void> => {
    const r = await window.swarm.skills.remove(name)
    if (!r.ok) {
      toast.error(r.message)
      return
    }
    setSkills(r.skills)
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-semibold text-xl">Skills</h2>
          <p className="text-muted-foreground text-sm">
            Reusable instruction sets. The agent sees each skill's name + description and loads the full body on demand
            via the <code className="rounded bg-muted px-1 py-0.5 text-xs">use_skill</code> tool.
          </p>
        </div>
        {!draft && (
          <Button
            className="shrink-0 gap-1.5"
            onClick={() => setDraft({ original: null, name: '', description: '', body: '' })}
          >
            <Plus className="size-4" />
            New skill
          </Button>
        )}
      </div>

      {draft && (
        <SkillEditor
          draft={draft}
          onCancel={() => setDraft(null)}
          onSaved={(s) => {
            setSkills(s)
            setDraft(null)
          }}
        />
      )}

      {skills.length === 0 && !draft ? (
        <p className="text-muted-foreground text-sm">No skills yet. Create one above.</p>
      ) : (
        skills.map((s) => (
          <div className="rounded-xl border bg-card p-4" key={s.name}>
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-sm">{s.name}</p>
                <p className="text-muted-foreground text-sm">{s.description}</p>
              </div>
              <Button
                aria-label="Edit skill"
                className="text-muted-foreground"
                onClick={() => setDraft({ original: s.name, name: s.name, description: s.description, body: s.body })}
                size="icon"
                variant="ghost"
              >
                <Pencil className="size-4" />
              </Button>
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
          </div>
        ))
      )}
    </div>
  )
}
