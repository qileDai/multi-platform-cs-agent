import clsx from 'clsx'
import { ClipboardList, Plug, Sparkles, Users } from 'lucide-react'
import { NavLink, Outlet } from 'react-router-dom'
import { useAuth } from '../../store'

const NAV = [
  { to: '/settings/service', label: '接待', icon: Users },
  { to: '/settings/automation', label: '自动化', icon: Sparkles },
  { to: '/settings/channels', label: '通道', icon: Plug },
  { to: '/settings/ops', label: '运维', icon: ClipboardList, admin: true },
] as const

export default function SettingsLayout() {
  const { agent } = useAuth()
  const items = NAV.filter((item) => !('admin' in item && item.admin) || agent?.role === 'admin')

  return (
    <div className="h-full flex bg-gray-50 dark:bg-gray-950">
      <div className="w-36 shrink-0 border-r dark:border-gray-700 bg-white dark:bg-gray-900 py-6 px-3">
        <h1 className="text-base font-semibold text-gray-800 dark:text-gray-100 px-2 mb-4">设置</h1>
        {items.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              clsx(
                'w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-xs transition-colors',
                isActive
                  ? 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-100'
                  : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-800 dark:hover:text-gray-100',
              )
            }
          >
            <item.icon size={13} />
            {item.label}
          </NavLink>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto p-6">
        <Outlet />
      </div>
    </div>
  )
}
