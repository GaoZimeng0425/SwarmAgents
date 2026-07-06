import { generateKeyPairSync, type KeyObject } from 'node:crypto'
import type { WeatherConfig } from '@swarm/protocol'
import { jwtVerify } from 'jose'
import { describe, expect, it } from 'vitest'

import { signQWeatherJwt } from './jwt'

// Generate a real Ed25519 pair so the test verifies against jose's own verifier.
function ed25519Pem(): { privateKeyPem: string; publicKey: KeyObject } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  // Export PKCS8 PEM for the signer (matches what users paste from openssl).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const privateKeyPem = (privateKey as any).export({ format: 'pem', type: 'pkcs8' }) as string
  return { privateKeyPem, publicKey }
}

describe('signQWeatherJwt', () => {
  it('produces a verifiable EdDSA JWT with kid + sub claims', async () => {
    const { privateKeyPem, publicKey } = ed25519Pem()
    const cfg: WeatherConfig = {
      host: 'https://devapi.qweather.com',
      projectId: 'proj_abc',
      credentialId: 'cred_xyz',
      privateKeyPem,
      location: '',
    }

    const token = await signQWeatherJwt(cfg)
    expect(typeof token).toBe('string')
    expect(token.split('.').length).toBe(3) // header.payload.signature

    // jose's own verifier must accept it, proving alg/kid/sub are well-formed.
    const spki = publicKey.export({ format: 'pem', type: 'spki' })
    const key = await (await import('jose')).importSPKI(spki, 'EdDSA')
    const { payload, protectedHeader } = await jwtVerify(token, key)
    expect(payload.sub).toBe('proj_abc')
    expect(protectedHeader.alg).toBe('EdDSA')
    expect(protectedHeader.kid).toBe('cred_xyz')
  })

  it('sets an expiry no further than 5 minutes out', async () => {
    const { privateKeyPem, publicKey } = ed25519Pem()
    const cfg: WeatherConfig = {
      host: 'x',
      projectId: 'p',
      credentialId: 'c',
      privateKeyPem,
      location: '',
    }
    const token = await signQWeatherJwt(cfg)
    const spki = publicKey.export({ format: 'pem', type: 'spki' })
    const key = await (await import('jose')).importSPKI(spki, 'EdDSA')
    const { payload } = await jwtVerify(token, key)
    const nowSec = Math.floor(Date.now() / 1000)
    expect(payload.exp ?? 0).toBeGreaterThan(nowSec)
    expect(payload.exp ?? 0).toBeLessThanOrEqual(nowSec + 300)
  })
})
