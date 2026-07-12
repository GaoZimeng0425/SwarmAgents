import { Navigate, Route, BrowserRouter as Router, Routes, useLocation } from 'react-router-dom'

import { ConnectPage } from '@/pages/connect'
import { SessionDetailPage } from '@/pages/session'
import { SessionsPage } from '@/pages/sessions'
import { SettingsPage } from '@/pages/settings'
import { useConnection } from '@/stores/connection-store'

// Redirect to /connect whenever the connection drops. Placed inside the Router
// so it can use useLocation (avoids redirect loops on /connect itself).
function ConnectionGuard({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { status } = useConnection()
  const location = useLocation()
  if (status !== 'connected' && location.pathname !== '/connect') {
    return <Navigate replace to="/connect" />
  }
  return <>{children}</>
}

export default function App(): React.JSX.Element {
  return (
    <Router>
      <ConnectionGuard>
        <Routes>
          <Route element={<ConnectPage />} path="/connect" />
          <Route element={<SessionsPage />} path="/sessions" />
          <Route element={<SessionDetailPage />} path="/session/:id" />
          <Route element={<SettingsPage />} path="/settings" />
          <Route element={<Navigate replace to="/sessions" />} path="*" />
        </Routes>
      </ConnectionGuard>
    </Router>
  )
}
