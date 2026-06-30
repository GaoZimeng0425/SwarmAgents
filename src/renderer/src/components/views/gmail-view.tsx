// src/renderer/src/components/views/gmail-view.tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Section, SettingsHeader } from './settings-primitives'

// Lets the user paste a Google OAuth Desktop client, link/unlink an account
// (read-only, gmail.readonly scope), trigger a cache sync, and watch the
// resulting status. State is also pushed from Main via onStateChanged, so the
// panel stays live without manual refetches when the daemon syncs in the
// background.
export function GmailSettingsView(): React.JSX.Element {
  const qc = useQueryClient()
  const { data: status } = useQuery({
    queryKey: ['gmail', 'status'],
    queryFn: () => window.swarm.gmail.getStatus(),
  })

  // Main pushes a fresh view whenever the daemon's state changes (link/unlink/
  // sync progress). Feed it straight into the cache so mutations and background
  // syncs both update the panel.
  useEffect(() => window.swarm.gmail.onStateChanged((view) => {
    void qc.setQueryData(['gmail', 'status'], view)
  }), [qc])

  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [credsError, setCredsError] = useState<string | null>(null)

  const setCreds = useMutation({
    mutationFn: () => window.swarm.gmail.setClientCreds({
      clientId: clientId.trim(),
      clientSecret: clientSecret.trim(),
    }),
    onSuccess: (r) => {
      if (!r.ok) {
        setCredsError(r.message)
        return
      }
      setCredsError(null)
      setClientId('')
      setClientSecret('')
      return qc.invalidateQueries({ queryKey: ['gmail', 'status'] })
    },
  })

  const link = useMutation({
    mutationFn: () => window.swarm.gmail.linkAccount(),
    onSuccess: (r) => {
      if (!r.ok) setCredsError(r.message)
      else setCredsError(null)
      return qc.invalidateQueries({ queryKey: ['gmail', 'status'] })
    },
  })
  const unlink = useMutation({
    mutationFn: () => window.swarm.gmail.unlinkAccount(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['gmail', 'status'] }),
  })
  const sync = useMutation({
    mutationFn: () => window.swarm.gmail.syncNow(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['gmail', 'status'] }),
    onError: (err: unknown) => {
      setCredsError(err instanceof Error ? err.message : String(err))
    },
  })

  const linked = status?.loggedIn === true

  return (
    <div className="space-y-5">
      <SettingsHeader
        description={
          <>
            Link a Google account (read-only). Create a <strong>Desktop-app</strong> OAuth client in Google Cloud
            Console, keep it in <strong>Testing</strong> mode, and add yourself as a test user. Scope:{' '}
            <code>gmail.readonly</code>.
          </>
        }
        title="Gmail"
      />

      <Section label="OAuth Client Credentials">
        <Input
          onChange={(e) => setClientId(e.target.value)}
          placeholder={
            status?.hasClientCreds
              ? '•••••••• (saved) — type to replace'
              : 'xxxxxxxx.apps.googleusercontent.com'
          }
          value={clientId}
        />
        <Input
          onChange={(e) => setClientSecret(e.target.value)}
          placeholder={status?.hasClientCreds ? '•••••••• (saved) — type to replace' : 'GOCSPX-…'}
          type="password"
          value={clientSecret}
        />
        <div className="flex gap-2">
          <Button
            disabled={setCreds.isPending || clientId.trim().length === 0 || clientSecret.trim().length === 0}
            onClick={() => setCreds.mutate()}
          >
            Save credentials
          </Button>
          {status?.hasClientCreds && (
            <Button
              disabled={setCreds.isPending}
              onClick={async () => {
                setCredsError(null)
                await window.swarm.gmail.clearClientCreds()
                await qc.invalidateQueries({ queryKey: ['gmail', 'status'] })
              }}
              variant="outline"
            >
              Clear
            </Button>
          )}
        </div>
        {credsError && <p className="text-destructive text-xs">{credsError}</p>}
      </Section>

      <hr className="border-border" />

      <Section label="Account">
        <div className="space-y-1 text-sm">
          <div className="flex items-center justify-between">
            <span className="font-medium">Status</span>
            <span className={linked ? 'text-primary text-xs' : 'text-muted-foreground text-xs'}>
              {linked ? '✓ linked' : 'not linked'}
            </span>
          </div>
          <Row label="Account" value={status?.accountEmail ?? null} />
          <Row label="Cached messages" value={status?.messageCount != null ? String(status.messageCount) : null} />
          <Row
            label="Last sync"
            value={status?.lastSyncAt != null ? new Date(status.lastSyncAt).toLocaleString() : null}
          />
          {status?.syncError && <p className="text-destructive text-xs">Error: {status.syncError}</p>}
        </div>
        <div className="flex gap-2 pt-2">
          <Button disabled={!status?.hasClientCreds || link.isPending || linked} onClick={() => link.mutate()}>
            Link account
          </Button>
          <Button disabled={!linked || sync.isPending} onClick={() => sync.mutate()} variant="outline">
            Sync now
          </Button>
          <Button disabled={!linked || unlink.isPending} onClick={() => unlink.mutate()} variant="outline">
            Unlink
          </Button>
        </div>
      </Section>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string | null }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono text-xs">{value ?? '—'}</span>
    </div>
  )
}
