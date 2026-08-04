// CommandShortcut — render a command's binding as platform-aware <Kbd> tokens.
//
// Reads the command-bindings store directly so it stays in sync when a user
// rebinds (via useCommandRecorder) without the parent needing to thread props.
// Unbound commands render nothing.

import { Kbd, KbdGroup } from '@swarm/ui'

import type { CommandId } from '@/lib/commands/definitions'
import { getCommandTokens } from '@/lib/commands/display'
import { useCommandBindingsStore } from '@/stores/command-bindings'

export interface CommandShortcutProps {
  /** The command whose binding to display. */
  commandId: CommandId
  /** Hide the group when the command is unbound (default). When false, renders
   *  a muted placeholder so layout doesn't shift. */
  hideWhenUnbound?: boolean
}

export function CommandShortcut({ commandId, hideWhenUnbound = true }: CommandShortcutProps): React.JSX.Element | null {
  const overrides = useCommandBindingsStore((s) => s.overrides)
  const tokens = getCommandTokens(commandId, overrides)

  if (!tokens || tokens.length === 0) {
    return hideWhenUnbound ? null : <span className="text-muted-foreground text-xs">未绑定</span>
  }

  return (
    <KbdGroup>
      {tokens.map((tok, i) => (
        <Kbd key={`${tok}-${i}`}>{tok}</Kbd>
      ))}
    </KbdGroup>
  )
}
