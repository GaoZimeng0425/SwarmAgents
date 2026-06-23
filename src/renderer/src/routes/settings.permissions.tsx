import { createFileRoute } from '@tanstack/react-router'

import { PermissionsView } from '@/components/views/permissions-view'

export const Route = createFileRoute('/settings/permissions')({ component: PermissionsView })
