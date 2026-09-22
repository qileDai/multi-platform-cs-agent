import clsx from 'clsx'
import { BookOpen, ClipboardList, PanelLeftOpen, Phone, Plus, Tag, UserPlus, X, Zap } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { api, Conversation, Message, QuickReply, RecallTestResult, Ticket } from '../api/client'
import { toast } from './ui/toast'

const TICKET_STATUS: Record<string, { label: string; cls: string }> = {
  open: { label: '待处理', cls: 'bg-orange-100 text-orange-600 dark:bg-orange-950 dark:text-orange-400' },
  processing: { label: '处理中', cls: 'bg-blue-100 text-blue-600 dark:bg-blue-950 dark:text-blue-400' },
  done: { label: '已完成', cls: 'bg-green-100 text-green-600 dark:bg-green-950 dark:text-green-400' },
}

const MODE_LABEL: Record<string, string> = {
  ai: 'AI 接待',
  human: '人工接待',
  pending: '排队中',
}

type DockTab = 'customer' | 'quick' | 'knowledge'

const DOCK_TABS: { key: DockTab; label: string }[] = [
  { key: 'customer', label: '客户' },
  { key: 'quick', label: '快捷' },
  { key: 'knowledge', label: '知识' },
]

interface Props {
  conversation: Conversation
  onRefresh: () => void
  collapsed: boolean
  onExpand: () => void
  onInsert: (text: string) => void
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <div className="text-[12px] text-gray-400 dark:text-gray-500 mb-2">{children}</div>
}

