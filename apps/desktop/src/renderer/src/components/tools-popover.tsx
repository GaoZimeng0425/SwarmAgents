import { useEffect, useState } from 'react'
import type { McpServerConfig, Skill, ToolGroupInfo } from '@swarm/protocol'
import { Button, Popover, PopoverContent, PopoverTrigger, Switch } from '@swarm/ui'
import { SlidersHorizontal } from 'lucide-react'

import { ScrollArea } from '@/components/ui/scroll-area'
import { useMcpServers } from '@/hooks/use-mcp-servers'

function Row({
  title,
  subtitle,
  checked,
  onToggle,
}: {
  title: string
  subtitle?: string
  checked: boolean
  onToggle: (enabled: boolean) => void
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-3 py-1.5">
      <div className="min-w-0 flex-1">
        <p className={`truncate font-medium text-sm ${checked ? '' : 'text-muted-foreground'}`}>{title}</p>
        {subtitle && <p className="truncate text-muted-foreground text-xs">{subtitle}</p>}
      </div>
      <Switch aria-label={`${checked ? 'Disable' : 'Enable'} ${title}`} checked={checked} onCheckedChange={onToggle} />
    </div>
  )
}

function Section({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div>
      <p className="mb-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">{label}</p>
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  )
}

/**
 * Top-right control surface: a quick popover that toggles MCP servers, built-in
 * tool groups, and skills on/off app-wide. The Skills settings page mirrors the
 * same skill toggles; this is the at-a-glance version.
 */
export function ToolsPopover(): React.JSX.Element {
  const { servers } = useMcpServers()
  const [groups, setGroups] = useState<ToolGroupInfo[]>([])
  const [skills, setSkills] = useState<Skill[]>([])

  // Load on mount; both lists also live in their settings pages, but this panel
  // is global so it stays mounted and a fresh read on open is cheap enough here.
  useEffect(() => {
    void window.swarm.toolToggles.listGroups().then(setGroups)
    void window.swarm.skills.list().then(setSkills)
  }, [])

  const toggleMcp = (server: McpServerConfig, enabled: boolean): void => {
    void window.swarm.mcp.setEnabled(server.id, enabled)
  }
  const toggleGroup = (group: string, enabled: boolean): void => {
    setGroups((prev) => prev.map((g) => (g.group === group ? { ...g, enabled } : g)))
    void window.swarm.toolToggles.setToolGroupEnabled(group, enabled)
  }
  const toggleSkill = (name: string, enabled: boolean): void => {
    setSkills((prev) => prev.map((s) => (s.name === name ? { ...s, enabled } : s)))
    void window.swarm.toolToggles.setSkillEnabled(name, enabled)
  }

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button aria-label="Tools" className="text-muted-foreground" size="icon-sm" variant="ghost">
            <SlidersHorizontal />
          </Button>
        }
      />
      <PopoverContent align="end" className="w-80 p-0">
        <div className="border-b px-3 py-2">
          <p className="font-medium text-sm">Tools</p>
          <p className="text-muted-foreground text-xs">Enable or disable capabilities for every agent.</p>
        </div>
        <ScrollArea className="[&_[data-slot=scroll-area-viewport]]:max-h-[60vh]">
          <div className="flex flex-col gap-4 px-3 py-3">
            <Section label="MCP servers">
              {servers.length === 0 ? (
                <p className="text-muted-foreground text-xs">No MCP servers configured.</p>
              ) : (
                servers.map((s) => (
                  <Row
                    checked={s.enabled !== false}
                    key={s.id}
                    onToggle={(v) => toggleMcp(s, v)}
                    subtitle={s.transport}
                    title={s.name}
                  />
                ))
              )}
            </Section>

            <Section label="Built-in tools">
              {groups.map((g) => (
                <Row
                  checked={g.enabled}
                  key={g.group}
                  onToggle={(v) => toggleGroup(g.group, v)}
                  subtitle={g.toolNames.join(', ')}
                  title={g.group}
                />
              ))}
            </Section>

            <Section label="Skills">
              {skills.length === 0 ? (
                <p className="text-muted-foreground text-xs">No skills yet.</p>
              ) : (
                skills.map((s) => (
                  <Row
                    checked={s.enabled !== false}
                    key={s.name}
                    onToggle={(v) => toggleSkill(s.name, v)}
                    subtitle={s.description}
                    title={s.name}
                  />
                ))
              )}
            </Section>
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  )
}
