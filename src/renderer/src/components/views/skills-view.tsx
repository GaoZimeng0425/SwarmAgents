import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

export function SkillsView(): React.JSX.Element {
  return (
    <div className="p-6">
      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle>Skills</CardTitle>
          <CardDescription>
            Skill loader (<code>.swarm/skills/&lt;name&gt;/SKILL.md</code>) lands in a later plan.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-muted-foreground text-sm">Coming soon.</CardContent>
      </Card>
    </div>
  )
}
