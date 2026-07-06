import { useEffect, useState } from 'react'
import type { WeatherConfig } from '@swarm/protocol'
import { Button, Input, Textarea } from '@swarm/ui'

import { useWeather } from '@/hooks/use-weather'
import { Section, SettingsHeader } from './settings-primitives'

// Writable fields tracked in the draft. The PEM is held separately (pemDraft)
// because the config read from main is the redacted view — the secret never
// round-trips back out, so the textarea starts empty on every load.
type Draft = Pick<WeatherConfig, 'host' | 'projectId' | 'credentialId'>

export function WeatherView(): React.JSX.Element {
  const { config } = useWeather()
  const [draft, setDraft] = useState<Draft>({
    host: config.host,
    projectId: config.projectId,
    credentialId: config.credentialId,
  })
  const [pemDraft, setPemDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Keep the draft in sync when the server value loads/changes. The PEM
  // textarea is deliberately NOT repopulated — it always starts empty so the
  // saved secret is never echoed back into the renderer.
  useEffect(() => {
    setDraft({ host: config.host, projectId: config.projectId, credentialId: config.credentialId })
  }, [config])

  const save = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    // setConfig needs the FULL config (the write path carries the PEM).
    const full: WeatherConfig = {
      host: draft.host,
      projectId: draft.projectId,
      credentialId: draft.credentialId,
      privateKeyPem: pemDraft,
    }
    const r = await window.swarm.weather.setConfig(full)
    setBusy(false)
    if (!r.ok) setError(r.message)
  }

  // The PEM is required on every save: the redacted view never echoes the
  // secret back, so there is no way to re-send the existing key without the
  // user re-pasting it. validateConfig on the main side rejects an empty PEM.
  const canSave = !busy && pemDraft.trim().length > 0

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
          onChange={(e) => setPemDraft(e.target.value)}
          placeholder={
            config.hasPrivateKey
              ? '••••• saved — type to replace (required on every save)'
              : '-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----'
          }
          rows={6}
          value={pemDraft}
        />
        <p className="text-muted-foreground text-xs">
          {config.hasPrivateKey && <span className="mr-1">✓ private key saved.</span>}
          Paste your private key PEM. Required on every save (the key is not echoed back for security). Stored encrypted;
          never leaves the main process.
        </p>
      </Section>

      <div className="flex items-center gap-3">
        <Button disabled={!canSave} onClick={() => void save()}>
          Save
        </Button>
        {error && <span className="text-destructive text-xs">{error}</span>}
        {!error && config.hasPrivateKey && (
          <span className="text-muted-foreground text-xs">✓ configured</span>
        )}
      </div>
    </div>
  )
}
