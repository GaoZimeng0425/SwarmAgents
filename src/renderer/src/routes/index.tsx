import { createFileRoute } from '@tanstack/react-router'

import { TasksView } from '@/components/views/tasks-view'

export const Route = createFileRoute('/')({ component: TasksView })
