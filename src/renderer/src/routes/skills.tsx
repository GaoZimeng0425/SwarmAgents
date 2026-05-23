import { createFileRoute } from '@tanstack/react-router'

import { SkillsView } from '@/components/views/skills-view'

export const Route = createFileRoute('/skills')({ component: SkillsView })
