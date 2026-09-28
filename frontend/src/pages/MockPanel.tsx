import { FlaskConical, Send } from 'lucide-react'
import { FormEvent, useEffect, useState } from 'react'
import { api, type Message } from '../api/client'
import { toast } from '../components/ui/toast'

const PLATFORMS = [
  { key: 'douyin', label: '抖音', className: 'bg-gray-900' },
  { key: 'xiaohongshu', label: '小红书', className: 'bg-xhs' },
] as const

const PRESET_MESSAGES = [
  '在吗，这个多少钱',
  '质量怎么样啊',
  '你们支持开发票吗',
  '我要找真人客服',
  '这东西太差了，我要投诉！',
]

const REASON_LABEL: Record<string, string> = {
  passed: '检索通过',
  no_hits: '两路都没召回',
  rerank_below_threshold: '精排分低于阈值',
  rerank_unavailable: '精排未用上',
  dense_gap: '向量分差不够',
  bm25_gap: '关键词分差不够',
}

type Round = {
  id: number
  userText: string
  reason: string
  score: string
  reply: string
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function describeRetrieval(message: Message): { reason: string; score: string } {
  const retrieval = message.extra?.retrieval
  if (!retrieval) return { reason: '还没有检索记录', score: '—' }
  let reason = REASON_LABEL[retrieval.reason || ''] || retrieval.reason || '未知'
  if (retrieval.reason === 'passed' && retrieval.rerank_status === 'unavailable') {
    reason = '检索通过，精排未用上'
  }
  const score = retrieval.rerank_top_score == null ? '无精排分' : String(retrieval.rerank_top_score)
  return { reason, score }
}

function roundsFrom(messages: Message[]): Round[] {
  const rounds: Round[] = []
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    if (message.sender_type !== 'user' || message.is_internal) continue
    const replies: string[] = []
    for (let j = i + 1; j < messages.length; j++) {
      const next = messages[j]
      if (next.sender_type === 'user') break
      if (next.is_internal) continue
      if (next.sender_type === 'ai' || next.sender_type === 'system') replies.push(next.content)
    }
    const described = describeRetrieval(message)
    rounds.push({
      id: message.id,
      userText: message.content,
      reason: described.reason,
      score: described.score,
      reply: replies.join('\n'),
    })
  }
  return rounds.reverse()
}

async function loadRounds(platform: string, userId: string): Promise<Round[]> {
  const [active, pending] = await Promise.all([
    api.listConversations('active', platform),
    api.listConversations('pending', platform),
  ])
  const matched = [...active, ...pending]
    .filter((item) => item.customer.platform_user_id === userId)
    .sort((a, b) => (a.last_message_at < b.last_message_at ? 1 : -1))
  const conversation = matched[0]
  if (!conversation) return []
  const messages = await api.listMessages(conversation.id)
  return roundsFrom(messages)
}

export default function MockPanel() {
  const [platform, setPlatform] = useState<string>('douyin')
  const [userId, setUserId] = useState('user_001')
  const [nickname, setNickname] = useState('测试用户')
  const [content, setContent] = useState('')
  const [rounds, setRounds] = useState<Round[]>([])
  const [waiting, setWaiting] = useState(false)

  useEffect(() => {
    let cancelled = false
    loadRounds(platform, userId)
      .then((items) => {
        if (!cancelled) setRounds(items)
      })
      .catch(() => {
        if (!cancelled) setRounds([])
      })
    return () => {
      cancelled = true
    }
  }, [platform, userId])

  const send = async (e?: FormEvent) => {
    e?.preventDefault()
    const text = content.trim()
    if (!text || waiting) return
    setWaiting(true)
    try {
      await api.mockIncoming(platform, userId, nickname, text)
      setContent('')
      const deadline = Date.now() + 20000
      while (Date.now() < deadline) {
        const items = await loadRounds(platform, userId)
        setRounds(items)
        const hit = items.find((item) => item.userText === text)
        if (hit?.reply) break
        await sleep(800)
      }
    } catch (err: any) {
      toast.error(err?.message || '发送失败')
    } finally {
      setWaiting(false)
    }
  }

  return (
    <div className="h-full overflow-y-auto bg-gray-50 dark:bg-gray-950 p-6">
      <div className="max-w-2xl mx-auto mb-4 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 rounded-xl px-4 py-2.5 flex items-center gap-2 text-xs text-amber-700 dark:text-amber-400">
        <FlaskConical size={14} />
        <span>
          <b>演示模式</b>：模拟用户发私信。本页会记下原话、检索结论和回复，刷新后仍从会话读取。
        </span>
      </div>

      <div className="max-w-2xl mx-auto space-y-4">
        <div className="bg-white dark:bg-gray-900 rounded-card shadow-card p-5">
          <div className="text-sm font-medium text-gray-700 dark:text-gray-200 mb-3">扮演用户</div>
          <div className="flex gap-2 mb-3">
            {PLATFORMS.map((p) => (
              <button
                key={p.key}
                onClick={() => setPlatform(p.key)}
                className={`text-xs px-3.5 py-1.5 rounded-full text-white transition-all ${p.className} ${platform === p.key ? 'ring-2 ring-offset-1 ring-blue-300' : 'opacity-40'}`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="flex gap-2 mb-3">
            <input
              className="w-36 border dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 rounded-lg px-3 py-2 text-sm outline-none focus:border-blue-500"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              placeholder="用户 ID"
            />
            <input
              className="flex-1 border dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 rounded-lg px-3 py-2 text-sm outline-none focus:border-blue-500"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              placeholder="昵称"
            />
          </div>
          <form onSubmit={send} className="flex gap-2">
            <input
              className="flex-1 border dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 rounded-lg px-3 py-2 text-sm outline-none focus:border-blue-500"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="输入用户消息..."
            />
            <button
              disabled={waiting}
              className="bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white text-sm rounded-lg px-5 flex items-center gap-1.5"
            >
              <Send size={13} />
              {waiting ? '等待回复' : '发送'}
            </button>
          </form>
          <div className="flex flex-wrap gap-1.5 mt-3">
            {PRESET_MESSAGES.map((m) => (
              <button
                key={m}
                onClick={() => setContent(m)}
                className="text-xs bg-gray-100 hover:bg-gray-200 text-gray-600 dark:bg-gray-800 dark:hover:bg-gray-700 dark:text-gray-300 rounded-full px-2.5 py-1"
              >
                {m}
              </button>
            ))}
          </div>
        </div>

        <div className="bg-white dark:bg-gray-900 rounded-card shadow-card p-5">
          <div className="text-sm font-medium text-gray-700 dark:text-gray-200 mb-3">对话记录</div>
          <div className="space-y-3">
            {rounds.map((round) => (
              <div key={round.id} className="border dark:border-gray-800 rounded-lg px-3 py-2 space-y-1">
                <div className="text-sm text-gray-800 dark:text-gray-100">{round.userText}</div>
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  {round.reason} · 精排分 {round.score}
                </div>
                <div className="text-sm text-gray-700 dark:text-gray-200 whitespace-pre-wrap">
                  {round.reply || '等待回复'}
                </div>
              </div>
            ))}
            {rounds.length === 0 && <div className="text-xs text-gray-300 dark:text-gray-600">暂无记录</div>}
          </div>
        </div>
      </div>
    </div>
  )
}
