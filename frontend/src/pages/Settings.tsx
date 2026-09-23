import { ClipboardList, ListChecks, MessageSquare, Plug, Users, Workflow } from 'lucide-react'
import { FormEvent, useEffect, useRef, useState } from 'react'
import { api, Agent, AuditLogItem, AutoSwitches, BannedWord, QueueOpsOverview, QuickReply, RpaFailedMessage, RpaWorker } from '../api/client'
import { confirmDialog } from '../components/ui/dialogs'
import { toast } from '../components/ui/toast'
import { useAuth } from '../store'

const SECTIONS = [
  { id: 'sec-ai', label: 'AI 开关', icon: Plug },
  { id: 'sec-integration', label: '集成配置', icon: Plug },
  { id: 'sec-agents', label: '客服账号', icon: Users },
  { id: 'sec-banned', label: '违禁词', icon: ListChecks },
  { id: 'sec-rpa', label: 'RPA 通道', icon: Workflow },
  { id: 'sec-queue', label: '队列运维', icon: ListChecks },
  { id: 'sec-brand', label: '品牌语气', icon: MessageSquare },
  { id: 'sec-quick', label: '快捷回复', icon: MessageSquare },
  { id: 'sec-audit', label: '审计日志', icon: ClipboardList },
] as const

const TASK_TYPE_LABELS: Record<string, string> = {
  inbound_message: '私信入站',
  inbound_comment: '评论入站',
  content_generate: '内容生成',
  first_comment: '首评引流',
}

const ACTION_LABELS: Record<string, string> = {
  takeover: '接管会话',
  release: '释放会话',
  close: '关闭会话',
  kb_faq_create: '新增 FAQ',
  kb_faq_update: '修改 FAQ',
  kb_doc_delete: '删除文档',
  kb_doc_upload: '上传文档',
  ai_switch: 'AI 总开关',
  auto_switches: '自动化开关',
  brand_style_update: '品牌语气更新',
  rpa_outbox_retry: '重发失败消息',
  rpa_outbox_discard: '忽略失败消息',
}

