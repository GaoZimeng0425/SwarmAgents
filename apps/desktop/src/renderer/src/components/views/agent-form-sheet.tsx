import { useEffect, useState } from 'react'
import type { AgentDefinition } from '@swarm/protocol'
import {
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Sheet,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  Switch,
  Textarea,
} from '@swarm/ui'
import { compact } from 'es-toolkit'

type AgentFormSheetProps = {
  open: boolean
  mode: 'create' | 'edit' | 'duplicate'
  agent?: AgentDefinition
  agents: AgentDefinition[]
  error?: string
  onSubmit: (def: AgentDefinition) => void
  onOpenChange: (open: boolean) => void
}

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
  const [authoring, setAuthoring] = useState(false)
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
    // Back-compat: a legacy on-disk agent may carry toolScope: 'authoring' instead of the flag.
    setAuthoring(a?.authoring === true || a?.toolScope === 'authoring')
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
      maxIterations: Number(maxIterations) || 25,
      ...(authoring ? { authoring: true } : {}),
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
          <div className="flex items-center gap-2">
            <Switch aria-label="Authoring" checked={authoring} id="agent-authoring" onCheckedChange={setAuthoring} />
            <Label htmlFor="agent-authoring">Authoring (write_agent / write_skill access)</Label>
          </div>
          <Field htmlFor="agent-parent" label="parent">
            <Select onValueChange={(v) => setParentId(v ?? '')} value={parentId}>
              <SelectTrigger className="w-full" id="agent-parent">
                <SelectValue>
                  {(v: string) => {
                    const parent = agents.find((a) => a.id === v)
                    return parent ? `${parent.name} (${parent.id})` : '(none)'
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">(none)</SelectItem>
                {agents
                  .filter((a) => a.id !== agent?.id)
                  .map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name} ({a.id})
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
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
