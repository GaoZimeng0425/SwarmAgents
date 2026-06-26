import type { AgentDefinition } from '@shared/types/agent'

/** Detail panel for a single agent: name, id, description, and full system
 *  prompt. Single source for the agent detail view (previously duplicated). */
export function AgentDetail({ agent }: { agent: AgentDefinition }): React.JSX.Element {
  return (
    <div className="mt-4 border-t pt-3">
      <div className="flex items-center gap-2">
        <p className="font-medium text-sm">{agent.name}</p>
        <p className="font-mono text-muted-foreground text-xs">{agent.id}</p>
      </div>
      <p className="mt-1 text-muted-foreground text-sm">{agent.description}</p>
      {agent.systemPrompt && (
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded bg-muted p-3 font-mono text-xs">
          {agent.systemPrompt}
        </pre>
      )}
    </div>
  )
}
