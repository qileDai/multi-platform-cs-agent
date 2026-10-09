import clsx from 'clsx'
import { AlertTriangle, KeyRound, Plus, RefreshCw, Trash2, Users } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { api, AccountBindingOverview, AccountHealth, MatrixAccount } from '../api/client'
import Empty from '../components/ui/Empty'
import Skeleton from '../components/ui/Skeleton'
import { confirmDialog, promptDialog } from '../components/ui/dialogs'
import { toast } from '../components/ui/toast'
import { useAuth } from '../store'

const PLATFORM_LABEL: Record<string, string> = {
  douyin: '抖音',
  xiaohongshu: '小红书',
}

const DUTY_LABEL: Record<string, string> = {
  dm: '私信',
  comment: '评论',
  publish: '发布',
}

const AUTH_LABEL: Record<string, string> = {
  pending_login: '待登录',
  authorized: '已授权',
  login_expired: '登录过期',
  disabled: '已停用',
  unbound: '未绑定',
}

const ONLINE_LABEL: Record<string, string> = {
  online: '在线',
  idle: '空闲',
  offline: '离线',
  login_expired: '登录过期',
  selector_mismatch: '选择器失效',
  browser_unavailable: '浏览器不可用',
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
  const [overview, setOverview] = useState<AccountBindingOverview | null>(null)
  const [platformFilter, setPlatformFilter] = useState('')
  const [form, setForm] = useState({
    platform: 'douyin',
    duty: 'dm',
    profile_id: '',
    worker_id: '',
    mode: 'rpa' as 'rpa' | 'api',
    account_name: '',
  })

  const load = useCallback(async () => {
    try {
      const [accs, healthMap, view] = await Promise.all([
        api.listAccounts(),
        api.accountsHealth().catch(() => ({}) as Record<string, AccountHealth>),
        api.accountBindingOverview().catch(() => null),
      ])
      setAccounts(accs)
      setHealth(healthMap)
      setOverview(view)
    } catch (e: any) {
      toast.error(e.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const profiles = (overview?.workers || []).flatMap((worker) =>
    (worker.browser_profiles || []).map((item) => ({ ...item, worker_id: worker.worker_id })),
  )
  const idleWorkers = (overview?.workers || []).filter((worker) => worker.status === 'idle')

  const create = async () => {
    try {
      if (form.mode === 'api') {
        if (!form.account_name.trim()) {
          toast.error('请填写账号名称')
          return
        }
        await api.createAccount({
          platform: form.platform, account_name: form.account_name.trim(), auth_type: 'api',
        })
        toast.success('账号已创建，请在表格里点「去授权」')
      } else {
        const profile = profiles.find((item) => item.id === form.profile_id)
        await api.createAccountFromProfile({
          platform: form.platform,
          duty: form.duty,
          adspower_profile_id: form.profile_id,
          profile_name: profile?.name || '',
          worker_id: idleWorkers.length > 1 ? form.worker_id : '',
        })
        toast.success('已绑定环境。打开页面后，账号名会改成登录的抖音或小红书号')
      }
      setShowCreate(false)
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
  const visibleAccounts = accounts.filter((account) => {
    if (platformFilter && account.platform !== platformFilter) return false
    if (!groupFilter) return true
    return groupFilter === '__none__' ? !account.group_name : account.group_name === groupFilter
  })
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const selectedView = overview?.accounts.find((item) => item.id === selectedId)

  return (
    <div className="h-full flex flex-col bg-gray-50 dark:bg-gray-950">
      <div className="bg-white dark:bg-gray-900 border-b dark:border-gray-700 px-6 py-4 flex items-center">
        <div>
          <h1 className="text-lg font-medium text-gray-800 dark:text-gray-100">账号矩阵</h1>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
            一行一个平台账号。AdsPower 环境打开后，账号名会改成页面上的登录名
          </p>
        </div>
        <select
          value={platformFilter}
          onChange={(e) => setPlatformFilter(e.target.value)}
          className="ml-4 border dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 rounded-lg px-2 py-1 text-xs"
        >
          <option value="">全部平台</option>
          <option value="douyin">抖音</option>
          <option value="xiaohongshu">小红书</option>
        </select>
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
          <div className="bg-white dark:bg-gray-900 rounded-card shadow-card overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-gray-400 border-b dark:border-gray-700">
                <tr>
                  <th className="text-left font-normal px-4 py-2">登录账号名</th>
                  <th className="text-left font-normal px-4 py-2">平台</th>
                  <th className="text-left font-normal px-4 py-2">职责</th>
                  <th className="text-left font-normal px-4 py-2">AdsPower 环境</th>
                  <th className="text-left font-normal px-4 py-2">在线状态</th>
                  <th className="text-left font-normal px-4 py-2">授权状态</th>
                  <th className="text-right font-normal px-4 py-2">操作</th>
                </tr>
              </thead>
              <tbody>
                {visibleAccounts.map((acc) => {
                  const view = overview?.accounts.find((item) => item.id === acc.id)
                  const duties = Object.values(view?.bindings || {}).filter(Boolean)
                  const dutyText = acc.auth_type === 'api'
                    ? '官方 API'
                    : (duties.map((item) => DUTY_LABEL[item!.duty] || item!.duty).join('、') || '—')
                  const envText = duties.map((item) => item!.adspower_profile_id).filter(Boolean).join('、')
                    || view?.profile_name || '—'
                  const online = duties.map((item) => item!.worker_status).find(Boolean) || '—'
                  const auth = acc.auth_type === 'api'
                    ? (acc.has_credentials ? '已授权' : '未授权')
                    : (view?.confirmed ? '已认出账号' : (duties[0] ? (AUTH_LABEL[duties[0]!.auth_status] || duties[0]!.auth_status) : '待确认'))
                  const name = !view?.confirmed && acc.auth_type === 'rpa' ? '待确认' : acc.account_name
                  return (
                    <tr
                      key={acc.id}
                      onClick={() => setSelectedId(acc.id)}
                      className="border-b dark:border-gray-800 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/60"
                    >
                      <td className="px-4 py-3 text-gray-800 dark:text-gray-100">
                        {name}
                        {name === '待确认' && view?.profile_name ? <span className="block text-xs text-gray-400">{view.profile_name}</span> : null}
                      </td>
                      <td className="px-4 py-3">{PLATFORM_LABEL[acc.platform] || acc.platform}</td>
                      <td className="px-4 py-3">{dutyText}</td>
                      <td className="px-4 py-3 text-gray-500">{envText}</td>
                      <td className="px-4 py-3">{ONLINE_LABEL[online] || online}</td>
                      <td className="px-4 py-3">{auth}</td>
                      <td className="px-4 py-3 text-right space-x-2" onClick={(e) => e.stopPropagation()}>
                        {acc.auth_type === 'api' && acc.platform === 'douyin' && (
                          <button onClick={() => goAuth(acc)} className="text-xs text-blue-600">去授权</button>
                        )}
                        {isAdmin && <button onClick={() => remove(acc)} className="text-xs text-red-500">删除</button>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {selectedView && (
              <div className="px-4 py-3 text-xs text-gray-500 border-t dark:border-gray-700 flex flex-wrap gap-3">
                {Object.values(selectedView.bindings).filter(Boolean).map((item) => (
                  <span key={item!.id}>
                    {DUTY_LABEL[item!.duty] || item!.duty} · {AUTH_LABEL[item!.auth_status] || item!.auth_status}
                    {isAdmin && item!.auth_status !== 'disabled' && (
                      <button
                        className="ml-2 text-red-500"
                        onClick={() => api.updateAccountBinding(item!.id, { auth_status: 'disabled' }).then(() => load())}
                      >
                        停用
                      </button>
                    )}
                  </span>
                ))}
              </div>
            )}
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
            <div className="text-sm font-medium text-gray-800 dark:text-gray-100 mb-4">新建账号</div>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-gray-500 dark:text-gray-400">接入</label>
                <select
                  value={form.mode}
                  onChange={(e) => setForm({ ...form, mode: e.target.value as 'rpa' | 'api' })}
                  className="w-full border dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 rounded-lg px-3 py-2 text-sm mt-1"
                >
                  <option value="rpa">AdsPower 环境</option>
                  <option value="api">官方 API</option>
                </select>
              </div>
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
              {form.mode === 'api' ? (
                <div>
                  <label className="text-xs text-gray-500 dark:text-gray-400">账号名称</label>
                  <input
                    value={form.account_name}
                    onChange={(e) => setForm({ ...form, account_name: e.target.value })}
                    className="w-full border dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 rounded-lg px-3 py-2 text-sm mt-1"
                  />
                </div>
              ) : (
                <>
                  <div>
                    <label className="text-xs text-gray-500 dark:text-gray-400">职责</label>
                    <select
                      value={form.duty}
                      onChange={(e) => setForm({ ...form, duty: e.target.value })}
                      className="w-full border dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 rounded-lg px-3 py-2 text-sm mt-1"
                    >
                      <option value="dm">私信</option>
                      <option value="comment">评论</option>
                      {form.platform === 'xiaohongshu' && <option value="publish">发布</option>}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 dark:text-gray-400">AdsPower 环境</label>
                    <select
                      value={form.profile_id}
                      onChange={(e) => setForm({ ...form, profile_id: e.target.value })}
                      className="w-full border dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 rounded-lg px-3 py-2 text-sm mt-1"
                    >
                      <option value="">请选择已上报的环境</option>
                      {profiles.map((item) => (
                        <option key={item.id} value={item.id}>{item.name}（{item.id}）</option>
                      ))}
                    </select>
                  </div>
                  {idleWorkers.length > 1 && (
                    <div>
                      <label className="text-xs text-gray-500 dark:text-gray-400">空闲进程</label>
                      <select
                        value={form.worker_id}
                        onChange={(e) => setForm({ ...form, worker_id: e.target.value })}
                        className="w-full border dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 rounded-lg px-3 py-2 text-sm mt-1"
                      >
                        <option value="">请选择</option>
                        {idleWorkers.map((item) => (
                          <option key={item.worker_id} value={item.worker_id}>{item.worker_id}</option>
                        ))}
                      </select>
                    </div>
                  )}
                </>
              )}
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
