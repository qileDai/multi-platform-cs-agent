import { useEffect } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import Layout from './components/Layout'
import { DialogHost } from './components/ui/dialogs'
import { Toaster } from './components/ui/toast'
import Accounts from './pages/Accounts'
import Analytics from './pages/Analytics'
import Comments from './pages/Comments'
import ContentStudio from './pages/ContentStudio'
import Dashboard from './pages/Dashboard'
import Funnel from './pages/Funnel'
import Inspiration from './pages/Inspiration'
import Knowledge from './pages/Knowledge'
import Login from './pages/Login'
import MockPanel from './pages/MockPanel'
import PublishCalendar from './pages/PublishCalendar'
import AutomationSettings from './pages/settings/AutomationSettings'
import ChannelSettings from './pages/settings/ChannelSettings'
import OpsSettings from './pages/settings/OpsSettings'
import ServiceSettings from './pages/settings/ServiceSettings'
import SettingsLayout from './pages/settings/SettingsLayout'
import Tickets from './pages/Tickets'
import Workbench from './pages/Workbench'
import { useAuth } from './store'

export default function App() {
  const { agent, ready, loadMe } = useAuth()
  const location = useLocation()

  useEffect(() => {
    loadMe()
  }, [])

  if (!ready) {
    return <div className="h-full flex items-center justify-center text-gray-400">加载中...</div>
  }

  if (!agent && location.pathname !== '/login') {
    return <Navigate to="/login" replace />
  }

  return (
    <>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route element={<Layout />}>
          <Route path="/" element={<Workbench />} />
          <Route path="/knowledge" element={<Knowledge />} />
          <Route path="/tickets" element={<Tickets />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/accounts" element={<Accounts />} />
          <Route path="/studio" element={<ContentStudio />} />
          <Route path="/publish" element={<PublishCalendar />} />
          <Route path="/comments" element={<Comments />} />
          <Route path="/funnel" element={<Funnel />} />
          <Route path="/analytics" element={<Analytics />} />
          <Route path="/inspiration" element={<Inspiration />} />
          <Route path="/settings" element={<SettingsLayout />}>
            <Route index element={<Navigate to="service" replace />} />
            <Route path="service" element={<ServiceSettings />} />
            <Route path="automation" element={<AutomationSettings />} />
            <Route path="channels" element={<ChannelSettings />} />
            <Route path="ops" element={<OpsSettings />} />
          </Route>
          <Route path="/mock" element={<MockPanel />} />
        </Route>
      </Routes>
      <Toaster />
      <DialogHost />
    </>
  )
}
