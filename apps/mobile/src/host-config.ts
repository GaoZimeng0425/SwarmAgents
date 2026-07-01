import AsyncStorage from '@react-native-async-storage/async-storage'

const KEY = 'swarm.host'

export type HostConfig = { wsHost: string; token: string }

export async function loadHostConfig(): Promise<HostConfig> {
  const raw = await AsyncStorage.getItem(KEY)
  if (raw) {
    const v = JSON.parse(raw) as Partial<HostConfig>
    if (typeof v.wsHost === 'string' && typeof v.token === 'string') {
      return { wsHost: v.wsHost, token: v.token }
    }
  }
  return { wsHost: 'ws://127.0.0.1:47777', token: '' }
}

export async function saveHostConfig(cfg: HostConfig): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(cfg))
}
