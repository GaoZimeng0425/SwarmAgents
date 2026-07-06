import { useEffect, useState } from 'react'
import type { WeatherConfig } from '@swarm/protocol'
import { Button, Input, Textarea } from '@swarm/ui'

import { useWeather } from '@/hooks/use-weather'
import { Section, SettingsHeader } from './settings-primitives'

export function WeatherView(): React.JSX.Element {
  const { config } = useWeather()
  const [draft, setDraft] = useState<WeatherConfig>(config)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Keep the draft in sync when the server value loads/changes.
  useEffect(() => {
    setDraft(config)
  }, [config])

  const save = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const r = await window.swarm.weather.setConfig(draft)
    setBusy(false)
    if (!r.ok) setError(r.message)
  }

  return (
    <div className="space-y-5">
      <SettingsHeader
        title="Weather"
        description={
          <>
            QWeather (和风天气) grid-point hourly forecast for the dashboard card. Credentials are encrypted at rest
            via the system Keychain. Generate an Ed25519 key pair in the QWeather console, register the public key as a
            credential, then paste the Project ID, Credential ID, and the private key PEM below.
          </>
        }
      />

      <Section label="Host">
        <Input
          onChange={(e) => setDraft({ ...draft, host: e.target.value })}
          placeholder="https://devapi.qweather.com"
          value={draft.host}
        />
        <p className="text-muted-foreground text-xs">
          Public dev host: <code>https://devapi.qweather.com</code>. Commercial: <code>https://api.qweather.com</code>.
        </p>
      </Section>

      <hr className="border-border" />

      <Section label="Project ID">
        <Input
          onChange={(e) => setDraft({ ...draft, projectId: e.target.value })}
          placeholder="e.g. 1234567890abcdef"
          value={draft.projectId}
        />
      </Section>

      <Section label="Credential ID">
        <Input
          onChange={(e) => setDraft({ ...draft, credentialId: e.target.value })}
          placeholder="e.g. 9876543210fedcba"
          value={draft.credentialId}
        />
      </Section>

      <Section label="Private Key (Ed25519 PEM)">
        <Textarea
          className="font-mono text-xs"
          onChange={(e) => setDraft({ ...draft, privateKeyPem: e.target.value })}
          placeholder={'-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----'}
          rows={6}
          value={draft.privateKeyPem}
        />
        <p className="text-muted-foreground text-xs">
          Paste the contents of your <code>ed25519-private.pem</code>. Stored encrypted; never leaves the main process.
        </p>
      </Section>

      <div className="flex items-center gap-3">
        <Button disabled={busy} onClick={() => void save()}>
          Save
        </Button>
        {error && <span className="text-destructive text-xs">{error}</span>}
        {!error && config.projectId && <span className="text-muted-foreground text-xs">✓ configured</span>}
      </div>
    </div>
  )
}
