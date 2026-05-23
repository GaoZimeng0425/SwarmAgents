import type { ElectronAPI } from '@electron-toolkit/preload'

import type { SwarmBridge } from '../shared/types/ui'

declare global {
  interface Window {
    electron: ElectronAPI
    swarm: SwarmBridge
  }
}
