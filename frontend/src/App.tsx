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
import Settings from './pages/Settings'
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
          <Route path="/settings" element={<Settings />} />
          <Route path="/mock" element={<MockPanel />} />
        </Route>
      </Routes>
      <Toaster />
      <DialogHost />
    </>
  )
}
