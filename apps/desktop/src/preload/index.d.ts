import type { ElectronAPI } from '@electron-toolkit/preload'
import type { SwarmBridge } from '@swarm/protocol'

declare global {
  interface Window {
    electron: ElectronAPI
    swarm: SwarmBridge
  }
}
