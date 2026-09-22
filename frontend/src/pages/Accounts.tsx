import clsx from 'clsx'
import { AlertTriangle, KeyRound, Plus, RefreshCw, Trash2, Users } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { api, AccountHealth, MatrixAccount } from '../api/client'
import Empty from '../components/ui/Empty'
import Skeleton from '../components/ui/Skeleton'
import { confirmDialog, promptDialog } from '../components/ui/dialogs'
import { toast } from '../components/ui/toast'
import { useAuth } from '../store'

const PLATFORM_LABEL: Record<string, string> = {
  douyin: '抖音',
  xiaohongshu: '小红书',
}

const STATUS_STYLE: Record<string, { label: string; cls: string }> = {
  active: { label: '正常', cls: 'bg-green-100 text-green-600 dark:bg-green-900/40 dark:text-green-400' },
  expired: { label: '授权过期', cls: 'bg-orange-100 text-orange-600 dark:bg-orange-900/40 dark:text-orange-400' },
  disabled: { label: '已停用', cls: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400' },
}

const HEALTH_DOT: Record<string, string> = {
  good: 'bg-green-500',
  warn: 'bg-amber-500',
  bad: 'bg-red-500',
}

export default function Accounts() {
  const { agent } = useAuth()
  const isAdmin = agent?.role === 'admin'
  const [accounts, setAccounts] = useState<MatrixAccount[]>([])
  const [health, setHealth] = useState<Record<string, AccountHealth>>({})
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [groupFilter, setGroupFilter] = useState('')
  const [showImport, setShowImport] = useState(false)
  const [importText, setImportText] = useState('')
  const [importResult, setImportResult] = useState<{ imported: number; failed: { line: number; content: string; error: string }[] } | null>(null)
  const [form, setForm] = useState({
    platform: 'douyin',
    account_name: '',
    auth_type: 'api',
    rpa_account: '',
    group_name: '',
  })

  const load = useCallback(async () => {
    try {
      const [accs, healthMap] = await Promise.all([
        api.listAccounts(),
        api.accountsHealth().catch(() => ({}) as Record<string, AccountHealth>),
      ])
      setAccounts(accs)
      setHealth(healthMap)
    } catch (e: any) {
      toast.error(e.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const create = async () => {
    if (!form.account_name.trim()) {
      toast.error('请填写账号名称')
      return
    }
    if (form.auth_type === 'rpa' && !form.rpa_account.trim()) {
      toast.error('RPA 账号必须填写 Worker 账号标识')
      return
    }
    try {
      await api.createAccount(form)
      // 创建只是建档：按接入方式引导下一步绑定动作
      toast.success(
        form.auth_type === 'api'
          ? '账号已创建，请点账号卡片「去授权」完成平台绑定（绑定前仅为占位档案）'
          : `账号已创建，请启动 ACCOUNT=${form.rpa_account.trim()} 的 Worker 并确认心跳在线`,
      )
      setShowCreate(false)
      setForm({ platform: 'douyin', account_name: '', auth_type: 'api', rpa_account: '', group_name: '' })
      load()
    } catch (e: any) {
      toast.error(e.message || '创建失败')
    }
  }

  const goAuth = async (acc: MatrixAccount) => {
    try {
      const { url } = await api.getAccountOauthUrl(acc.id)
      window.open(url, '_blank')
      toast.success('已打开授权页，请用对应抖音账号扫码')
    } catch (e: any) {
      toast.error(e.message || '获取授权链接失败')
    }
  }

  const refreshToken = async (acc: MatrixAccount) => {
    try {
      await api.refreshAccountToken(acc.id)
      toast.success('Token 已刷新')
      load()
    } catch (e: any) {
      toast.error(e.message || '刷新失败')
    }
  }

  const remove = async (acc: MatrixAccount) => {
    if (!(await confirmDialog({ title: `删除账号「${acc.account_name}」？`, message: '删除后该账号的发布/评论配置将失效', danger: true }))) return
    try {
      await api.deleteAccount(acc.id)
      toast.success('已删除')
      load()
    } catch (e: any) {
      toast.error(e.message || '删除失败')
    }
  }

  const toggleStatus = async (acc: MatrixAccount) => {
    const next = acc.status === 'disabled' ? 'active' : 'disabled'
    try {
      await api.updateAccount(acc.id, { status: next })
      load()
    } catch (e: any) {
      toast.error(e.message || '操作失败')
    }
  }

  const editLimit = async (acc: MatrixAccount) => {
    const v = await promptDialog({
      title: '每日发布上限',
      placeholder: '建议 ≤5，防风控',
      defaultValue: String(acc.daily_publish_limit),
    })
    if (v === null) return
    const n = parseInt(v, 10)
    if (!Number.isFinite(n) || n < 1 || n > 75) {
      toast.error('请输入 1-75 的数字')
      return
    }
    try {
      await api.updateAccount(acc.id, { daily_publish_limit: n })
      load()
    } catch (e: any) {
      toast.error(e.message || '保存失败')
    }
  }

  const editQueue = async (acc: MatrixAccount) => {
    const v = await promptDialog({
      title: `队列时段位（北京时间，逗号分隔；留空关闭队列）- ${acc.account_name}`,
      placeholder: '12:00,19:30',
      defaultValue: (acc.queue_slots || []).join(','),
    })
    if (v === null) return
    const slots = v.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
    const valid = slots.every((s) => /^([01]?\d|2[0-3]):[0-5]\d$/.test(s))
    if (!valid) {
      toast.error('时段格式应为 HH:MM，如 12:00,19:30')
      return
    }
    try {
      await api.updateAccount(acc.id, { queue_enabled: slots.length > 0, queue_slots: slots })
      toast.success(slots.length > 0 ? `队列已开启：${slots.join(' / ')}` : '队列已关闭')
      load()
    } catch (e: any) {
      toast.error(e.message || '保存失败')
    }
  }

  const badAccounts = accounts.filter((a) => health[String(a.id)]?.level === 'bad')
  // 分组筛选（distinct group_name，含计数）
  const groups = Array.from(new Set(accounts.map((a) => a.group_name).filter(Boolean)))
  const visibleAccounts = groupFilter
    ? accounts.filter((a) => (groupFilter === '__none__' ? !a.group_name : a.group_name === groupFilter))
    : accounts

  return (
    <div className="h-full flex flex-col bg-gray-50 dark:bg-gray-950">
      <div className="bg-white dark:bg-gray-900 border-b dark:border-gray-700 px-6 py-4 flex items-center">
        <div>
          <h1 className="text-lg font-medium text-gray-800 dark:text-gray-100">账号矩阵</h1>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
            多平台多账号统一管理：API 账号走官方授权，RPA 账号绑定 Worker
          </p>
        </div>
        <span className="flex-1" />
        {isAdmin && (
          <>
            <button
              onClick={() => { setShowImport(true); setImportResult(null) }}
              className="flex items-center gap-1.5 text-sm bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300 rounded-lg px-4 py-2 hover:bg-gray-200"
            >
              批量导入
            </button>
            <button
              onClick={() => setShowCreate(true)}
              className="flex items-center gap-1.5 text-sm bg-blue-600 text-white rounded-lg px-4 py-2 hover:bg-blue-700"
            >
              <Plus size={15} /> 新建账号
            </button>
          </>
        )}
      </div>

      {badAccounts.length > 0 && (
        <div className="mx-6 mt-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-400">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <div>
            <span className="font-medium">{badAccounts.length} 个账号健康异常：</span>
            {badAccounts.map((a) => `${a.account_name}（${health[String(a.id)]?.issues[0]?.message || '异常'}）`).join('；')}
          </div>
        </div>
      )}

      {groups.length > 0 && (
        <div className="mx-6 mt-4 flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setGroupFilter('')}
            className={clsx('text-xs rounded-full px-3 py-1',
              !groupFilter ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-400')}
          >
            全部（{accounts.length}）
          </button>
          {groups.map((g) => (
            <button
              key={g}
              onClick={() => setGroupFilter(g)}
              className={clsx('text-xs rounded-full px-3 py-1',
                groupFilter === g ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-400')}
            >
              {g}（{accounts.filter((a) => a.group_name === g).length}）
            </button>
          ))}
          <button
            onClick={() => setGroupFilter('__none__')}
            className={clsx('text-xs rounded-full px-3 py-1',
              groupFilter === '__none__' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-400')}
          >
            未分组（{accounts.filter((a) => !a.group_name).length}）
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-6">
        {loading ? (
          <Skeleton rows={3} className="max-w-5xl" />
        ) : accounts.length === 0 ? (
          <Empty icon={Users} title="暂无账号" hint="点击右上角「新建账号」添加第一个矩阵账号" />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 max-w-6xl">
            {visibleAccounts.map((acc) => {
              const h = health[String(acc.id)]
              const tokenDaysLeft = h?.token_expires_at
                ? Math.ceil((new Date(h.token_expires_at).getTime() - Date.now()) / 86400000)
                : null
              return (
              <div key={acc.id} className="bg-white dark:bg-gray-900 rounded-card shadow-card p-4">
                <div className="flex items-center gap-2">
                  {h && (
                    <span
                      className={clsx('w-2.5 h-2.5 rounded-full shrink-0', HEALTH_DOT[h.level] || 'bg-gray-300')}
                      title={h.issues.length > 0
                        ? `健康分 ${h.score}\n${h.issues.map((i) => i.message).join('\n')}`
                        : `健康分 ${h.score}，状态良好`}
                    />
                  )}
                  <span className="text-sm font-medium text-gray-800 dark:text-gray-100">{acc.account_name}</span>
                  <span className="text-xs bg-blue-50 text-blue-600 dark:bg-blue-900/40 dark:text-blue-400 rounded px-2 py-0.5">
                    {PLATFORM_LABEL[acc.platform] || acc.platform}
                  </span>
                  <span className="text-xs bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400 rounded px-2 py-0.5">
                    {acc.auth_type === 'api' ? '官方API' : 'RPA'}
                  </span>
                  <span className={clsx('text-xs rounded px-2 py-0.5', STATUS_STYLE[acc.status]?.cls)}>
                    {STATUS_STYLE[acc.status]?.label || acc.status}
                  </span>
                </div>
                <div className="mt-2 text-xs text-gray-400 dark:text-gray-500 space-y-1">
                  {acc.group_name && <div>分组：{acc.group_name}</div>}
                  {acc.auth_type === 'api' ? (
                    <div className="flex items-center gap-1">
                      授权：
                      {acc.has_credentials ? (
                        <span className="text-green-600 dark:text-green-400">已授权</span>
                      ) : (
                        <span className="text-orange-500">未授权</span>
                      )}
                      {tokenDaysLeft !== null && tokenDaysLeft <= 7 && (
                        <span className={clsx(tokenDaysLeft <= 0 ? 'text-red-500' : 'text-orange-500')}>
                          {tokenDaysLeft <= 0 ? '授权已过期' : `${tokenDaysLeft} 天后过期`}
                        </span>
                      )}
                    </div>
                  ) : (
                    <div>
                      Worker 账号：{acc.rpa_account}
                      {h?.worker_status && h.worker_status !== 'online' && (
                        <span className="ml-1 text-red-500">
                          （{h.worker_status === 'none' ? '无心跳' : h.worker_status}）
                        </span>
                      )}
                    </div>
                  )}
                  <div>
                    今日发布：{acc.today_published} / {acc.daily_publish_limit}
                  </div>
                  {(acc.profile?.followers ?? 0) > 0 && (
                    <div>
                      粉丝：{(acc.profile.followers!).toLocaleString()}
                      {(acc.profile?.works ?? 0) > 0 && ` · 作品 ${acc.profile.works}`}
                      {(acc.profile?.liked ?? 0) > 0 && ` · 获赞 ${(acc.profile.liked!).toLocaleString()}`}
                    </div>
                  )}
                  {acc.queue_enabled && (
                    <div className="text-amber-600 dark:text-amber-400">
                      队列：{(acc.queue_slots || []).join(' / ')}
                    </div>
                  )}
                </div>
                <div className="mt-3 flex items-center gap-2 flex-wrap">
                  {acc.auth_type === 'api' && acc.platform === 'douyin' && (
                    <button
                      onClick={() => goAuth(acc)}
                      className="flex items-center gap-1 text-xs bg-blue-50 text-blue-600 dark:bg-blue-900/40 dark:text-blue-400 rounded px-2.5 py-1.5 hover:bg-blue-100"
                    >
                      <KeyRound size={12} /> 去授权
                    </button>
                  )}
                  {acc.auth_type === 'api' && acc.has_credentials && (
                    <button
                      onClick={() => refreshToken(acc)}
                      className="flex items-center gap-1 text-xs bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300 rounded px-2.5 py-1.5 hover:bg-gray-200"
                    >
                      <RefreshCw size={12} /> 刷新Token
                    </button>
                  )}
                  {isAdmin && (
                    <>
                      <button
                        onClick={() => editLimit(acc)}
                        className="text-xs bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300 rounded px-2.5 py-1.5 hover:bg-gray-200"
                      >
                        改额度
                      </button>
                      <button
                        onClick={() => editQueue(acc)}
                        className={clsx('text-xs rounded px-2.5 py-1.5',
                          acc.queue_enabled
                            ? 'bg-amber-100 text-amber-700 hover:bg-amber-200 dark:bg-amber-900/40 dark:text-amber-400'
                            : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300')}
                      >
                        队列
                      </button>
                      <button
                        onClick={() => toggleStatus(acc)}
                        className="text-xs bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300 rounded px-2.5 py-1.5 hover:bg-gray-200"
                      >
                        {acc.status === 'disabled' ? '启用' : '停用'}
                      </button>
                      <button
                        onClick={() => remove(acc)}
                        className="flex items-center gap-1 text-xs bg-red-50 text-red-500 dark:bg-red-900/30 rounded px-2.5 py-1.5 hover:bg-red-100"
                      >
                        <Trash2 size={12} /> 删除
                      </button>
                    </>
                  )}
                </div>
              </div>
              )
            })}
          </div>
        )}
      </div>

      {/* 批量导入对话框 */}
      {showImport && (
        <div className="fixed inset-0 z-[90] bg-black/40 flex items-center justify-center" onClick={() => setShowImport(false)}>
          <div
            className="bg-white dark:bg-gray-800 rounded-2xl shadow-pop w-[520px] p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-sm font-medium text-gray-800 dark:text-gray-100 mb-2">批量导入账号</div>
            <p className="text-xs text-gray-400 mb-3">
              每行一个账号，逗号分隔：<code className="text-gray-500 dark:text-gray-300">平台,名称,接入方式,Worker标识,分组</code>
              <br />平台为 douyin/xiaohongshu；接入方式 api/rpa（留空默认 api）；RPA 必须填 Worker 标识。示例：
              <br /><code className="text-gray-500 dark:text-gray-300">douyin,主号-阿茶优选,api,,美妆线</code>
              <br /><code className="text-gray-500 dark:text-gray-300">xiaohongshu,小号-测评号,rpa,xhs_worker_1,美妆线</code>
            </p>
            <textarea
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              rows={6}
              placeholder="粘贴账号清单，每行一个"
              className="w-full border dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 rounded-lg px-3 py-2 text-sm outline-none focus:border-blue-500 font-mono"
            />
            {importResult && (
              <div className="mt-3 text-xs space-y-1 max-h-32 overflow-y-auto">
                <div className="text-green-600 dark:text-green-400">成功导入 {importResult.imported} 个</div>
                {importResult.failed.map((f) => (
                  <div key={f.line} className="text-red-500">
                    第 {f.line} 行：{f.error}（{f.content}）
                  </div>
                ))}
              </div>
            )}
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => setShowImport(false)}
                className="text-xs px-4 py-2 rounded-lg bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300"
              >
                关闭
              </button>
              <button
                onClick={async () => {
                  const lines = importText.split('\n').map((s) => s.trim()).filter(Boolean)
                  if (lines.length === 0) {
                    toast.error('请粘贴账号清单')
                    return
                  }
                  try {
                    const res = await api.importAccounts(lines)
                    setImportResult(res)
                    if (res.imported > 0) {
                      toast.success(`已导入 ${res.imported} 个账号`)
                      load()
                    }
                  } catch (e: any) {
                    toast.error(e.message || '导入失败')
                  }
                }}
                className="text-xs px-4 py-2 rounded-lg text-white bg-blue-600 hover:bg-blue-700 font-medium"
              >
                开始导入
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 新建账号对话框 */}
      {showCreate && (
        <div className="fixed inset-0 z-[90] bg-black/40 flex items-center justify-center" onClick={() => setShowCreate(false)}>
          <div
            className="bg-white dark:bg-gray-800 rounded-2xl shadow-pop w-[420px] p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-sm font-medium text-gray-800 dark:text-gray-100 mb-4">新建矩阵账号</div>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-gray-500 dark:text-gray-400">平台</label>
                <select
                  value={form.platform}
                  onChange={(e) => setForm({ ...form, platform: e.target.value })}
                  className="w-full border dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 rounded-lg px-3 py-2 text-sm mt-1"
                >
                  <option value="douyin">抖音</option>
                  <option value="xiaohongshu">小红书</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-gray-500 dark:text-gray-400">账号名称</label>
                <input
                  value={form.account_name}
                  onChange={(e) => setForm({ ...form, account_name: e.target.value })}
                  placeholder="如：主号-阿茶优选"
                  className="w-full border dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 rounded-lg px-3 py-2 text-sm mt-1 outline-none focus:border-blue-500"
                />
              </div>
              <div>
                <label className="text-xs text-gray-500 dark:text-gray-400">接入方式</label>
                <select
                  value={form.auth_type}
                  onChange={(e) => setForm({ ...form, auth_type: e.target.value })}
                  className="w-full border dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 rounded-lg px-3 py-2 text-sm mt-1"
                >
                  <option value="api">官方 API（需平台资质）</option>
                  <option value="rpa">RPA Worker（无资质门槛）</option>
                </select>
              </div>
              {form.auth_type === 'rpa' && (
                <div>
                  <label className="text-xs text-gray-500 dark:text-gray-400">Worker 账号标识</label>
                  <input
                    value={form.rpa_account}
                    onChange={(e) => setForm({ ...form, rpa_account: e.target.value })}
                    placeholder="与 Worker .env.local 的 ACCOUNT 一致"
                    className="w-full border dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 rounded-lg px-3 py-2 text-sm mt-1 outline-none focus:border-blue-500"
                  />
                </div>
              )}
              <div>
                <label className="text-xs text-gray-500 dark:text-gray-400">分组（可选）</label>
                <input
                  value={form.group_name}
                  onChange={(e) => setForm({ ...form, group_name: e.target.value })}
                  placeholder="如：美妆线"
                  className="w-full border dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 rounded-lg px-3 py-2 text-sm mt-1 outline-none focus:border-blue-500"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button
                onClick={() => setShowCreate(false)}
                className="text-xs px-4 py-2 rounded-lg bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300"
              >
                取消
              </button>
              <button onClick={create} className="text-xs px-4 py-2 rounded-lg text-white bg-blue-600 hover:bg-blue-700 font-medium">
                创建
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
