/** Decode a `data:<mime>;base64,<payload>` URL into a Blob. Throws if not a base64 data URL. */
export function dataUrlToBlob(dataUrl: string): Blob {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
  if (!match) throw new Error('Not a base64 data URL')
  const mime = match[1]
  const binary = atob(match[2])
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}
