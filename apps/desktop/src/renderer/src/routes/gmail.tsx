import { createFileRoute } from '@tanstack/react-router'

import { GmailInboxView } from '@/components/views/gmail-inbox-view'

export const Route = createFileRoute('/gmail')({ component: GmailInboxView })
