import clsx from 'clsx'
import {
  AlertCircle,
  ArrowLeftRight,
  Ban,
  Bot,
  CheckCheck,
  ChevronDown,
  ChevronUp,
  Clock,
  Flag,
  Handshake,
  Image as ImageIcon,
  ImagePlus,
  Mic,
  PanelRightClose,
  PanelRightOpen,
  PhoneOff,
  Smile,
  StickyNote,
  User,
  UserCheck,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Agent, api, Conversation, mediaUrl, Message, QuickReply } from '../api/client'
import { subscribeWs, useAuth } from '../store'
import { promptDialog } from './ui/dialogs'
import { toast } from './ui/toast'

const PLATFORM_LABEL: Record<string, string> = {
  douyin: '抖音',
  xiaohongshu: '小红书',
  mock: '模拟',
}

const MODE_TEXT: Record<string, string> = {
  ai: 'AI 接待中',
  pending: '排队待人工',
  human: '人工接待中',
}

const OUTBOX_STATUS: Record<string, { label: string; cls: string; icon: typeof Clock }> = {
  pending: { label: '已入队', cls: 'text-gray-400', icon: Clock },
  leased: { label: '发送中', cls: 'text-primary-500', icon: Clock },
  acked: { label: '已送达', cls: 'text-green-500', icon: CheckCheck },
  failed: { label: '发送失败', cls: 'text-red-500', icon: AlertCircle },
  discarded: { label: '已忽略', cls: 'text-gray-300 dark:text-gray-600', icon: Ban },
}

const EMOJIS = ['😊', '👍', '🙏', '❤️', '😄', '😢', '😮', '🎉']

function formatTick(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const hm = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) return hm
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return `昨天 ${hm}`
  return `${d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })} ${hm}`
}

const TICK_GAP_MS = 5 * 60 * 1000

interface Props {
  conversation: Conversation
  onRefresh: () => void
  panelCollapsed: boolean
  onTogglePanel: () => void
  draft: string
  onDraftChange: (text: string) => void
}

