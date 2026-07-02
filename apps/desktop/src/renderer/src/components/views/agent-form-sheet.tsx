import { useEffect, useState } from 'react'
import type { AgentDefinition, ToolScope } from '@swarm/protocol'
import { compact } from 'es-toolkit'

import { Button } from '@swarm/ui'
import { Input } from '@swarm/ui'
import { Label } from '@swarm/ui'
import { NativeSelect, NativeSelectOption } from '@swarm/ui'
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from '@swarm/ui'
import { Switch } from '@swarm/ui'
import { Textarea } from '@swarm/ui'

type AgentFormSheetProps = {
  open: boolean
  mode: 'create' | 'edit' | 'duplicate'
  agent?: AgentDefinition
  agents: AgentDefinition[]
  error?: string
  onSubmit: (def: AgentDefinition) => void
  onOpenChange: (open: boolean) => void
}

const SCOPES: ToolScope[] = ['peekaboo', 'web', 'fs', 'memory', 'authoring', 'coordinate', 'all']

/** Right-side form to create / edit / duplicate an agent. Prop-driven: it owns
 *  only local field state and calls onSubmit with the assembled definition;
 *  persistence lives in the caller (useAgentMutations). */
export function AgentFormSheet({
  open,
  mode,
  agent,
  agents,
  error,
  onSubmit,
  onOpenChange,
}: AgentFormSheetProps): React.JSX.Element {
  const [id, setId] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [toolScope, setToolScope] = useState<ToolScope>('all')
  const [parentId, setParentId] = useState('')
  const [team, setTeam] = useState('')
  const [teamHead, setTeamHead] = useState(false)
  const [role, setRole] = useState('')
  const [capabilities, setCapabilities] = useState('')
  const [model, setModel] = useState('')
  const [maxIterations, setMaxIterations] = useState('25')

  // Re-seed fields whenever the sheet opens for a different agent/mode.
  useEffect(() => {
    const a = agent
    setId(mode === 'duplicate' ? '' : (a?.id ?? ''))
    setName(a?.name ?? '')
    setDescription(a?.description ?? '')
    setSystemPrompt(a?.systemPrompt ?? '')
    setToolScope(a?.toolScope ?? 'all')
    setParentId(a?.parentId ?? '')
    setTeam(a?.team ?? '')
    setTeamHead(a?.teamRole === 'head')
    setRole(a?.role ?? '')
    setCapabilities((a?.capabilities ?? []).join(', '))
    setModel(a?.model ?? '')
    setMaxIterations(String(a?.maxIterations ?? 25))
  }, [agent, mode, open])

  const idReadOnly = mode === 'edit'

  const submit = (): void => {
    const caps = compact(capabilities.split(',').map((c) => c.trim()))
    const def: AgentDefinition = {
      id: id.trim(),
      name: name.trim(),
      description: description.trim(),
      systemPrompt,
      toolScope,
      maxIterations: Number(maxIterations) || 25,
      ...(parentId ? { parentId } : {}),
      ...(team.trim() ? { team: team.trim() } : {}),
      ...(teamHead ? { teamRole: 'head' as const } : {}),
      ...(role.trim() ? { role: role.trim() } : {}),
      ...(caps.length ? { capabilities: caps } : {}),
      ...(model.trim() ? { model: model.trim() } : {}),
    }
    onSubmit(def)
  }

  const title = mode === 'edit' ? 'Edit agent' : mode === 'duplicate' ? 'Duplicate agent' : 'New agent'

  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent className="flex w-full flex-col gap-0 sm:max-w-xl" side="right">
        <SheetHeader className="border-b px-4 py-3">
          <SheetTitle>{title}</SheetTitle>
        </SheetHeader>

        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
          {error && <p className="rounded bg-destructive/10 px-3 py-2 text-destructive text-sm">{error}</p>}

          <Field htmlFor="agent-id" label="id">
            <Input id="agent-id" onChange={(e) => setId(e.target.value)} readOnly={idReadOnly} value={id} />
          </Field>
          <Field htmlFor="agent-name" label="name">
            <Input id="agent-name" onChange={(e) => setName(e.target.value)} value={name} />
          </Field>
          <Field htmlFor="agent-description" label="description">
            <Textarea
              id="agent-description"
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              value={description}
            />
          </Field>
          <Field htmlFor="agent-systemPrompt" label="system prompt">
            <Textarea
              id="agent-systemPrompt"
              onChange={(e) => setSystemPrompt(e.target.value)}
              rows={10}
              value={systemPrompt}
            />
          </Field>
          <Field htmlFor="agent-toolScope" label="tool scope">
            <NativeSelect
              id="agent-toolScope"
              onChange={(e) => setToolScope(e.target.value as ToolScope)}
              value={toolScope}
            >
              {SCOPES.map((s) => (
                <NativeSelectOption key={s} value={s}>
                  {s}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <Field htmlFor="agent-parent" label="parent">
            <NativeSelect id="agent-parent" onChange={(e) => setParentId(e.target.value)} value={parentId}>
              <NativeSelectOption value="">(none)</NativeSelectOption>
              {agents
                .filter((a) => a.id !== agent?.id)
                .map((a) => (
                  <NativeSelectOption key={a.id} value={a.id}>
                    {a.name} ({a.id})
                  </NativeSelectOption>
                ))}
            </NativeSelect>
          </Field>
          <Field htmlFor="agent-team" label="team">
            <Input id="agent-team" onChange={(e) => setTeam(e.target.value)} value={team} />
          </Field>
          <div className="flex items-center gap-2">
            <Switch aria-label="Team head" checked={teamHead} id="agent-teamHead" onCheckedChange={setTeamHead} />
            <Label htmlFor="agent-teamHead">Team head</Label>
          </div>
          <Field htmlFor="agent-role" label="role">
            <Input id="agent-role" onChange={(e) => setRole(e.target.value)} value={role} />
          </Field>
          <Field htmlFor="agent-capabilities" label="capabilities">
            <Input
              id="agent-capabilities"
              onChange={(e) => setCapabilities(e.target.value)}
              placeholder="comma, separated"
              value={capabilities}
            />
          </Field>
          <Field htmlFor="agent-model" label="model">
            <Input id="agent-model" onChange={(e) => setModel(e.target.value)} value={model} />
          </Field>
          <Field htmlFor="agent-maxIterations" label="max iterations">
            <Input
              id="agent-maxIterations"
              onChange={(e) => setMaxIterations(e.target.value)}
              type="number"
              value={maxIterations}
            />
          </Field>
        </div>

        <SheetFooter className="border-t px-4 py-3">
          <Button onClick={() => onOpenChange(false)} variant="outline">
            Cancel
          </Button>
          <Button onClick={submit}>Save</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

/** Label + control row; the label's text is the control's accessible name. */
function Field({
  label,
  htmlFor,
  children,
}: {
  label: string
  htmlFor: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="space-y-1">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  )
}
