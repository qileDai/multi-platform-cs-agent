import clsx from 'clsx'
import { Filter, Search } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Conversation } from '../api/client'
import { useAuth } from '../store'

export type InboxTab = 'mine' | 'pending' | 'active' | 'closed'

const TABS: { key: InboxTab; label: string }[] = [
  { key: 'mine', label: '我的对话' },
  { key: 'pending', label: '排队' },
  { key: 'active', label: '同事' },
  { key: 'closed', label: '已结束' },
]

const PLATFORM_FILTERS = [
  { value: '', label: '全部平台' },
  { value: 'douyin', label: '抖音' },
  { value: 'xiaohongshu', label: '小红书' },
  { value: 'mock', label: '模拟' },
]

const PLATFORM_LABEL: Record<string, string> = {
  douyin: '抖音',
  xiaohongshu: '小红书',
  mock: '模拟',
}

const PLATFORM_COLOR: Record<string, string> = {
  douyin: '#161823',
  xiaohongshu: '#ff2442',
  mock: '#00b8a9',
}

function waitLabel(seconds: number) {
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m`
}

export default function ConversationList({
  conversations,
  currentId,
  onSelect,
  tab,
  onTabChange,
  platform,
  onPlatformChange,
  counts,
  width,
}: {
  conversations: Conversation[]
  currentId: number | null
  onSelect: (id: number) => void
  tab: InboxTab
  onTabChange: (t: InboxTab) => void
  platform: string
  onPlatformChange: (p: string) => void
  counts: Record<string, number>
  width: number
}) {
  const { agent } = useAuth()
  const [q, setQ] = useState('')
  const [filterOpen, setFilterOpen] = useState(false)
  const filterRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) setFilterOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  const filtered = conversations.filter((c) => {
    if (!q) return true
    const hay = `${c.customer.nickname} ${c.last_message?.content || ''} ${c.summary}`
    return hay.toLowerCase().includes(q.toLowerCase())
  })

  return (
    <div className="border-r dark:border-gray-800 flex flex-col bg-white dark:bg-gray-900 shrink-0" style={{ width }}>
      <div className="flex border-b dark:border-gray-800">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => onTabChange(t.key)}
            className={clsx(
              'flex-1 py-2.5 text-[12px] font-medium relative',
              tab === t.key
                ? 'text-primary-600'
                : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200',
            )}
          >
            {t.label}
            {(counts[t.key] || 0) > 0 && (
              <span
                className={clsx(
                  'ml-0.5 text-[10px]',
                  t.key === 'pending' ? 'text-orange-500' : 'text-gray-400',
                )}
              >
                {counts[t.key]}
              </span>
            )}
            {tab === t.key && (
              <span className="absolute bottom-0 left-2 right-2 h-0.5 bg-primary-600 rounded-full" />
            )}
          </button>
        ))}
      </div>

      <div className="px-2.5 py-2 flex items-center gap-1.5">
        <div className="flex-1 flex items-center gap-1.5 bg-gray-100 dark:bg-gray-800 rounded-lg px-2 py-1.5">
          <Search size={13} className="text-gray-400 shrink-0" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索对话"
            className="flex-1 bg-transparent text-[12px] outline-none text-gray-700 dark:text-gray-200 placeholder:text-gray-400"
          />
        </div>
        <div ref={filterRef} className="relative">
          <button
            onClick={() => setFilterOpen((v) => !v)}
            title="平台筛选"
            className={clsx(
              'w-8 h-8 rounded-lg flex items-center justify-center',
              platform
                ? 'bg-primary-50 text-primary-600 dark:bg-primary-600/20'
                : 'text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800',
            )}
          >
            <Filter size={14} />
          </button>
          {filterOpen && (
            <div className="absolute right-0 top-9 z-20 w-28 bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-lg shadow-pop py-1">
              {PLATFORM_FILTERS.map((p) => (
                <button
                  key={p.value || 'all'}
                  onClick={() => {
                    onPlatformChange(p.value)
                    setFilterOpen(false)
                  }}
                  className={clsx(
                    'w-full text-left px-3 py-1.5 text-[12px]',
                    platform === p.value
                      ? 'text-primary-600 bg-primary-50 dark:bg-primary-600/10'
                      : 'text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700',
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 && (
          <div className="text-center text-gray-400 text-xs py-10">暂无会话</div>
        )}
        {filtered.map((c) => {
          const selected = c.id === currentId
          const mine = agent && c.assignee_id === agent.id
          const wait = c.awaiting_first_response && (c.wait_seconds || 0) > 0
          const closed = c.status === 'closed'
          const platformColor = PLATFORM_COLOR[c.platform] || '#00b8a9'
          const tags = c.customer.tags || []
          return (
            <button
              key={c.id}
              onClick={() => onSelect(c.id)}
              className={clsx(
                'w-full text-left px-3 py-2 border-b dark:border-gray-800/80 relative',
                selected
                  ? 'bg-primary-50 dark:bg-primary-600/15'
                  : 'hover:bg-gray-50 dark:hover:bg-gray-800/60',
                c.overdue && !selected && 'bg-red-50/70 dark:bg-red-950/20',
              )}
            >
              {selected && (
                <span className="absolute left-0 top-0 bottom-0 w-[3px] bg-primary-600" />
              )}
              <div className="flex items-start gap-2">
                <div className="relative shrink-0">
                  {c.customer.avatar ? (
                    <img
                      src={c.customer.avatar}
                      alt=""
                      className={clsx(
                        'w-9 h-9 rounded-full object-cover',
                        closed && 'grayscale opacity-70',
                      )}
                    />
                  ) : (
                    <div
                      className={clsx(
                        'w-9 h-9 rounded-full flex items-center justify-center text-white text-sm font-medium',
                        closed && 'grayscale opacity-70',
                      )}
                      style={{ background: platformColor }}
                    >
                      {c.customer.nickname?.slice(0, 1) || '?'}
                    </div>
                  )}
                  {c.unread_count > 0 && (
                    <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] px-0.5 bg-red-500 text-white text-[9px] rounded-full flex items-center justify-center leading-none">
                      {c.unread_count > 99 ? '99+' : c.unread_count}
                    </span>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1">
                    <span className="text-[13px] font-medium text-gray-800 dark:text-gray-100 truncate">
                      {c.customer.nickname}
                    </span>
                    {c.is_returning && (
                      <span className="text-[9px] px-1 py-px rounded bg-amber-50 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400 shrink-0">
                        回头客
                      </span>
                    )}
                    {c.transferred_in && (
                      <span className="text-[9px] px-1 py-px rounded bg-primary-50 text-primary-600 shrink-0">
                        转入
                      </span>
                    )}
                    <span className="ml-auto text-[10px] text-gray-400 shrink-0">
                      {new Date(c.last_message_at).toLocaleTimeString('zh-CN', {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  </div>
                  <div className="flex items-center gap-1 mt-0.5">
                    <span className="text-[10px] text-gray-400">{PLATFORM_LABEL[c.platform]}</span>
                    {c.mode === 'ai' && (
                      <span className="text-[10px] text-primary-600">AI</span>
                    )}
                    {c.mode === 'pending' && (
                      <span className="text-[10px] px-1 rounded bg-orange-100 text-orange-600 dark:bg-orange-900/40 dark:text-orange-300">
                        排队
                      </span>
                    )}
                    {c.assignee_name && c.mode === 'human' && !mine && (
                      <span className="text-[10px] text-gray-400 truncate">{c.assignee_name}</span>
                    )}
                    {wait && (
                      <span
                        className={clsx(
                          'ml-auto text-[10px] tabular-nums',
                          c.overdue ? 'text-red-500 font-medium' : 'text-gray-400',
                        )}
                      >
                        {waitLabel(c.wait_seconds || 0)}
                      </span>
                    )}
                  </div>
                  <div className="text-[12px] text-gray-500 dark:text-gray-400 truncate mt-0.5">
                    {c.last_message?.content || '暂无消息'}
                  </div>
                  {tags.length > 0 && (
                    <div className="flex gap-1 mt-1 overflow-hidden [mask-image:linear-gradient(to_right,black_70%,transparent)]">
                      {tags.slice(0, 3).map((t) => (
                        <span
                          key={t}
                          className="text-[9px] px-1 py-px rounded bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400 shrink-0"
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
