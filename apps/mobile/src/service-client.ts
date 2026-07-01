import { createContext, useContext } from 'react'
import type { ServiceClient } from '@swarm/protocol'

export const ServiceClientContext = createContext<ServiceClient | null>(null)
export const useServiceClient = (): ServiceClient | null => useContext(ServiceClientContext)
