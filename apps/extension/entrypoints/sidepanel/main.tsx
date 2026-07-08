import './globals.css'
import React from 'react'
import { createRoot } from 'react-dom/client'

import { SidePanel } from './SidePanel'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SidePanel />
  </React.StrictMode>
)
