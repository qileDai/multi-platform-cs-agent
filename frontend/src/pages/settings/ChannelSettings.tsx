import { useEffect, useState } from 'react'
import { api, appBase, RpaFailedMessage, RpaWorker } from '../../api/client'
import { toast } from '../../components/ui/toast'

const INTEGRATIONS = [
  { key: 'llm', label: 'LLM（对话模型）' },
  { key: 'embedding', label: 'Embedding（向量）' },
  { key: 'rerank', label: 'Rerank（精排）' },
  { key: 'douyin', label: '抖音开放平台' },
  { key: 'xiaohongshu', label: '小红书开放平台' },
  { key: 'wecom', label: '企业微信 API' },
  { key: 'wecom_callback', label: '企微回调（加粉归因）' },
  { key: 'zhini', label: '知你快回回复接口' },
]

export default function ChannelSettings() {
  const [health, setHealth] = useState<Record<string, any>>({})
  const [rpaWorkers, setRpaWorkers] = useState<RpaWorker[]>([])
  const [rpaFailed, setRpaFailed] = useState<RpaFailedMessage[]>([])

  const load = async () => {
    setHealth(await api.health())
    try {
      setRpaWorkers(await api.listRpaWorkers())
      setRpaFailed((await api.listRpaFailed()).items)
    } catch {
      setRpaWorkers([])
      setRpaFailed([])
    }
  }

  useEffect(() => {
    load()
    const timer = setInterval(load, 30000)
    return () => clearInterval(timer)
  }, [])

  return (
    <div className="max-w-5xl space-y-4">
      <div className="bg-white dark:bg-gray-900 rounded-card shadow-card p-5">
        <div className="text-sm font-medium text-gray-700 dark:text-gray-200 mb-4">集成配置状态（在 backend/.env 中配置）</div>
        <div className="space-y-2.5">
          {INTEGRATIONS.map((item) => (
            <div key={item.key} className="flex items-center justify-between text-sm">
              <span className="text-gray-600 dark:text-gray-300">{item.label}</span>
              <span className={`text-xs px-2 py-0.5 rounded-full ${health[item.key] ? 'bg-green-100 text-green-600' : 'bg-gray-100 text-gray-400'}`}>
                {health[item.key] ? '已配置' : '未配置（降级运行）'}
              </span>
            </div>
          ))}
        </div>
        <p className="mt-4 text-xs leading-5 text-gray-500 dark:text-gray-400">
          知你快回插件的接口地址填
          <code className="mx-1">{`${window.location.origin}${appBase()}/api/integrations/zhinikuaihui/reply`}</code>
          ，身份验证填 ZHINI_REPLY_API_KEY，等待时间选 60 秒。密钥只写在后端 .env，这里不显示明文。
        </p>
      </div>

      <div className="bg-white dark:bg-gray-900 rounded-card shadow-card p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="text-sm font-medium text-gray-700 dark:text-gray-200">RPA 通道（Worker 状态，按店铺账号分组）</div>
          <a href="https://github.com" className="text-xs text-blue-500 hover:underline" onClick={(e) => e.preventDefault()}>
            接入指南见 docs/rpa-workers.md
          </a>
        </div>
        {rpaWorkers.length === 0 ? (
          <div className="text-xs text-gray-400">
            暂无在线 Worker。RPA 通道用于无官方 API 资质时的降级接入：在商家电脑运行 workers/ 目录下的 Worker 即可。
          </div>
        ) : (
          <div className="space-y-2">
            {rpaWorkers.map((w) => (
              <div key={w.worker_id} className="flex items-center justify-between border dark:border-gray-700 rounded-lg px-3 py-2 text-sm">
                <div className="flex items-center gap-3">
                  <span className={`inline-block w-2 h-2 rounded-full ${
                    w.status === 'online' ? 'bg-green-500' : 'bg-red-500'
                  }`} />
                  <span className="font-medium text-gray-700 dark:text-gray-200">{w.account}</span>
                  <span className="text-xs text-gray-400">{w.platform === 'douyin' ? '抖音' : '小红书'} · {w.worker_id}</span>
                  {w.status === 'login_expired' && (
                    <span className="text-[10px] bg-red-100 text-red-600 rounded px-1.5 py-0.5">
                      登录过期 → 请在 Worker 机器运行 python login.py
                    </span>
                  )}
                  {w.status === 'selector_mismatch' && (
                    <span className="text-[10px] bg-red-100 text-red-600 rounded px-1.5 py-0.5">
                      页面改版 → 请更新 Worker 选择器（docs/rpa-workers.md）
                    </span>
                  )}
                  {w.status === 'offline' && (
                    <span className="text-[10px] bg-red-100 text-red-600 rounded px-1.5 py-0.5">
                      已掉线 → 请检查 Worker 进程与网络
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-4 text-xs text-gray-500">
                  <span>待发 {w.pending}</span>
                  <span className={w.failed > 0 ? 'text-red-500' : ''}>失败 {w.failed}</span>
                  <span>心跳 {new Date(w.last_heartbeat_at).toLocaleTimeString()}</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {rpaFailed.length > 0 && (
          <div className="mt-4 border-t pt-3">
            <div className="text-xs font-medium text-red-600 mb-2">
              失败消息（{rpaFailed.length}）— 连续 3 次未发出的消息会停在这里，不会自动重试
            </div>
            <div className="space-y-1.5 max-h-48 overflow-y-auto">
              {rpaFailed.map((m) => (
                <div key={m.outbox_id} className="flex items-center justify-between text-xs border dark:border-gray-700 rounded px-2.5 py-1.5">
                  <div className="min-w-0 flex-1">
                    <span className="text-gray-400">[{m.account}]</span>
                    <span className="text-gray-700 ml-1">{m.content || `（${m.msg_type}）`}</span>
                    <div className="text-gray-400 truncate">{m.error}</div>
                  </div>
                  <div className="flex gap-2 ml-3 shrink-0">
                    <button
                      onClick={async () => { await api.retryRpaOutbox(m.outbox_id); toast.success('已重新入队'); load() }}
                      className="text-blue-500 hover:text-blue-700"
                    >
                      重发
                    </button>
                    <button
                      onClick={async () => { await api.discardRpaOutbox(m.outbox_id); toast.info('已忽略该消息'); load() }}
                      className="text-gray-400 hover:text-gray-600"
                    >
                      忽略
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