export default function ChatWindow({
  conversation,
  onRefresh,
  panelCollapsed,
  onTogglePanel,
  draft,
  onDraftChange,
}: Props) {
  const navigate = useNavigate()
  const { agent: me } = useAuth()
  const [messages, setMessages] = useState<Message[]>([])
  const [sending, setSending] = useState(false)
  const [quickReplies, setQuickReplies] = useState<QuickReply[]>([])
  const [summaryOpen, setSummaryOpen] = useState(false)
  const [noteMode, setNoteMode] = useState(false)
  const [aiTyping, setAiTyping] = useState(false)
  const [agents, setAgents] = useState<Agent[]>([])
  const [showTransfer, setShowTransfer] = useState(false)
  const [transferId, setTransferId] = useState(0)
  const [transferNote, setTransferNote] = useState('')
  const [showEmoji, setShowEmoji] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const typingTimer = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => {
    setSummaryOpen(false)
    setAiTyping(false)
    setNoteMode(false)
    setShowEmoji(false)
    api.listMessages(conversation.id).then(setMessages)
    api.listQuickReplies().then(setQuickReplies)
    api.listAgents().then(setAgents).catch(() => setAgents([]))
  }, [conversation.id])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, aiTyping])

  useEffect(() => {
    return subscribeWs((event, data) => {
      if (data.conversation_id !== conversation.id) return
      if (event === 'new_message') {
        setMessages((prev) => {
          if (prev.some((m) => m.id === data.message.id)) return prev
          return [...prev, data.message]
        })
        if (data.message.sender_type === 'ai') {
          setAiTyping(false)
          clearTimeout(typingTimer.current)
        }
      }
      if (event === 'ai_typing') {
        setAiTyping(true)
        clearTimeout(typingTimer.current)
        typingTimer.current = setTimeout(() => setAiTyping(false), 30000)
      }
    })
  }, [conversation.id])

  const send = async (override?: string) => {
    const text = (override ?? draft).trim()
    if (!text || sending) return
    setSending(true)
    try {
      const msg = await api.reply(conversation.id, text, noteMode)
      if (msg) setMessages((prev) => [...prev, msg])
      onDraftChange('')
    } catch (e: any) {
      toast.error(e?.message || '发送失败，请稍后重试')
    } finally {
      setSending(false)
    }
  }

  const sendImage = async (file: File) => {
    try {
      const { media_id } = await api.uploadMedia(file, 'image')
      const msg = await api.reply(conversation.id, '[图片]', false, 'image', media_id)
      if (msg) setMessages((prev) => [...prev, msg])
    } catch (e: any) {
      toast.error(e?.message || '图片发送失败')
    }
  }

  const toggleMode = async () => {
    const newMode = conversation.mode === 'human' ? 'ai' : 'human'
    await api.setMode(conversation.id, newMode)
    onRefresh()
    toast.success(newMode === 'human' ? '已接管，进入人工接待' : '已释放，恢复 AI 接待')
  }

  const claim = async () => {
    if (!me) return
    await api.assign(conversation.id, me.id)
    onRefresh()
    toast.success('已接单')
  }

  const submitTransfer = async () => {
    if (!transferId) return
    await api.assign(conversation.id, transferId, transferNote)
    setShowTransfer(false)
    setTransferNote('')
    onRefresh()
    toast.success('已转接')
  }

  const closeConv = async () => {
    await api.close(conversation.id)
    onRefresh()
    toast.info('会话已结束')
  }

  const markBadCase = async (messageId: number) => {
    const note = await promptDialog({
      title: '标记 badcase',
      placeholder: '备注问题原因（可选），如：答非所问 / 幻觉 / 语气生硬',
      confirmText: '标记',
    })
    if (note === null) return
    await api.markBadCase(messageId, true, note)
    setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, bad_case: true } : m)))
    toast.success('已标记为 badcase，可在设置页导出')
  }

  const hashQuery = draft.match(/(?:^|\s)#([^\s#]*)$/)
  const hashHits = hashQuery
    ? quickReplies.filter((q) => {
        const kw = (hashQuery[1] || '').toLowerCase()
        return !kw || q.title.toLowerCase().includes(kw) || q.content.toLowerCase().includes(kw)
      })
    : []

  const iconBtn =
    'p-1.5 rounded-lg text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800 hover:text-gray-800 dark:hover:text-gray-100'

  return (
    <div className="flex-1 flex flex-col h-full min-w-0 bg-white dark:bg-gray-900">
      <div className="border-b dark:border-gray-700 px-4 py-2 flex items-center gap-3">
        <div className="w-8 h-8 rounded-full bg-primary-500 text-white flex items-center justify-center text-sm font-medium shrink-0">
          {(conversation.customer?.nickname || '访').slice(0, 1)}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm text-gray-800 dark:text-gray-100 truncate">
              {conversation.customer?.nickname || '访客'}
            </span>
            {conversation.status === 'closed' && (
              <span className="text-[10px] text-gray-400">已结束</span>
            )}
          </div>
          <div className="text-[11px] text-gray-400 truncate">
            {PLATFORM_LABEL[conversation.platform] || conversation.platform}
            {conversation.assignee_name ? ` · 接待：${conversation.assignee_name}` : ''}
          </div>
        </div>
        {conversation.status === 'open' && (
          <div className="flex items-center gap-0.5">
            {conversation.mode === 'pending' && (
              <button onClick={claim} title="接单" className={clsx(iconBtn, 'text-orange-500 hover:bg-orange-50')}>
                <Handshake size={16} />
              </button>
            )}
            {conversation.mode === 'human' && (
              <button
                onClick={() => {
                  setShowTransfer(true)
                  setTransferId(agents.find((a) => a.id !== me?.id)?.id || 0)
                }}
                title="转接"
                className={iconBtn}
              >
                <ArrowLeftRight size={16} />
              </button>
            )}
            <button
              onClick={toggleMode}
              title={conversation.mode === 'human' ? '释放 AI' : '接管会话'}
              className={iconBtn}
            >
              {conversation.mode === 'human' ? <Bot size={16} /> : <UserCheck size={16} />}
            </button>
            <button onClick={closeConv} title="结束会话" className={iconBtn}>
              <PhoneOff size={16} />
            </button>
          </div>
        )}
        <button
          onClick={onTogglePanel}
          title={panelCollapsed ? '展开右侧栏' : '收起右侧栏'}
          className={iconBtn}
        >
          {panelCollapsed ? <PanelRightOpen size={16} /> : <PanelRightClose size={16} />}
        </button>
      </div>

      {conversation.status === 'open' && (
        <div className="px-4 py-1 text-[12px] text-gray-500 dark:text-gray-400 border-b dark:border-gray-800 bg-[#fafafa] dark:bg-gray-900">
          {MODE_TEXT[conversation.mode] || conversation.mode}
          {conversation.mode === 'pending' && (
            <span className="text-orange-500 ml-2">用户已申请人工，请尽快接管</span>
          )}
        </div>
      )}

      {showTransfer && (
        <div className="border-b dark:border-gray-700 px-4 py-2.5 bg-primary-50/80 dark:bg-primary-900/20 space-y-2">
          <div className="text-xs font-medium text-primary-700 dark:text-primary-300">转接给同事</div>
          <select
            value={transferId}
            onChange={(e) => setTransferId(Number(e.target.value))}
            className="w-full text-xs border dark:border-gray-700 dark:bg-gray-900 rounded px-2 py-1.5"
          >
            {agents.filter((a) => a.id !== me?.id).map((a) => (
              <option key={a.id} value={a.id}>
                {a.display_name}（{a.status === 'active' ? '接待中' : a.status === 'resting' ? '休息中' : '离线'}）
              </option>
            ))}
          </select>
          <input
            value={transferNote}
            onChange={(e) => setTransferNote(e.target.value)}
            placeholder="交接备注（内部可见，可选）"
            className="w-full text-xs border dark:border-gray-700 dark:bg-gray-900 rounded px-2 py-1.5 outline-none"
          />
          <div className="flex gap-2">
            <button onClick={submitTransfer} className="text-xs bg-primary-600 text-white rounded px-3 py-1.5">
              确认转接
            </button>
            <button onClick={() => setShowTransfer(false)} className="text-xs text-gray-500 px-3 py-1.5">
              取消
            </button>
          </div>
        </div>
      )}

      {conversation.summary && (
        <div className="bg-amber-50/70 dark:bg-amber-950/30 border-b border-amber-100 dark:border-amber-900/50 px-4 py-1.5">
          <button
            onClick={() => setSummaryOpen(!summaryOpen)}
            className="flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400 font-medium"
          >
            {summaryOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            会话小结
          </button>
          {summaryOpen && (
            <p className="text-xs text-amber-600 dark:text-amber-400/80 mt-1 leading-relaxed whitespace-pre-wrap">
              {conversation.summary}
            </p>
          )}
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-[#f4f5f7] dark:bg-gray-900">
        {messages.map((msg, i) => {
          const prev = messages[i - 1]
          const showTick =
            !prev || new Date(msg.created_at).getTime() - new Date(prev.created_at).getTime() > TICK_GAP_MS
          const priorUser = [...messages.slice(0, i)].reverse().find((m) => m.sender_type === 'user' && !m.is_internal)
          const canCapture = (msg.sender_type === 'user' || msg.sender_type === 'ai') && !msg.is_internal
          return (
            <div key={msg.id}>
              {showTick && (
                <div className="text-center text-[10px] text-gray-400 dark:text-gray-500 py-1 select-none">
                  {formatTick(msg.created_at)}
                </div>
              )}
              <MessageBubble
                msg={msg}
                onMarkBadCase={markBadCase}
                onCapture={
                  canCapture
                    ? () => {
                        const question = msg.sender_type === 'user' ? msg.content : priorUser?.content || ''
                        const answer = msg.sender_type === 'ai' ? msg.content : ''
                        navigate('/knowledge', {
                          state: {
                            faqDraft: {
                              title: question.slice(0, 30),
                              question,
                              answer,
                            },
                          },
                        })
                      }
                    : undefined
                }
              />
            </div>
          )
        })}
        {aiTyping && <TypingBubble />}
        <div ref={bottomRef} />
      </div>

      {conversation.status === 'open' && (
        <div className={clsx('border-t dark:border-gray-700 px-3 pt-1.5 pb-2.5 bg-white dark:bg-gray-900', noteMode && 'bg-amber-50/60 dark:bg-amber-950/20')}>
          <div className="flex items-center gap-0.5 mb-1 relative">
            <button
              onClick={() => setShowEmoji(!showEmoji)}
              title="表情 / 快捷回复见右侧"
              className={clsx(
                'p-1.5 rounded-lg',
                showEmoji ? 'bg-primary-50 text-primary-600' : 'text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800',
              )}
            >
              <Smile size={16} />
            </button>
            {showEmoji && (
              <div className="absolute bottom-8 left-0 z-10 bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-lg shadow-pop px-2 py-1.5 flex gap-1">
                {EMOJIS.map((em) => (
                  <button
                    key={em}
                    onClick={() => {
                      onDraftChange(draft + em)
                      setShowEmoji(false)
                    }}
                    className="w-7 h-7 hover:bg-gray-50 dark:hover:bg-gray-700 rounded text-base"
                  >
                    {em}
                  </button>
                ))}
              </div>
            )}
            <button
              onClick={() => fileRef.current?.click()}
              title="发送图片"
              className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
            >
              <ImagePlus size={16} />
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) sendImage(f)
                e.target.value = ''
              }}
            />
            <button
              onClick={() => setNoteMode(!noteMode)}
              title="内部备注（仅客服可见，不发给用户）"
              className={clsx(
                'p-1.5 rounded-lg flex items-center gap-1',
                noteMode ? 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400' : 'text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800',
              )}
            >
              <StickyNote size={16} />
              {noteMode && <span className="text-[10px] font-medium">备注</span>}
            </button>
          </div>

          <div className="relative">
            {hashHits.length > 0 && (
              <div className="absolute bottom-full left-0 right-0 mb-1 bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-lg shadow-pop max-h-40 overflow-y-auto z-10">
                {hashHits.slice(0, 8).map((qr) => (
                  <button
                    key={qr.id}
                    onClick={() => onDraftChange(qr.content)}
                    className="w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50 dark:hover:bg-gray-700"
                  >
                    <span className="text-primary-600 font-medium">#{qr.title}</span>
                    <span className="text-gray-400 ml-2">{qr.agent_id ? '我的' : '团队'}</span>
                    <div className="text-gray-500 truncate">{qr.content}</div>
                  </button>
                ))}
              </div>
            )}
            <textarea
              value={draft}
              onChange={(e) => onDraftChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  if (hashHits.length > 0) {
                    onDraftChange(hashHits[0].content)
                    return
                  }
                  send()
                }
              }}
              placeholder={
                noteMode
                  ? '内部备注：仅客服可见，不会发给用户…'
                  : conversation.mode === 'ai'
                    ? 'AI 接待中，人工可直接插话…（Enter 发送）'
                    : '输入回复内容…（Enter 发送）'
              }
              rows={2}
              className={clsx(
                'w-full border rounded-lg px-3 py-2 text-sm resize-none outline-none dark:text-gray-100 pr-16',
                noteMode
                  ? 'border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/40 focus:border-amber-400'
                  : 'dark:border-gray-700 dark:bg-gray-800 focus:border-primary-500',
              )}
            />
            <button
              onClick={() => send()}
              disabled={sending || !draft.trim()}
              className={clsx(
                'absolute right-2 bottom-2 text-[12px] px-2.5 py-1 rounded disabled:opacity-40',
                noteMode ? 'bg-amber-500 text-white hover:bg-amber-600' : 'bg-primary-600 text-white hover:bg-primary-700',
              )}
            >
              发送
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function TypingBubble() {
  return (
    <div className="flex justify-end bubble-in">
      <div className="flex items-end gap-2 flex-row-reverse">
        <div className="w-7 h-7 rounded-full bg-primary-100 text-primary-700 flex items-center justify-center shrink-0">
          <Bot size={14} />
        </div>
        <div className="bg-primary-50 dark:bg-primary-700 rounded-2xl rounded-tr-sm px-4 py-3 flex gap-1">
          {[0, 1, 2].map((i) => (
            <span key={i} className="typing-dot w-1.5 h-1.5 rounded-full bg-primary-500 dark:bg-white" />
          ))}
        </div>
      </div>
    </div>
  )
}

function CitationBlock({
  citations,
  intent,
  confidence,
}: {
  citations: string[]
  intent?: string
  confidence?: number
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="text-right">
      <button
        onClick={() => setOpen(!open)}
        className="text-primary-500 hover:text-primary-700 inline-flex items-center gap-0.5"
      >
        引用知识库 ×{citations.length}
        {open ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
      </button>
      {(intent || confidence != null) && (
        <span className="ml-1.5 text-gray-400">
          {intent ? intent : ''}
          {confidence != null ? ` · ${Math.round(confidence * 100)}%` : ''}
        </span>
      )}
      {open && (
        <ul className="mt-1 text-left bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-lg px-2 py-1 space-y-0.5">
          {citations.map((c, i) => (
            <li key={i} className="text-gray-600 dark:text-gray-300">
              {i + 1}. {c}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function MessageBubble({
  msg,
  onMarkBadCase,
  onCapture,
}: {
  msg: Message
  onMarkBadCase: (id: number) => void
  onCapture?: () => void
}) {
  const isUser = msg.sender_type === 'user'

  if (msg.sender_type === 'system') {
    return <div className="text-center text-xs text-gray-400 dark:text-gray-500 py-1">{msg.content}</div>
  }

  if (msg.is_internal) {
    return (
      <div className="flex justify-end bubble-in">
        <div className="max-w-[70%] border border-dashed border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 rounded-xl px-3.5 py-2">
          <div className="flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400 font-medium mb-0.5">
            <StickyNote size={10} />
            内部备注 · 仅客服可见
          </div>
          <div className="text-sm text-amber-800 dark:text-amber-300 leading-relaxed break-words">
            {msg.content}
          </div>
        </div>
      </div>
    )
  }

  const mediaSrc = msg.extra?.media_id ? mediaUrl(msg.extra.media_id) : null
  const outbox = msg.extra?.outbox_status ? OUTBOX_STATUS[msg.extra.outbox_status] : null
  const fullTime = new Date(msg.created_at).toLocaleString('zh-CN')
  const isAi = msg.sender_type === 'ai'

  const avatar = isUser ? (
    <div className="w-7 h-7 rounded-full bg-gray-200 dark:bg-gray-700 text-gray-500 dark:text-gray-300 flex items-center justify-center shrink-0">
      <User size={14} />
    </div>
  ) : isAi ? (
    <div className="w-7 h-7 rounded-full bg-primary-100 text-primary-700 flex items-center justify-center shrink-0">
      <Bot size={14} />
    </div>
  ) : (
    <div className="w-7 h-7 rounded-full bg-primary-600 flex items-center justify-center text-white shrink-0">
      <UserCheck size={14} />
    </div>
  )

  return (
    <div className={clsx('flex bubble-in', isUser ? 'justify-start' : 'justify-end')}>
      <div className={clsx('flex items-start gap-2 max-w-[75%]', !isUser && 'flex-row-reverse')}>
        {avatar}
        <div className="min-w-0">
          <div className={clsx('mb-0.5 flex items-center gap-1', !isUser && 'justify-end')}>
            {isAi && (
              <span className="text-[10px] text-gray-400">机器人</span>
            )}
            {msg.extra?.filtered_words && msg.extra.filtered_words.length > 0 && (
              <span className="text-[10px] text-orange-500">已过滤敏感词</span>
            )}
          </div>

          <div
            title={fullTime}
            className={clsx(
              'rounded-2xl px-3.5 py-2 text-sm leading-relaxed break-words shadow-sm',
              isUser
                ? 'bg-white dark:bg-gray-800 dark:text-gray-50 border border-gray-200 dark:border-gray-600 rounded-tl-sm'
                : isAi
                  ? 'bg-primary-100 text-primary-800 dark:bg-primary-700 dark:text-white rounded-tr-sm'
                  : 'bg-primary-600 text-white rounded-tr-sm',
            )}
          >
            {msg.msg_type === 'image' && mediaSrc ? (
              <a href={mediaSrc} target="_blank" rel="noreferrer">
                <img src={mediaSrc} alt="图片消息" className="max-w-[220px] rounded-lg bg-white/10" loading="lazy" />
              </a>
            ) : msg.msg_type === 'voice' && mediaSrc ? (
              <audio controls src={mediaSrc} className="max-w-[220px] h-8" />
            ) : (
              msg.content
            )}
            {msg.msg_type === 'voice' && (
              <div className={clsx('text-[10px] mt-1 flex items-center gap-1', isUser ? 'text-gray-400' : isAi ? 'text-primary-600 dark:text-white/70' : 'text-white/70')}>
                <Mic size={10} />
                {msg.extra?.asr ? '语音转文字' : '语音消息'}
              </div>
            )}
            {msg.msg_type === 'image' && !mediaSrc && (
              <div className="flex items-center gap-1 text-xs opacity-80">
                <ImageIcon size={12} />
                {msg.content}
              </div>
            )}
          </div>

          <div className={clsx('flex items-center gap-2 mt-0.5 text-[10px] text-gray-400 dark:text-gray-500', !isUser && 'justify-end')}>
            {outbox && (
              <span className={clsx('inline-flex items-center gap-0.5', outbox.cls)} title={`RPA 通道：${outbox.label}`}>
                <outbox.icon size={10} />
                {outbox.label}
              </span>
            )}
            {msg.extra?.citations && msg.extra.citations.length > 0 && (
              <CitationBlock citations={msg.extra.citations} intent={msg.extra.intent} confidence={msg.extra.confidence} />
            )}
            {isAi && !msg.bad_case && (
              <button
                onClick={() => onMarkBadCase(msg.id)}
                className="inline-flex items-center gap-0.5 hover:text-red-500"
                title="标记为 badcase"
              >
                <Flag size={10} />
                不佳
              </button>
            )}
            {onCapture && (
              <button onClick={onCapture} className="hover:text-primary-600" title="带进知识库编辑，不会直接保存">
                沉淀
              </button>
            )}
            {msg.bad_case && (
              <span className="inline-flex items-center gap-0.5 text-red-400" title={msg.extra?.badcase_note || ''}>
                <Flag size={10} />
                已标记
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