export default function CustomerPanel({ conversation, onRefresh, collapsed, onExpand, onInsert }: Props) {
  const [dockTab, setDockTab] = useState<DockTab>('customer')
  const [tickets, setTickets] = useState<Ticket[]>([])
  const [history, setHistory] = useState<Conversation[]>([])
  const [tagInput, setTagInput] = useState('')
  const [showTicket, setShowTicket] = useState(false)
  const [ticketType, setTicketType] = useState('other')
  const [ticketTitle, setTicketTitle] = useState('')
  const [ticketContent, setTicketContent] = useState('')
  const [quickReplies, setQuickReplies] = useState<QuickReply[]>([])
  const [suggest, setSuggest] = useState<RecallTestResult | null>(null)
  const [suggestLoading, setSuggestLoading] = useState(false)

  const loadSide = () => {
    api.ticketsByConversation(conversation.id).then(setTickets).catch(() => setTickets([]))
    if (conversation.customer?.id) {
      api.listCustomerConversations(conversation.customer.id).then(setHistory).catch(() => setHistory([]))
    }
    api.listQuickReplies().then(setQuickReplies).catch(() => setQuickReplies([]))
  }

  useEffect(() => {
    loadSide()
    setSuggest(null)
  }, [conversation.id])

  useEffect(() => {
    if (conversation.mode !== 'human' || conversation.status !== 'open') {
      setSuggest(null)
      return
    }
    let cancelled = false
    setSuggestLoading(true)
    api
      .listMessages(conversation.id)
      .then((msgs: Message[]) => {
        const lastUser = [...msgs].reverse().find((m) => m.sender_type === 'user' && !m.is_internal)
        if (!lastUser?.content) {
          if (!cancelled) setSuggest(null)
          return null
        }
        return api.recallTest(lastUser.content)
      })
      .then((r) => {
        if (!cancelled && r) setSuggest(r)
      })
      .catch(() => {
        if (!cancelled) setSuggest(null)
      })
      .finally(() => {
        if (!cancelled) setSuggestLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [conversation.id, conversation.mode, conversation.status, conversation.last_message_at])

  if (collapsed) {
    return (
      <div className="w-9 border-l dark:border-gray-700 bg-white dark:bg-gray-900 shrink-0 flex flex-col items-center pt-3">
        <button
          onClick={onExpand}
          title="展开右侧栏"
          className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
        >
          <PanelLeftOpen size={16} />
        </button>
      </div>
    )
  }

  const customer = conversation.customer
  const tags = customer?.tags || []
  const hasLead = !!(customer?.lead_phone || customer?.lead_wechat)
  const teamQuick = quickReplies.filter((q) => !q.agent_id)
  const mineQuick = quickReplies.filter((q) => q.agent_id)

  const saveTags = async (next: string[]) => {
    try {
      await api.updateTags(conversation.id, next)
      onRefresh()
    } catch (e: any) {
      toast.error(e?.message || '更新标签失败')
    }
  }

  const addTag = async () => {
    const t = tagInput.trim()
    if (!t || tags.includes(t)) return
    setTagInput('')
    await saveTags([...tags, t])
  }

  const createTicket = async () => {
    if (!ticketTitle.trim()) return
    try {
      await api.createTicket(conversation.id, ticketType, ticketTitle.trim(), ticketContent.trim())
      toast.success('工单已创建')
      setShowTicket(false)
      setTicketTitle('')
      setTicketContent('')
      loadSide()
    } catch (e: any) {
      toast.error(e?.message || '创建工单失败')
    }
  }

  return (
    <div className="w-[280px] border-l dark:border-gray-700 bg-white dark:bg-gray-900 flex flex-col shrink-0">
      <div className="flex border-b dark:border-gray-800">
        {DOCK_TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setDockTab(t.key)}
            className={clsx(
              'flex-1 py-2.5 text-[13px] font-medium relative',
              dockTab === t.key
                ? 'text-primary-600'
                : 'text-gray-500 dark:text-gray-400 hover:text-gray-700',
            )}
          >
            {t.label}
            {dockTab === t.key && (
              <span className="absolute bottom-0 left-3 right-3 h-0.5 bg-primary-600 rounded-full" />
            )}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        {dockTab === 'customer' && (
          <>
            <div className="p-4 border-b dark:border-gray-700">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-full bg-primary-50 text-primary-600 dark:bg-primary-900/40 dark:text-primary-300 flex items-center justify-center text-lg font-medium">
                  {(customer?.nickname || '访')[0]}
                </div>
                <div className="min-w-0">
                  <div className="font-medium text-sm text-gray-800 dark:text-gray-100 truncate">
                    {customer?.nickname || '访客'}
                  </div>
                  <div className="text-xs text-gray-400 dark:text-gray-500">
                    {customer?.platform === 'douyin' ? '抖音' : customer?.platform === 'xiaohongshu' ? '小红书' : '模拟'} 用户
                  </div>
                </div>
              </div>
              <div className="mt-3 text-[11px] text-gray-500 dark:text-gray-400 space-y-0.5">
                <div>接待模式：{MODE_LABEL[conversation.mode] || conversation.mode}</div>
                <div>接待人：{conversation.assignee_name || '未分配'}</div>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {tags.map((t) => (
                  <span
                    key={t}
                    className="inline-flex items-center gap-0.5 text-[10px] bg-primary-50 text-primary-700 dark:bg-primary-950 dark:text-primary-300 rounded-full px-2 py-0.5"
                  >
                    <Tag size={9} />
                    {t}
                    <button
                      title="删除标签"
                      onClick={() => saveTags(tags.filter((x) => x !== t))}
                      className="ml-0.5 hover:text-red-500"
                    >
                      <X size={9} />
                    </button>
                  </span>
                ))}
              </div>
              <div className="mt-2 flex gap-1">
                <input
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addTag())}
                  placeholder="添加标签"
                  className="flex-1 border dark:border-gray-700 dark:bg-gray-800 rounded-lg px-2 py-1 text-xs outline-none focus:border-primary-500"
                />
                <button onClick={addTag} className="text-xs px-2 rounded-lg bg-primary-50 text-primary-600">
                  添加
                </button>
              </div>
            </div>

            <div className="p-4 border-b dark:border-gray-700">
              <SectionTitle>留资信息</SectionTitle>
              {hasLead ? (
                <div className="bg-green-50 dark:bg-green-950/40 border border-green-200 dark:border-green-900 rounded-xl p-3 space-y-1.5">
                  {customer.lead_phone && (
                    <div className="flex items-center gap-2 text-sm">
                      <Phone size={13} className="text-green-600 dark:text-green-400" />
                      <span className="font-medium text-green-700 dark:text-green-300">{customer.lead_phone}</span>
                    </div>
                  )}
                  {customer.lead_wechat && (
                    <div className="flex items-center gap-2 text-sm">
                      <UserPlus size={13} className="text-green-600 dark:text-green-400" />
                      <span className="font-medium text-green-700 dark:text-green-300">{customer.lead_wechat}</span>
                    </div>
                  )}
                  {customer.lead_note && (
                    <div className="text-xs text-green-600/80 dark:text-green-400/70 pt-1 border-t border-green-100 dark:border-green-900">
                      {customer.lead_note}
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-xs text-gray-300 dark:text-gray-600 bg-gray-50 dark:bg-gray-800 rounded-xl p-3 text-center">
                  暂未留资
                </div>
              )}
              {customer?.created_at && (
                <div className="text-xs text-gray-400 dark:text-gray-500 mt-2">
                  首次咨询：{new Date(customer.created_at).toLocaleDateString('zh-CN')}
                </div>
              )}
            </div>

            <div className="p-4 border-b dark:border-gray-700">
              <div className="flex items-center justify-between mb-2">
                <SectionTitle>
                  <span className="inline-flex items-center gap-1">
                    <ClipboardList size={12} />
                    关联工单
                  </span>
                </SectionTitle>
                <button
                  onClick={() => setShowTicket(!showTicket)}
                  className="text-[11px] text-primary-600 inline-flex items-center gap-0.5 -mt-2"
                >
                  <Plus size={11} /> 创建工单
                </button>
              </div>
              {showTicket && (
                <div className="mb-3 space-y-1.5 bg-gray-50 dark:bg-gray-800 rounded-xl p-2.5">
                  <select
                    value={ticketType}
                    onChange={(e) => setTicketType(e.target.value)}
                    className="w-full text-xs border dark:border-gray-700 dark:bg-gray-900 rounded px-2 py-1"
                  >
                    <option value="refund">退款退货</option>
                    <option value="logistics">物流异常</option>
                    <option value="other">其他</option>
                  </select>
                  <input
                    value={ticketTitle}
                    onChange={(e) => setTicketTitle(e.target.value)}
                    placeholder="工单标题"
                    className="w-full text-xs border dark:border-gray-700 dark:bg-gray-900 rounded px-2 py-1 outline-none"
                  />
                  <textarea
                    value={ticketContent}
                    onChange={(e) => setTicketContent(e.target.value)}
                    placeholder="补充说明（可选）"
                    rows={2}
                    className="w-full text-xs border dark:border-gray-700 dark:bg-gray-900 rounded px-2 py-1 outline-none"
                  />
                  <button onClick={createTicket} className="w-full text-xs bg-primary-600 text-white rounded py-1.5">
                    保存工单
                  </button>
                </div>
              )}
              {tickets.length === 0 && !showTicket ? (
                <div className="text-xs text-gray-300 dark:text-gray-600 bg-gray-50 dark:bg-gray-800 rounded-xl p-3 text-center">
                  暂无工单
                </div>
              ) : (
                tickets.map((t) => {
                  const st = TICKET_STATUS[t.status] || TICKET_STATUS.open
                  return (
                    <div key={t.id} className="bg-gray-50 dark:bg-gray-800 rounded-xl p-3 mb-2">
                      <div className="text-sm font-medium text-gray-800 dark:text-gray-100">{t.title}</div>
                      <div className="flex items-center gap-2 mt-1.5">
                        <span className={clsx('text-[10px] px-1.5 py-0.5 rounded', st.cls)}>{st.label}</span>
                        <span className="text-xs text-gray-400 dark:text-gray-500">
                          {new Date(t.created_at).toLocaleDateString('zh-CN')}
                        </span>
                      </div>
                    </div>
                  )
                })
              )}
            </div>

            <div className="p-4">
              <SectionTitle>历史会话</SectionTitle>
              {history.filter((h) => h.id !== conversation.id).length === 0 ? (
                <div className="text-xs text-gray-300 dark:text-gray-600 text-center py-2">暂无其他会话</div>
              ) : (
                history
                  .filter((h) => h.id !== conversation.id)
                  .map((h) => (
                    <div key={h.id} className="text-xs bg-gray-50 dark:bg-gray-800 rounded-lg px-2.5 py-2 mb-1.5">
                      <div className="flex justify-between text-gray-600 dark:text-gray-300">
                        <span>{MODE_LABEL[h.mode] || h.mode}</span>
                        <span className="text-gray-400">{new Date(h.last_message_at).toLocaleDateString('zh-CN')}</span>
                      </div>
                      <div className="text-gray-400 truncate mt-0.5">{h.last_message?.content || h.summary || '无消息'}</div>
                    </div>
                  ))
              )}
            </div>
          </>
        )}

        {dockTab === 'quick' && (
          <div className="p-3 space-y-4">
            <QuickGroup title="团队" icon={<Zap size={12} />} items={teamQuick} onInsert={onInsert} />
            <QuickGroup title="我的" icon={<Zap size={12} />} items={mineQuick} onInsert={onInsert} />
          </div>
        )}

        {dockTab === 'knowledge' && (
          <div className="p-3">
            <SectionTitle>
              <span className="inline-flex items-center gap-1">
                <BookOpen size={12} />
                召回建议
              </span>
            </SectionTitle>
            {conversation.mode !== 'human' || conversation.status !== 'open' ? (
              <div className="text-xs text-gray-400 bg-gray-50 dark:bg-gray-800 rounded-xl p-3 text-center">
                人工接待时显示知识建议
              </div>
            ) : suggestLoading ? (
              <div className="text-xs text-gray-400 text-center py-6">正在检索…</div>
            ) : !suggest ? (
              <div className="text-xs text-gray-400 text-center py-6">暂无用户消息可检索</div>
            ) : (
              <div className="space-y-1.5">
                {!suggest.passed && (
                  <div className="text-[12px] text-orange-500 px-0.5">无可靠知识，请人工作答</div>
                )}
                {suggest.hits.map((hit, i) => (
                  <button
                    key={i}
                    onClick={() => onInsert(hit.content)}
                    className="w-full text-left text-xs bg-gray-50 dark:bg-gray-800 border dark:border-gray-700 rounded-lg px-2 py-1.5 hover:border-primary-400"
                  >
                    <div className="text-[10px] text-gray-400 mb-0.5">
                      {hit.source}
                      {hit.score != null && <span className="ml-2 font-mono">{hit.score.toFixed(2)}</span>}
                    </div>
                    <div className="text-gray-700 dark:text-gray-200 line-clamp-3">{hit.content}</div>
                  </button>
                ))}
                {!suggest.passed && suggest.hits.length === 0 && (
                  <div className="text-[11px] text-orange-500">未过阈值，不要把不确定的知识发给用户。</div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function QuickGroup({
  title,
  icon,
  items,
  onInsert,
}: {
  title: string
  icon: ReactNode
  items: QuickReply[]
  onInsert: (text: string) => void
}) {
  return (
    <div>
      <div className="text-[12px] text-gray-400 mb-1.5 flex items-center gap-1">
        {icon}
        {title}
      </div>
      {items.length === 0 ? (
        <div className="text-xs text-gray-300 dark:text-gray-600 px-1 py-2">暂无模板</div>
      ) : (
        items.map((qr) => (
          <button
            key={qr.id}
            onClick={() => onInsert(qr.content)}
            className="w-full text-left px-2 py-2 rounded-lg hover:bg-primary-50 dark:hover:bg-primary-900/20 mb-0.5"
          >
            <div className="text-[12px] font-medium text-primary-700 dark:text-primary-300">{qr.title}</div>
            <div className="text-[11px] text-gray-500 dark:text-gray-400 line-clamp-2 mt-0.5">{qr.content}</div>
          </button>
        ))
      )}
    </div>
  )
}