export default function Settings() {
  const { agent: me } = useAuth()
  const [agents, setAgents] = useState<Agent[]>([])
  const [quickReplies, setQuickReplies] = useState<QuickReply[]>([])
  const [health, setHealth] = useState<Record<string, any>>({})
  const [rpaWorkers, setRpaWorkers] = useState<RpaWorker[]>([])
  const [rpaFailed, setRpaFailed] = useState<RpaFailedMessage[]>([])
  const [aiEnabled, setAiEnabled] = useState(true)
  const [autoSwitches, setAutoSwitches] = useState<AutoSwitches | null>(null)
  const [brandStyle, setBrandStyle] = useState('')
  const [auditLogs, setAuditLogs] = useState<AuditLogItem[]>([])
  const [queueOps, setQueueOps] = useState<QueueOpsOverview | null>(null)

  // 新客服表单
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')

  // 快捷回复表单
  const [qrTitle, setQrTitle] = useState('')
  const [qrContent, setQrContent] = useState('')
  const [qrPersonal, setQrPersonal] = useState(false)
  const [banned, setBanned] = useState<BannedWord[]>([])
  const [bannedWord, setBannedWord] = useState('')
  const [bannedCat, setBannedCat] = useState('极限词')

  const refresh = async () => {
    setAgents(await api.listAgents())
    setQuickReplies(await api.listQuickReplies())
    try {
      setBanned(await api.listBannedWords())
    } catch { setBanned([]) }
    setHealth(await api.health())
    try {
      const sw = await api.getAiSwitch()
      setAiEnabled(sw.enabled)
    } catch { /* 忽略 */ }
    try {
      setAutoSwitches(await api.getAutoSwitches())
    } catch { /* 忽略 */ }
    try {
      setBrandStyle((await api.getBrandStyle()).brand_style_guide)
    } catch { /* 忽略 */ }
    if (me?.role === 'admin') {
      try {
        setAuditLogs((await api.listAuditLogs()).items)
      } catch { /* 忽略 */ }
      try {
        setQueueOps(await api.queueFailed())
      } catch { /* 忽略 */ }
    }
    try {
      setRpaWorkers(await api.listRpaWorkers())
      setRpaFailed((await api.listRpaFailed()).items)
    } catch {
      setRpaWorkers([]) // RPA 未启用时接口 503，静默降级
      setRpaFailed([])
    }
  }

  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, 30000) // RPA 心跳状态 30s 自动刷新
    return () => clearInterval(timer)
  }, [])

  const createAgent = async (e: FormEvent) => {
    e.preventDefault()
    if (!username.trim() || !password.trim() || !displayName.trim()) return
    await api.createAgent(username, password, displayName)
    setUsername(''); setPassword(''); setDisplayName('')
    toast.success('客服账号已创建')
    refresh()
  }

  const createQr = async (e: FormEvent) => {
    e.preventDefault()
    if (!qrTitle.trim() || !qrContent.trim()) return
    await api.createQuickReply(qrTitle, qrContent, qrPersonal)
    setQrTitle(''); setQrContent(''); setQrPersonal(false)
    toast.success('快捷回复已添加')
    refresh()
  }

  const integrations = [
    { key: 'llm', label: 'LLM（对话模型）' },
    { key: 'embedding', label: 'Embedding（向量）' },
    { key: 'rerank', label: 'Rerank（精排）' },
    { key: 'douyin', label: '抖音开放平台' },
    { key: 'xiaohongshu', label: '小红书开放平台' },
    { key: 'wecom', label: '企业微信 API' },
    { key: 'wecom_callback', label: '企微回调（加粉归因）' },
    { key: 'zhini', label: '知你快回回复接口' },
  ]

  const toggleAi = async () => {
    const next = !aiEnabled
    if (!next) {
      const ok = await confirmDialog({
        title: '关闭 AI 总开关？',
        message: '关闭后所有新消息将直接转人工，AI 不再自动回复。用于 AI 失控时紧急止血。',
        confirmText: '确认关闭',
        danger: true,
      })
      if (!ok) return
    }
    const res = await api.setAiSwitch(next)
    setAiEnabled(res.enabled)
    toast[next ? 'success' : 'info'](next ? 'AI 总开关已开启' : 'AI 总开关已关闭，全部转人工')
  }

  const toggleAutoSwitch = async (key: keyof AutoSwitches) => {
    if (!autoSwitches) return
    const next = !autoSwitches[key]
    if (!next) {
      const label = key === 'comment_auto_reply_enabled' ? '评论自动回复' : '自动发布'
      const ok = await confirmDialog({
        title: `关闭${label}？`,
        message: '关闭后相关自动化动作全部停止，仅保留人工操作。用于风控/异常时紧急止血。',
        confirmText: '确认关闭',
        danger: true,
      })
      if (!ok) return
    }
    try {
      setAutoSwitches(await api.setAutoSwitches({ [key]: next }))
      toast.success(next ? '已开启' : '已关闭（仅人工）')
    } catch (e: any) {
      toast.error(e.message || '切换失败')
    }
  }

  const scrollRef = useRef<HTMLDivElement>(null)
  const scrollTo = (id: string) => {
    scrollRef.current?.querySelector(`#${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <div className="h-full flex bg-gray-50 dark:bg-gray-950">
      {/* 左侧锚点导航 */}
      <div className="w-36 shrink-0 border-r dark:border-gray-700 bg-white dark:bg-gray-900 py-6 px-3">
        <h1 className="text-base font-semibold text-gray-800 dark:text-gray-100 px-2 mb-4">设置</h1>
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            onClick={() => scrollTo(s.id)}
            className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-xs text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-800 dark:hover:text-gray-100 transition-colors"
          >
            <s.icon size={13} />
            {s.label}
          </button>
        ))}
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-6">
      {!aiEnabled && (
        <div className="max-w-5xl mb-4 bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-4 py-3">
          AI 总开关已关闭：所有新消息正在直接转人工，AI 不会自动回复。
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 max-w-5xl">
        {/* AI 全局熔断开关 */}
        <div id="sec-ai" className="bg-white dark:bg-gray-900 rounded-card shadow-card p-5 col-span-2 scroll-mt-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium text-gray-700 dark:text-gray-200">AI 总开关（全局熔断）</div>
              <div className="text-xs text-gray-400 mt-1">
                AI 失控时一键关闭，所有会话立即转人工止血。重启后回退到 backend/.env 的 AI_GLOBALLY_ENABLED。
              </div>
            </div>
            <button
              onClick={toggleAi}
              disabled={me?.role !== 'admin'}
              className={`text-xs rounded-full px-4 py-1.5 font-medium ${
                aiEnabled ? 'bg-green-100 text-green-700 hover:bg-green-200' : 'bg-red-100 text-red-700 hover:bg-red-200'
              } disabled:opacity-40`}
            >
              {aiEnabled ? 'AI 接待中 · 点击关闭' : '已关闭 · 点击恢复'}
            </button>
          </div>
        </div>

        {/* 自动化熔断开关（评论/发布） */}
        <div className="bg-white dark:bg-gray-900 rounded-card shadow-card p-5 col-span-2 scroll-mt-4">
          <div className="text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">自动化开关（内容矩阵）</div>
          <div className="text-xs text-gray-400 mb-4">
            关闭后评论自动回复 / 定时发布全部停止，仅人工可操作。重启后回退到 backend/.env 的对应配置。
          </div>
          <div className="flex gap-4">
            {([
              { key: 'comment_auto_reply_enabled' as const, label: '评论自动回复' },
              { key: 'publish_auto_enabled' as const, label: '自动发布' },
            ]).map((item) => (
              <div key={item.key} className="flex items-center justify-between flex-1 border dark:border-gray-700 rounded-lg px-4 py-3">
                <span className="text-sm text-gray-600 dark:text-gray-300">{item.label}</span>
                <button
                  onClick={() => toggleAutoSwitch(item.key)}
                  disabled={me?.role !== 'admin' || !autoSwitches}
                  className={`text-xs rounded-full px-4 py-1.5 font-medium ${
                    autoSwitches?.[item.key]
                      ? 'bg-green-100 text-green-700 hover:bg-green-200'
                      : 'bg-gray-100 text-gray-500 hover:bg-gray-200 dark:bg-gray-800'
                  } disabled:opacity-40`}
                >
                  {autoSwitches?.[item.key] ? '已开启' : '已关闭'}
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* 品牌语气（创作提示词注入） */}
        <div id="sec-brand" className="bg-white dark:bg-gray-900 rounded-card shadow-card p-5 col-span-2 scroll-mt-4">
          <div className="text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">品牌语气（内容创作）</div>
          <div className="text-xs text-gray-400 mb-3">
            配置后自动注入 AI 创作提示词，让全矩阵内容统一品牌调性。重启后回退到 backend/.env 的 BRAND_STYLE_GUIDE。
          </div>
          <textarea
            value={brandStyle}
            onChange={(e) => setBrandStyle(e.target.value)}
            rows={4}
            placeholder={'如：我们是面向 25-35 岁都市女性的轻护肤品牌，语气温柔专业，自称「小编」，不用网络烂梗，强调成分与实证，结尾常用「评论区见～」'}
            disabled={me?.role !== 'admin'}
            className="w-full border dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 rounded-lg px-3 py-2 text-sm outline-none focus:border-blue-500 disabled:opacity-50"
          />
          <div className="flex justify-end mt-2">
            <button
              onClick={async () => {
                try {
                  const res = await api.setBrandStyle(brandStyle)
                  setBrandStyle(res.brand_style_guide)
                  toast.success('品牌语气已保存（立即生效）')
                } catch (e: any) {
                  toast.error(e.message || '保存失败')
                }
              }}
              disabled={me?.role !== 'admin'}
              className="text-xs px-4 py-2 rounded-lg text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-40"
            >
              保存品牌语气
            </button>
          </div>
        </div>

        {/* 平台凭证状态 */}
        <div id="sec-integration" className="bg-white dark:bg-gray-900 rounded-card shadow-card p-5 scroll-mt-4">
          <div className="text-sm font-medium text-gray-700 dark:text-gray-200 mb-4">集成配置状态（在 backend/.env 中配置）</div>
          <div className="space-y-2.5">
            {integrations.map((item) => (
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
            <code className="mx-1">https://你的域名/api/integrations/zhinikuaihui/reply</code>
            ，身份验证填 ZHINI_REPLY_API_KEY，等待时间选 60 秒。密钥只写在后端 .env，这里不显示明文。
          </p>
        </div>

        {/* 客服账号管理 */}
        <div id="sec-agents" className="bg-white dark:bg-gray-900 rounded-card shadow-card p-5 scroll-mt-4">
          <div className="text-sm font-medium text-gray-700 dark:text-gray-200 mb-4">客服账号</div>
          <div className="space-y-2 mb-4">
            {agents.map((a) => (
              <div key={a.id} className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-2">
                  <span className="text-gray-700 dark:text-gray-200">{a.display_name}</span>
                  <span className="text-xs text-gray-400">@{a.username}</span>
                  {a.role === 'admin' && (
                    <span className="text-[10px] bg-purple-100 text-purple-600 rounded px-1">管理员</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-[10px] text-gray-400 flex items-center gap-1">
                    上限
                    <input
                      type="number"
                      min={0}
                      className="w-12 border dark:border-gray-700 dark:bg-gray-800 rounded px-1 py-0.5 text-xs"
                      defaultValue={a.max_concurrent ?? 20}
                      disabled={me?.role !== 'admin'}
                      onBlur={async (e) => {
                        const n = Number(e.target.value)
                        if (me?.role !== 'admin' || Number.isNaN(n) || n === (a.max_concurrent ?? 20)) return
                        await api.updateAgent(a.id, { max_concurrent: n })
                        toast.success(`${a.display_name} 接待上限已设为 ${n}`)
                        refresh()
                      }}
                    />
                  </label>
                  <span className={`text-xs ${a.status === 'active' ? 'text-green-600' : 'text-gray-400'}`}>
                    {a.status === 'active' ? '接待中' : a.status === 'resting' ? '休息中' : '离线'}
                  </span>
                  {me?.role === 'admin' && a.id !== me.id && (
                    <button
                      onClick={async () => {
                        const ok = await confirmDialog({
                          title: `删除客服「${a.display_name}」？`,
                          message: '删除后该账号无法登录，历史接待记录保留。',
                          confirmText: '删除',
                          danger: true,
                        })
                        if (!ok) return
                        await api.deleteAgent(a.id)
                        toast.success('客服已删除')
                        refresh()
                      }}
                      className="text-xs text-red-400 hover:text-red-600"
                    >
                      删除
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
          {me?.role === 'admin' && (
            <form onSubmit={createAgent} className="border-t pt-3 space-y-2">
              <div className="flex gap-2">
                <input className="flex-1 border dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 rounded px-2 py-1.5 text-xs outline-none focus:border-blue-500" placeholder="账号" value={username} onChange={(e) => setUsername(e.target.value)} />
                <input className="flex-1 border dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 rounded px-2 py-1.5 text-xs outline-none focus:border-blue-500" placeholder="姓名" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
              </div>
              <div className="flex gap-2">
                <input className="flex-1 border dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 rounded px-2 py-1.5 text-xs outline-none focus:border-blue-500" placeholder="密码" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
                <button className="bg-blue-600 text-white text-xs rounded px-4">添加客服</button>
              </div>
            </form>
          )}
        </div>

        <div id="sec-banned" className="bg-white dark:bg-gray-900 rounded-card shadow-card p-5 col-span-2 scroll-mt-4">
          <div className="text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">违禁词库</div>
          <div className="text-xs text-gray-400 mb-3">出站词用于过滤 AI/客服回复中的极限词；入口词用于识别用户风险内容。</div>
          <div className="flex flex-wrap gap-1.5 mb-3">
            {banned.map((w) => (
              <span key={w.id} className="text-xs bg-gray-100 dark:bg-gray-800 rounded-full px-2 py-1 inline-flex items-center gap-1">
                {w.word}
                <span className="text-[10px] text-gray-400">{w.direction === 'in' ? '入口' : '出口'}·{w.category}</span>
                {me?.role === 'admin' && (
                  <button
                    onClick={async () => {
                      await api.deleteBannedWord(w.id)
                      toast.info('已删除')
                      refresh()
                    }}
                    className="text-red-400 hover:text-red-600"
                  >
                    ×
                  </button>
                )}
              </span>
            ))}
            {banned.length === 0 && <span className="text-xs text-gray-400">暂无自定义违禁词</span>}
          </div>
          {me?.role === 'admin' && (
            <form
              onSubmit={async (e) => {
                e.preventDefault()
                if (!bannedWord.trim()) return
                await api.addBannedWord(bannedWord.trim(), bannedCat)
                setBannedWord('')
                toast.success('已加入词库')
                refresh()
              }}
              className="flex gap-2"
            >
              <input
                value={bannedWord}
                onChange={(e) => setBannedWord(e.target.value)}
                placeholder="违禁词"
                className="w-40 border dark:border-gray-700 dark:bg-gray-800 rounded px-2 py-1.5 text-xs outline-none"
              />
              <input
                value={bannedCat}
                onChange={(e) => setBannedCat(e.target.value)}
                placeholder="分类"
                className="w-28 border dark:border-gray-700 dark:bg-gray-800 rounded px-2 py-1.5 text-xs outline-none"
              />
              <button className="bg-blue-600 text-white text-xs rounded px-3">添加</button>
            </form>
          )}
        </div>

        {/* RPA 通道状态 */}
        <div id="sec-rpa" className="bg-white dark:bg-gray-900 rounded-card shadow-card p-5 col-span-2 scroll-mt-4">
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

          {/* 失败消息处置：重发回到 outbox 待 Worker 拉取；忽略后不再计入失败 */}
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
                        onClick={async () => { await api.retryRpaOutbox(m.outbox_id); toast.success('已重新入队'); refresh() }}
                        className="text-blue-500 hover:text-blue-700"
                      >
                        重发
                      </button>
                      <button
                        onClick={async () => { await api.discardRpaOutbox(m.outbox_id); toast.info('已忽略该消息'); refresh() }}
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

        {/* 队列运维（仅管理员）：失败任务可见性 + 手动重试 */}
        {me?.role === 'admin' && (
          <div id="sec-queue" className="bg-white dark:bg-gray-900 rounded-card shadow-card p-5 col-span-2 scroll-mt-4">
            <div className="flex items-center justify-between mb-1">
              <div className="text-sm font-medium text-gray-700 dark:text-gray-200">队列运维（后台任务）</div>
              {queueOps && (
                <div className="text-xs text-gray-400">
                  待处理 {queueOps.pending} ·
                  <span className={queueOps.failed > 0 ? 'text-red-500 font-medium' : ''}> 失败 {queueOps.failed}</span>
                </div>
              )}
            </div>
            <div className="text-xs text-gray-400 mb-3">
              私信/评论入站走 fast 通道，内容生成/发布走 slow 通道，互不阻塞；失败任务自动退避重试 3 次（30s/60s/120s）后停在这里。
            </div>
            {!queueOps || queueOps.items.length === 0 ? (
              <div className="text-xs text-gray-300 dark:text-gray-600 text-center py-4">暂无失败任务</div>
            ) : (
              <div className="space-y-1.5 max-h-56 overflow-y-auto">
                {queueOps.items.map((t) => (
                  <div key={t.id} className="flex items-center justify-between text-xs border dark:border-gray-700 rounded px-2.5 py-1.5">
                    <div className="min-w-0 flex-1">
                      <span className="text-blue-600 dark:text-blue-400 font-medium">
                        {TASK_TYPE_LABELS[t.task_type] || t.task_type}
                      </span>
                      <span className="text-gray-400 ml-2">#{t.id} · 重试 {t.retries} 次</span>
                      <div className="text-gray-400 truncate">{t.error}</div>
                      <div className="text-gray-300 dark:text-gray-600">
                        {t.updated_at ? new Date(t.updated_at).toLocaleString() : ''}
                      </div>
                    </div>
                    <button
                      onClick={async () => {
                        try {
                          await api.retryQueueTask(t.id)
                          toast.success('已重新入队')
                          refresh()
                        } catch (e: any) {
                          toast.error(e.message || '重试失败')
                        }
                      }}
                      className="ml-3 shrink-0 text-blue-500 hover:text-blue-700"
                    >
                      重试
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 快捷回复库 */}
        <div id="sec-quick" className="bg-white dark:bg-gray-900 rounded-card shadow-card p-5 col-span-2 scroll-mt-4">
          <div className="text-sm font-medium text-gray-700 dark:text-gray-200 mb-4">快捷回复库（口语化模板）</div>
          <div className="grid grid-cols-2 gap-2 mb-4">
            {quickReplies.map((q) => (
              <div key={q.id} className="flex items-center justify-between border dark:border-gray-700 rounded-lg px-3 py-2 text-sm">
                <div>
                  <span className="font-medium text-gray-700 dark:text-gray-200">{q.title}</span>
                  <span className="text-[10px] text-gray-400 ml-1">{q.agent_id ? '我的' : '团队'}</span>
                  <span className="text-gray-400 dark:text-gray-500 ml-2 text-xs">{q.content}</span>
                </div>
                <button onClick={async () => { await api.deleteQuickReply(q.id); toast.info('已删除'); refresh() }} className="text-xs text-red-400 hover:text-red-600">
                  删除
                </button>
              </div>
            ))}
          </div>
          <form onSubmit={createQr} className="flex gap-2 items-center">
            <input className="w-40 border dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 rounded px-2 py-1.5 text-xs outline-none focus:border-blue-500" placeholder="标题" value={qrTitle} onChange={(e) => setQrTitle(e.target.value)} />
            <input className="flex-1 border dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 rounded px-2 py-1.5 text-xs outline-none focus:border-blue-500" placeholder="内容（口语化，像真人说话）" value={qrContent} onChange={(e) => setQrContent(e.target.value)} />
            <label className="text-xs text-gray-500 flex items-center gap-1 shrink-0">
              <input type="checkbox" checked={qrPersonal} onChange={(e) => setQrPersonal(e.target.checked)} />
              仅自己
            </label>
            <button className="bg-blue-600 text-white text-xs rounded px-4">添加</button>
          </form>
        </div>

        {/* 操作审计日志（仅管理员） */}
        {me?.role === 'admin' && (
          <div id="sec-audit" className="bg-white dark:bg-gray-900 rounded-card shadow-card p-5 col-span-2 scroll-mt-4">
            <div className="flex items-center justify-between mb-3">
              <div className="text-sm font-medium text-gray-700 dark:text-gray-200">操作审计日志</div>
              <button
                onClick={async () => {
                  const cases = await api.exportBadCases()
                  const blob = new Blob([JSON.stringify(cases, null, 2)], { type: 'application/json' })
                  const a = document.createElement('a')
                  a.href = URL.createObjectURL(blob)
                  a.download = 'badcase-cases.json'
                  a.click()
                  URL.revokeObjectURL(a.href)
                  toast.success(`已导出 ${cases.length} 条 badcase`)
                }}
                className="text-xs text-blue-500 hover:underline"
              >
                导出 badcase（evals 格式，{`人工审阅后合入 backend/evals/cases.json`}）
              </button>
            </div>
            {auditLogs.length === 0 ? (
              <div className="text-xs text-gray-300 text-center py-6">暂无操作记录</div>
            ) : (
              <div className="space-y-1 max-h-64 overflow-y-auto">
                {auditLogs.map((l) => (
                  <div key={l.id} className="flex items-center gap-3 text-xs border-b border-gray-50 dark:border-gray-800 py-1.5">
                    <span className="text-gray-400 dark:text-gray-500 shrink-0">{new Date(l.created_at).toLocaleString()}</span>
                    <span className="text-gray-700 dark:text-gray-200 font-medium shrink-0">{l.agent_name}</span>
                    <span className="text-blue-600 dark:text-blue-400 shrink-0">{ACTION_LABELS[l.action] || l.action}</span>
                    <span className="text-gray-400 dark:text-gray-500 truncate">{l.target} {l.detail}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      </div>
    </div>
  )
}
