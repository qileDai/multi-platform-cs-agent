import clsx from 'clsx'
import dayjs from 'dayjs'
import { Contact } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { api, LeadCapture } from '../api/client'
import LeadConversationModal from '../components/LeadConversationModal'
import Empty from '../components/ui/Empty'
import Skeleton from '../components/ui/Skeleton'

const PLATFORM: Record<string, { label: string; cls: string }> = {
  douyin: { label: '抖音', cls: 'bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900' },
  xiaohongshu: { label: '小红书', cls: 'bg-red-50 text-red-600 dark:bg-red-900/40 dark:text-red-400' },
  mock: { label: '模拟', cls: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400' },
}

const TYPE: Record<string, { label: string; cls: string }> = {
  phone: { label: '电话', cls: 'bg-blue-50 text-blue-600 dark:bg-blue-900/40 dark:text-blue-400' },
  wechat: { label: '微信', cls: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-900/40 dark:text-emerald-400' },
}

function Badge({ label, cls }: { label: string; cls: string }) {
  return (
    <span className={clsx('inline-flex text-xs rounded px-2 py-0.5 whitespace-nowrap', cls)}>
      {label}
    </span>
  )
}

export default function Leads() {
  const [q, setQ] = useState('')
  const [platform, setPlatform] = useState('')
  const [items, setItems] = useState<LeadCapture[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [viewing, setViewing] = useState<LeadCapture | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api.listLeads(q.trim(), platform, page)
      setItems(data.items)
      setTotal(data.total)
    } finally {
      setLoading(false)
    }
  }, [q, platform, page])

  useEffect(() => {
    load()
  }, [load])

  const totalPages = Math.max(1, Math.ceil(total / 20))

  return (
    <div className="h-full flex flex-col bg-gray-50 dark:bg-gray-950">
      <div className="bg-white dark:bg-gray-900 border-b dark:border-gray-700 px-6 py-4">
        <div className="flex items-baseline gap-2">
          <h1 className="text-lg font-medium text-gray-800 dark:text-gray-100">留资</h1>
          <span className="text-xs text-gray-400 dark:text-gray-500">{total} 条</span>
        </div>
        <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">顾客留下的电话和微信，可按平台、联系方式、业务搜索</p>
        <div className="mt-3 flex gap-2">
          <input
            value={q}
            onChange={(e) => { setPage(1); setQ(e.target.value) }}
            placeholder="搜索联系方式、昵称、业务"
            className="flex-1 max-w-md text-sm px-3 py-1.5 rounded-lg border dark:border-gray-700 bg-transparent"
          />
          <select
            value={platform}
            onChange={(e) => { setPage(1); setPlatform(e.target.value) }}
            className="text-sm px-2 py-1.5 rounded-lg border dark:border-gray-700 bg-white dark:bg-gray-900"
          >
            <option value="">全部平台</option>
            <option value="douyin">抖音</option>
            <option value="xiaohongshu">小红书</option>
          </select>
        </div>
      </div>
      <div className="flex-1 overflow-auto px-6 py-6">
        {loading ? (
          <Skeleton rows={6} className="max-w-5xl" />
        ) : items.length === 0 ? (
          <Empty icon={Contact} title="还没有留资" hint="顾客留下电话或微信后会出现在这里" />
        ) : (
          <div className="bg-white dark:bg-gray-900 rounded-card shadow-card overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-400 border-b dark:border-gray-700">
                  <th className="px-4 py-3 font-normal">时间</th>
                  <th className="px-4 py-3 font-normal">平台</th>
                  <th className="px-4 py-3 font-normal">昵称</th>
                  <th className="px-4 py-3 font-normal">联系方式</th>
                  <th className="px-4 py-3 font-normal">类型</th>
                  <th className="px-4 py-3 font-normal">要办的业务</th>
                  <th className="px-4 py-3 font-normal text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {items.map((row) => {
                  const platformBadge = PLATFORM[row.platform]
                  const typeBadge = TYPE[row.contact_type]
                  return (
                    <tr key={row.id} className="border-b border-gray-50 dark:border-gray-800 last:border-0">
                      <td className="px-4 py-3 text-gray-400 whitespace-nowrap">
                        {dayjs(row.created_at).format('MM-DD HH:mm')}
                      </td>
                      <td className="px-4 py-3">
                        {platformBadge ? (
                          <Badge label={platformBadge.label} cls={platformBadge.cls} />
                        ) : (
                          <span className="text-gray-500">{row.platform || '—'}</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-500">{row.nickname || '—'}</td>
                      <td className="px-4 py-3 font-medium text-gray-800 dark:text-gray-100 whitespace-nowrap">
                        {row.contact}
                      </td>
                      <td className="px-4 py-3">
                        {typeBadge ? (
                          <Badge label={typeBadge.label} cls={typeBadge.cls} />
                        ) : (
                          <span className="text-gray-500">{row.contact_type || '—'}</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-500">{row.business || '—'}</td>
                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          disabled={!row.conversation_id}
                          onClick={() => setViewing(row)}
                          className="text-xs text-blue-600 hover:underline px-2 py-1.5 disabled:opacity-30 disabled:no-underline disabled:cursor-not-allowed"
                        >
                          查看会话 →
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {totalPages > 1 && (
          <div className="flex gap-2 mt-6 justify-center">
            <button
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
              className="text-xs border rounded px-3 py-1.5 disabled:opacity-30"
            >
              上一页
            </button>
            <span className="text-xs text-gray-400 py-1.5">
              {page} / {totalPages}
            </span>
            <button
              disabled={page >= totalPages}
              onClick={() => setPage(page + 1)}
              className="text-xs border rounded px-3 py-1.5 disabled:opacity-30"
            >
              下一页
            </button>
          </div>
        )}
      </div>
      {viewing && <LeadConversationModal lead={viewing} onClose={() => setViewing(null)} />}
    </div>
  )
}
