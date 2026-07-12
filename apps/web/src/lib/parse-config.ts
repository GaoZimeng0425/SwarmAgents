export type ConnectionConfig = {
  host: string
  port: number
  token: string
}

// Validate and assemble a ConnectionConfig from raw form input. Trims all
// fields, checks host/token non-empty, parses port as an integer in 1–65535.
// Throws an Error with a Chinese message on any invalid input — the caller
// should catch and show it inline next to the form.
export function parseConnectionConfig(host: string, port: string, token: string): ConnectionConfig {
  const h = host.trim()
  const t = token.trim()
  if (!h) throw new Error('主机地址不能为空')
  if (!t) throw new Error('Token 不能为空')

  const portNum = Number.parseInt(port.trim(), 10)
  if (!Number.isFinite(portNum) || portNum < 1 || portNum > 65535) {
    throw new Error('端口必须是 1–65535 之间的数字')
  }

  return { host: h, port: portNum, token: t }
}
