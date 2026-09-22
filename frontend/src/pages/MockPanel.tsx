import { FlaskConical, Send } from 'lucide-react'
import { FormEvent, useState } from 'react'
import { api } from '../api/client'
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

export default function MockPanel() {
  const [platform, setPlatform] = useState<string>('douyin')
  const [userId, setUserId] = useState('user_001')
  const [nickname, setNickname] = useState('测试用户')
  const [content, setContent] = useState('')
  const [log, setLog] = useState<string[]>([])

  const send = async (e?: FormEvent) => {
    e?.preventDefault()
    if (!content.trim()) return
    try {
      await api.mockIncoming(platform, userId, nickname, content)
      setLog((prev) => [`[${new Date().toLocaleTimeString()}] [${platform}] ${nickname}: ${content}`, ...prev])
      setContent('')
    } catch (err: any) {
      toast.error(err?.message || '发送失败')
    }
  }

  return (
    <div className="h-full overflow-y-auto bg-gray-50 dark:bg-gray-950 p-6">
      {/* 演示模式横幅 */}
      <div className="max-w-2xl mx-auto mb-4 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 rounded-xl px-4 py-2.5 flex items-center gap-2 text-xs text-amber-700 dark:text-amber-400">
        <FlaskConical size={14} />
        <span>
          <b>演示模式</b>：无需真实平台资质，模拟用户发私信，完整跑通「AI 接待 → 转人工 → 人工接管」全流程。发送后到「对话」页查看效果。
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
            <button className="bg-blue-600 hover:bg-blue-700 text-white text-sm rounded-lg px-5 flex items-center gap-1.5">
              <Send size={13} />
              发送
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

        {/* 发送日志 */}
        <div className="bg-white dark:bg-gray-900 rounded-card shadow-card p-5">
          <div className="text-sm font-medium text-gray-700 dark:text-gray-200 mb-3">发送记录</div>
          <div className="space-y-1.5 max-h-64 overflow-y-auto">
            {log.map((line, i) => (
              <div key={i} className="text-xs text-gray-500 dark:text-gray-400 font-mono">{line}</div>
            ))}
            {log.length === 0 && <div className="text-xs text-gray-300 dark:text-gray-600">暂无记录</div>}
          </div>
        </div>
      </div>
    </div>
  )
}
