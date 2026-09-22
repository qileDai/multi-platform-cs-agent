import clsx from 'clsx'
import dayjs from 'dayjs'
import { ClipboardList } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, Ticket } from '../api/client'
import Empty from '../components/ui/Empty'
import Skeleton from '../components/ui/Skeleton'
import { toast } from '../components/ui/toast'
import { subscribeWs } from '../store'

const STATUS_TABS = [
  { key: '', label: '全部' },
  { key: 'open', label: '待处理' },
  { key: 'processing', label: '处理中' },
  { key: 'done', label: '已完成' },
]

const TYPE_LABEL: Record<string, string> = {
  refund: '退款退货',
  logistics: '物流异常',
  other: '其他',
}

const STATUS_STYLE: Record<string, { label: string; cls: string }> = {
  open: { label: '待处理', cls: 'bg-orange-100 text-orange-600' },
  processing: { label: '处理中', cls: 'bg-blue-100 text-blue-600' },
  done: { label: '已完成', cls: 'bg-green-100 text-green-600' },
}

export default function Tickets() {
  const [tab, setTab] = useState('')
  const [tickets, setTickets] = useState<Ticket[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [agents, setAgents] = useState<{ id: number; display_name: string }[]>([])
  const navigate = useNavigate()

  const load = useCallback(async () => {
    const data = await api.listTickets(tab, page)
    setTickets(data.items)
    setTotal(data.total)
    setLoading(false)
  }, [tab, page])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    api.listAgents().then(setAgents).catch(() => setAgents([]))
  }, [])

  // AI 工具自动建单时实时刷新
  useEffect(
    () =>
      subscribeWs((event) => {
        if (event === 'ticket_created') load()
      }),
    [load],
  )

  const setStatus = async (ticket: Ticket, status: string) => {
    await api.updateTicketStatus(ticket.id, status)
    toast.success(`工单 ${ticket.ticket_no} 已更新为「${STATUS_STYLE[status]?.label || status}」`)
    load()
  }

  const totalPages = Math.max(1, Math.ceil(total / 20))

  return (
    <div className="h-full flex flex-col bg-gray-50 dark:bg-gray-950">
      <div className="bg-white dark:bg-gray-900 border-b dark:border-gray-700 px-6 py-4">
        <h1 className="text-lg font-medium text-gray-800 dark:text-gray-100">工单管理</h1>
        <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">AI 自动创建或客服手动创建的售后/物流工单</p>
      </div>

      {/* 状态筛选 */}
      <div className="bg-white dark:bg-gray-900 border-b dark:border-gray-700 px-6 flex gap-1">
        {STATUS_TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => {
              setTab(t.key)
              setPage(1)
            }}
            className={clsx(
              'px-4 py-2.5 text-sm border-b-2 -mb-px transition-colors',
              tab === t.key
                ? 'border-blue-600 text-blue-600 dark:text-blue-400 dark:border-blue-400 font-medium'
                : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* 工单列表 */}
      <div className="flex-1 overflow-y-auto p-6">
        {loading ? (
          <Skeleton rows={4} className="max-w-4xl" />
        ) : tickets.length === 0 ? (
          <Empty
            icon={ClipboardList}
            title="暂无工单"
            hint="AI 识别到退款/物流等诉求时会自动建单"
          />
        ) : null}
        <div className="space-y-3 max-w-4xl">
          {tickets.map((ticket) => (
            <div key={ticket.id} className="bg-white dark:bg-gray-900 rounded-card shadow-card p-4">
              <div className="flex items-center gap-3">
                <span className="text-xs font-mono text-gray-400">{ticket.ticket_no}</span>
                <span className="text-xs bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400 rounded px-2 py-0.5">
                  {TYPE_LABEL[ticket.type] || ticket.type}
                </span>
                <span
                  className={clsx(
                    'text-xs rounded px-2 py-0.5',
                    STATUS_STYLE[ticket.status]?.cls,
                  )}
                >
                  {STATUS_STYLE[ticket.status]?.label || ticket.status}
                </span>
                <span className="flex-1" />
                <span className="text-xs text-gray-400">
                  {dayjs(ticket.updated_at).format('MM-DD HH:mm')}
                </span>
              </div>
              <div className="mt-2 font-medium text-gray-800 dark:text-gray-100 text-sm">{ticket.title}</div>
              {ticket.assignee_name && (
                <div className="text-[11px] text-gray-400 mt-0.5">负责人：{ticket.assignee_name}</div>
              )}
              {ticket.content && (
                <div className="mt-1 text-xs text-gray-500 dark:text-gray-400 leading-relaxed">{ticket.content}</div>
              )}
              <div className="mt-3 flex items-center gap-2">
                {ticket.status === 'open' && (
                  <button
                    onClick={() => setStatus(ticket, 'processing')}
                    className="text-xs bg-yellow-500 text-white rounded px-3 py-1.5 hover:bg-yellow-600"
                  >
                    开始处理
                  </button>
                )}
                {ticket.status === 'processing' && (
                  <button
                    onClick={() => setStatus(ticket, 'done')}
                    className="text-xs bg-green-500 text-white rounded px-3 py-1.5 hover:bg-green-600"
                  >
                    标记完成
                  </button>
                )}
                {ticket.status === 'done' && (
                  <button
                    onClick={() => setStatus(ticket, 'open')}
                    className="text-xs bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400 rounded px-3 py-1.5 hover:bg-gray-200 dark:hover:bg-gray-700"
                  >
                    重新打开
                  </button>
                )}
                {ticket.status !== 'done' && (
                  <select
                    value={ticket.assignee_id || ''}
                    onChange={async (e) => {
                      const id = Number(e.target.value)
                      if (!id) return
                      await api.assignTicket(ticket.id, id)
                      toast.success('工单已指派')
                      load()
                    }}
                    className="text-xs border dark:border-gray-700 dark:bg-gray-800 rounded px-2 py-1.5"
                  >
                    <option value="">指派给…</option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>{a.display_name}</option>
                    ))}
                  </select>
                )}
                <button
                  onClick={() => navigate('/', { state: { conversationId: ticket.conversation_id } })}
                  className="text-xs text-blue-600 hover:underline px-2 py-1.5"
                >
                  查看会话 →
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* 分页 */}
        {totalPages > 1 && (
          <div className="flex gap-2 mt-6 max-w-4xl justify-center">
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
    </div>
  )
}
