import clsx from 'clsx'
import {
  BarChart3,
  BookOpen,
  CalendarClock,
  ClipboardList,
  Filter,
  FlaskConical,
  Lightbulb,
  LogOut,
  MessageCircle,
  MessageSquare,
  Moon,
  PenSquare,
  Settings as SettingsIcon,
  Sparkles,
  Sun,
  TrendingUp,
  Users,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { api } from '../api/client'
import { useTheme } from '../hooks/useTheme'
import { useAuth } from '../store'

const CS_NAV = [
  { path: '/', label: '对话', icon: MessageSquare },
  { path: '/knowledge', label: '知识库', icon: BookOpen },
  { path: '/tickets', label: '工单', icon: ClipboardList },
  { path: '/dashboard', label: '数据', icon: BarChart3 },
]

const MATRIX_NAV = [
  { path: '/accounts', label: '账号', icon: Users },
  { path: '/studio', label: '创作', icon: PenSquare },
  { path: '/publish', label: '发布', icon: CalendarClock },
  { path: '/comments', label: '评论', icon: MessageCircle },
  { path: '/funnel', label: '漏斗', icon: Filter },
  { path: '/analytics', label: '效果', icon: TrendingUp },
  { path: '/inspiration', label: '灵感', icon: Lightbulb },
  { path: '/mock', label: '模拟', icon: FlaskConical },
]

const STATUS_MAP: Record<string, { label: string; color: string }> = {
  active: { label: '接待中', color: 'bg-green-500' },
  resting: { label: '休息中', color: 'bg-yellow-500' },
  offline: { label: '离线', color: 'bg-gray-400' },
}

function NavItem({
  path,
  label,
  icon: Icon,
  unread,
  csActive,
}: {
  path: string
  label: string
  icon: typeof MessageSquare
  unread?: number
  csActive?: boolean
}) {
  return (
    <NavLink
      to={path}
      end={path === '/'}
      className={({ isActive }) =>
        clsx(
          'w-12 py-1.5 rounded-lg flex flex-col items-center gap-0.5 transition-colors relative',
          isActive
            ? csActive
              ? 'bg-primary-600 text-white'
              : 'bg-gray-700 text-white'
            : 'text-gray-400 hover:bg-gray-700/70 hover:text-gray-200',
        )
      }
    >
      <Icon size={18} />
      <span className="text-[10px]">{label}</span>
      {unread ? (
        <span className="absolute top-0.5 right-1 bg-red-500 text-white text-[9px] rounded-full min-w-[16px] h-4 flex items-center justify-center px-1">
          {unread > 99 ? '99+' : unread}
        </span>
      ) : null}
    </NavLink>
  )
}

export default function Layout() {
  const { agent, logout, setStatus } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [unread, setUnread] = useState(0)
  const [statusOpen, setStatusOpen] = useState(false)
  const statusRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    const load = () =>
      api.statsOverview().then((s) => alive && setUnread(s.total_unread)).catch(() => {})
    load()
    const timer = setInterval(load, 30000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (statusRef.current && !statusRef.current.contains(e.target as Node)) setStatusOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  const curStatus = STATUS_MAP[agent?.status || 'offline']
  const { theme, toggle: toggleTheme } = useTheme()
  const onWorkbench = location.pathname === '/'

  return (
    <div className="h-full flex">
      <nav className="w-[64px] bg-gray-900 dark:bg-gray-950 dark:border-r dark:border-gray-800 flex flex-col items-center py-3 gap-0.5 shrink-0">
        <div
          className="w-10 h-10 rounded-xl bg-primary-600 flex items-center justify-center text-white mb-2"
          title="智能客服"
        >
          <Sparkles size={20} />
        </div>

        {CS_NAV.map((item) => (
          <NavItem
            key={item.path}
            {...item}
            unread={item.path === '/' ? unread : undefined}
            csActive
          />
        ))}

        <div className="w-8 border-t border-gray-700 my-1.5" />

        {MATRIX_NAV.map((item) => (
          <NavItem key={item.path} {...item} />
        ))}

        <NavItem path="/settings" label="设置" icon={SettingsIcon} csActive={onWorkbench} />

        <div className="flex-1" />

        <button
          onClick={toggleTheme}
          title={theme === 'dark' ? '切换到亮色' : '切换到暗色'}
          className="text-gray-500 hover:text-white mb-1"
        >
          {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
        </button>

        <div ref={statusRef} className="relative">
          {statusOpen && (
            <div className="absolute bottom-12 left-1/2 -translate-x-1/2 bg-white rounded-xl shadow-pop border py-1 w-28 z-50">
              {(['active', 'resting'] as const).map((s) => (
                <button
                  key={s}
                  onClick={async () => {
                    await setStatus(s)
                    setStatusOpen(false)
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-xs text-gray-600 hover:bg-gray-50"
                >
                  <span className={clsx('w-2 h-2 rounded-full', STATUS_MAP[s].color)} />
                  {STATUS_MAP[s].label}
                  {agent?.status === s && <span className="ml-auto text-primary-600">✓</span>}
                </button>
              ))}
            </div>
          )}
          <button
            onClick={() => setStatusOpen(!statusOpen)}
            title={`${agent?.display_name}（${curStatus.label}，点击切换）`}
            className="relative w-10 h-10 rounded-full bg-primary-500 text-white flex items-center justify-center text-sm font-medium"
          >
            {agent?.display_name?.slice(0, 1) || '客'}
            <span
              className={clsx(
                'absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-gray-900',
                curStatus.color,
              )}
            />
          </button>
        </div>
        <button
          onClick={() => {
            logout()
            navigate('/login')
          }}
          title="退出登录"
          className="text-gray-500 hover:text-white mt-1"
        >
          <LogOut size={16} />
        </button>
      </nav>

      <div className="flex-1 min-w-0">
        <Outlet />
      </div>
    </div>
  )
}
