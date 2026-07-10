import { createFileRoute } from '@tanstack/react-router'

import { WorkbenchView } from '@/components/views/workbench-view'

export const Route = createFileRoute('/workbench')({ component: WorkbenchView })
