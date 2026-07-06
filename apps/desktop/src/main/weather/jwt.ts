// QWeather JWT signer. QWeather authenticates requests with an EdDSA
// (Ed25519)-signed JWT: header.kid = credentialId, payload.sub = projectId,
// short-lived exp. Built with `jose`, which is the IETF reference impl and
// handles base64url padding + Ed25519 JWK import correctly (hand-rolling JWT
// signing is error-prone; the spec records jose as an accepted dependency).
import { createPrivateKey } from 'node:crypto'
import { exportJWK, SignJWT } from 'jose'

import type { WeatherConfig } from '@swarm/protocol'

export async function signQWeatherJwt(cfg: WeatherConfig): Promise<string> {
  const keyObj = createPrivateKey({ key: cfg.privateKeyPem, format: 'pem' })
  const jwk = await exportJWK(keyObj) // jose needs a JWK for Ed25519 keys
  return new SignJWT({})
    .setProtectedHeader({ alg: 'EdDSA', kid: cfg.credentialId })
    .setSubject(cfg.projectId)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(jwk)
}
