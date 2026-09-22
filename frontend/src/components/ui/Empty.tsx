/** 空状态：图标 + 标题 + 引导文案 */
import { Inbox, LucideIcon } from 'lucide-react'

interface Props {
  icon?: LucideIcon
  title: string
  hint?: string
}

export default function Empty({ icon: Icon = Inbox, title, hint }: Props) {
  return (
    <div className="flex flex-col items-center justify-center py-14 text-center">
      <div className="w-12 h-12 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center text-gray-300 dark:text-gray-600">
        <Icon size={22} />
      </div>
      <div className="text-sm text-gray-400 dark:text-gray-500 mt-3">{title}</div>
      {hint && <div className="text-xs text-gray-300 dark:text-gray-600 mt-1">{hint}</div>}
    </div>
  )
}
