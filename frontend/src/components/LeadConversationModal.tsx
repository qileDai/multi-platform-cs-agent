import clsx from 'clsx'
import dayjs from 'dayjs'
import { Bot, User, UserCheck, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { api, Conversation, LeadCapture, mediaUrl, Message } from '../api/client'

const PLATFORM: Record<string, string> = {
  douyin: '抖音',
  xiaohongshu: '小红书',
  mock: '模拟',
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function findContactSpan(text: string, contact: string): { start: number; end: number } | null {
  const needle = contact.trim()
  if (!needle || !text) return null
  const exact = text.indexOf(needle)
  if (exact >= 0) return { start: exact, end: exact + needle.length }
  const pattern = needle.split('').map((ch) => escapeRegExp(ch)).join('\\s*')
  const matched = new RegExp(pattern).exec(text)
  if (!matched) return null
  return { start: matched.index, end: matched.index + matched[0].length }
}

function pickContactMessage(messages: Message[], contact: string, createdAt: string): Message | null {
  if (!contact.trim()) return null
  const hits = messages.filter((m) => findContactSpan(m.content || '', contact))
  if (hits.length === 0) return null
  const users = hits.filter((m) => m.sender_type === 'user' && !m.is_internal)
  const pool = users.length > 0 ? users : hits
  const target = new Date(createdAt).getTime()
  return pool.reduce((best, msg) => {
    const gap = Math.abs(new Date(msg.created_at).getTime() - target)
    const bestGap = Math.abs(new Date(best.created_at).getTime() - target)
    return gap < bestGap ? msg : best
  })
}

function highlightContact(text: string, contact: string) {
  const span = findContactSpan(text, contact)
  if (!span) return text
  return (
    <>
      {text.slice(0, span.start)}
      <mark className="bg-amber-200 text-inherit rounded px-0.5 dark:bg-amber-400/40">
        {text.slice(span.start, span.end)}
      </mark>
      {text.slice(span.end)}
    </>
  )
}

function showText(msg: Message, mediaSrc: string | null): boolean {
  if (!msg.content) return false
  const hasMedia = !!mediaSrc && (msg.msg_type === 'image' || msg.msg_type === 'voice')
  if (!hasMedia) return true
  return msg.content !== '[图片]' && msg.content !== '[语音]'
}

function Bubble({
  msg,
  contact,
  marked,
  markRef,
}: {
  msg: Message
  contact: string
  marked: boolean
  markRef: RefObject<HTMLDivElement>
}) {
  const text = marked ? highlightContact(msg.content, contact) : msg.content
  if (msg.sender_type === 'system') {
    return (
      <div ref={marked ? markRef : undefined} className={clsx('text-center text-xs text-gray-400 py-1', marked && 'text-amber-700 dark:text-amber-300')}>
        {text}
      </div>
    )
  }

  if (msg.is_internal) {
    return (
      <div ref={marked ? markRef : undefined} className="flex justify-end">
        <div className={clsx(
          'max-w-[75%] border border-dashed border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 rounded-xl px-3.5 py-2',
          marked && 'ring-2 ring-amber-400',
        )}>
          <div className="text-[10px] text-amber-600 dark:text-amber-400 font-medium mb-0.5">内部备注</div>
          <div className="text-sm text-amber-800 dark:text-amber-300 leading-relaxed break-words whitespace-pre-wrap">
            {text}
          </div>
        </div>
      </div>
    )
  }

  const isUser = msg.sender_type === 'user'
  const isAi = msg.sender_type === 'ai'
  const mediaSrc = msg.extra?.media_id ? mediaUrl(msg.extra.media_id) : null
  const avatar = isUser ? (
    <div className="w-7 h-7 rounded-full bg-gray-200 dark:bg-gray-700 text-gray-500 flex items-center justify-center shrink-0">
      <User size={14} />
    </div>
  ) : isAi ? (
    <div className="w-7 h-7 rounded-full bg-primary-100 text-primary-700 flex items-center justify-center shrink-0">
      <Bot size={14} />
    </div>
  ) : (
    <div className="w-7 h-7 rounded-full bg-primary-600 text-white flex items-center justify-center shrink-0">
      <UserCheck size={14} />
    </div>
  )

  return (
    <div ref={marked ? markRef : undefined} className={clsx('flex', isUser ? 'justify-start' : 'justify-end')}>
      <div className={clsx('flex items-start gap-2 max-w-[75%]', !isUser && 'flex-row-reverse')}>
        {avatar}
        <div className="min-w-0">
          {marked && (
            <div className={clsx('text-[10px] text-amber-600 dark:text-amber-400 mb-0.5', !isUser && 'text-right')}>
              本条留资
            </div>
          )}
          <div
            className={clsx(
              'rounded-2xl px-3.5 py-2 text-sm leading-relaxed break-words whitespace-pre-wrap shadow-sm',
              isUser
                ? 'bg-white dark:bg-gray-800 dark:text-gray-50 border border-gray-200 dark:border-gray-600 rounded-tl-sm'
                : isAi
                  ? 'bg-primary-100 text-primary-800 dark:bg-primary-700 dark:text-white rounded-tr-sm'
                  : 'bg-primary-600 text-white rounded-tr-sm',
              marked && 'ring-2 ring-amber-400 ring-offset-2 ring-offset-gray-50 dark:ring-offset-gray-950',
            )}
          >
            {msg.msg_type === 'image' && mediaSrc && (
              <a href={mediaSrc} target="_blank" rel="noreferrer">
                <img src={mediaSrc} alt="图片消息" className="max-w-[220px] rounded-lg" loading="lazy" />
              </a>
            )}
            {msg.msg_type === 'voice' && mediaSrc && (
              <audio controls src={mediaSrc} className="max-w-[220px] h-8" />
            )}
            {showText(msg, mediaSrc) && (
              <div className={mediaSrc && (msg.msg_type === 'image' || msg.msg_type === 'voice') ? 'mt-1' : undefined}>
                {text}
              </div>
            )}
          </div>
          <div className={clsx('mt-0.5 text-[10px] text-gray-400', !isUser && 'text-right')}>
            {dayjs(msg.created_at).format('MM-DD HH:mm')}
          </div>
        </div>
      </div>
    </div>
  )
}

export default function LeadConversationModal({ lead, onClose }: { lead: LeadCapture; onClose: () => void }) {
  const [conversation, setConversation] = useState<Conversation | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const markRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    setConversation(null)
    setMessages([])
    Promise.all([
      api.getConversation(lead.conversation_id),
      api.listMessages(lead.conversation_id),
    ])
      .then(([conv, rows]) => {
        if (cancelled) return
        setConversation(conv)
        setMessages(rows)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : '加载会话失败')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [lead.conversation_id, retry])

  const hit = useMemo(
    () => pickContactMessage(messages, lead.contact, lead.created_at),
    [messages, lead.contact, lead.created_at],
  )

  useEffect(() => {
    if (loading || !hit) return
    markRef.current?.scrollIntoView({ block: 'center' })
  }, [loading, hit])

  const nickname = conversation?.customer?.nickname || lead.nickname || '访客'
  const platform = PLATFORM[lead.platform] || lead.platform || '—'

  return (
    <div
      className="fixed inset-0 z-[90] bg-black/40 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="查看会话"
        className="bg-white dark:bg-gray-900 rounded-2xl shadow-pop w-full max-w-2xl h-[min(80vh,720px)] flex flex-col"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="px-4 py-3 border-b dark:border-gray-700 flex items-center gap-3 shrink-0">
          <div className="w-8 h-8 rounded-full bg-primary-500 text-white flex items-center justify-center text-sm font-medium shrink-0">
            {nickname.slice(0, 1)}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-gray-800 dark:text-gray-100 truncate">{nickname}</div>
            <div className="text-xs text-gray-400 truncate">
              {platform} · {lead.contact}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            <X size={16} />
          </button>
        </div>

        {!loading && !error && !hit && (
          <div className="px-4 py-2 text-xs text-amber-700 bg-amber-50 dark:bg-amber-950/40 dark:text-amber-300 shrink-0">
            未在消息里定位到该联系方式
          </div>
        )}

        <div className="flex-1 overflow-auto px-4 py-4 space-y-3 bg-gray-50 dark:bg-gray-950">
          {loading ? (
            <div className="text-sm text-gray-400 text-center py-10">加载会话…</div>
          ) : error ? (
            <div className="text-center py-10">
              <div className="text-sm text-red-500">{error}</div>
              <button
                type="button"
                onClick={() => setRetry((n) => n + 1)}
                className="mt-3 text-xs px-3 py-1.5 rounded-lg border dark:border-gray-700"
              >
                重试
              </button>
            </div>
          ) : messages.length === 0 ? (
            <div className="text-sm text-gray-400 text-center py-10">这条会话还没有消息</div>
          ) : (
            messages.map((msg) => (
              <Bubble
                key={msg.id}
                msg={msg}
                contact={lead.contact}
                marked={hit?.id === msg.id}
                markRef={markRef}
              />
            ))
          )}
        </div>
      </div>
    </div>
  )
}
