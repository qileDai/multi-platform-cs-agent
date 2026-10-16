import clsx from 'clsx'
import dayjs from 'dayjs'
import { AlertTriangle, KeyRound, Plus, RefreshCw, Trash2, Users } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { api, AccountBindingOverview, AccountHealth, MatrixAccount, RpaReply } from '../api/client'
import Empty from '../components/ui/Empty'
import Skeleton from '../components/ui/Skeleton'
import { confirmDialog, promptDialog } from '../components/ui/dialogs'
import { toast } from '../components/ui/toast'
import { useAuth } from '../store'
import { accountDutyRows, dedupeProfiles, fleetPresence, replyBody, rpaProfileBinding } from '../utils/accountBinding'

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

const REPLY_KIND: Record<string, string> = {
  text: '私信',
  image: '私信图片',
  voice: '私信语音',
  comment_reply: '评论',
  first_comment: '首评',
}

const REPLY_STATUS: Record<string, string> = {
  pending: '待发送',
  leased: '发送中',
  acked: '已发出',
  failed: '失败',
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
    mode: 'rpa' as 'rpa' | 'api',
    account_name: '',
  })
  const [replies, setReplies] = useState<RpaReply[]>([])
  const [replyKind, setReplyKind] = useState('')

  const load = useCallback(async () => {
    try {
      const [accs, healthMap, view, replyList] = await Promise.all([
        api.listAccounts(),
        api.accountsHealth().catch(() => ({}) as Record<string, AccountHealth>),
        api.accountBindingOverview().catch(() => null),
        api.listRpaReplies(replyKind).catch(() => ({ items: [] as RpaReply[] })),
      ])
      setAccounts(accs)
      setHealth(healthMap)
      setOverview(view)
      setReplies(replyList.items || [])
    } catch (e: any) {
      toast.error(e.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }, [replyKind])

  useEffect(() => {
    load()
    const timer = window.setInterval(() => { load() }, 10000)
    return () => window.clearInterval(timer)
  }, [load])

  const profiles = dedupeProfiles(overview?.workers || [])
  const fleet = fleetPresence(overview?.workers || [])
  const dutyRows = accountDutyRows(accounts, overview?.accounts, profiles)
  const accountById = new Map(accounts.map((account) => [account.id, account]))

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
        await api.createAccountFromProfile(rpaProfileBinding({
          platform: form.platform,
          duty: form.duty,
          profile_id: form.profile_id,
          profile_name: profile?.name || '',
        }))
        toast.success('已绑定环境。登录成功后，账号名会显示这个环境的名称')
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
    if (!(await confirmDialog({ title: `删除账号「${acc.account_name}」？`, message: '会删掉这个账号的全部职责绑定，发布和评论配置也会失效', danger: true }))) return
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
  const visibleAccountIds = new Set(accounts.filter((account) => {
    if (platformFilter && account.platform !== platformFilter) return false
    if (!groupFilter) return true
    return groupFilter === '__none__' ? !account.group_name : account.group_name === groupFilter
  }).map((account) => account.id))
  const visibleRows = dutyRows.filter((row) => visibleAccountIds.has(row.accountId))

  return (
    <div className="h-full flex flex-col bg-gray-50 dark:bg-gray-950">
      <div className="bg-white dark:bg-gray-900 border-b dark:border-gray-700 px-6 py-4 flex items-center">
        <div>
          <h1 className="text-lg font-medium text-gray-800 dark:text-gray-100">账号矩阵</h1>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
            一行一个职责。私信和评论要各用一个 AdsPower 环境。登录成功后，账号名先用环境名
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
              onClick={() => { setShowCreate(true); load() }}
              className="flex items-center gap-1.5 text-sm bg-blue-600 text-white rounded-lg px-4 py-2 hover:bg-blue-700"
            >
              <Plus size={15} /> 新建账号
            </button>
          </>
        )}
      </div>

      {overview && fleet === 'running' && (
        <div className="mx-6 mt-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700 dark:border-green-900/50 dark:bg-green-900/20 dark:text-green-400">
          调度器在运行。保存绑定后会自动打开对应环境。
        </div>
      )}
      {overview && fleet === 'offline' && (
        <div className="mx-6 mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900/50 dark:bg-amber-900/20 dark:text-amber-300">
          调度器已掉线。请在 Worker 电脑重新运行 run_fleet.ps1。
        </div>
      )}
      {overview && fleet === 'missing' && (
        <div className="mx-6 mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900/50 dark:bg-amber-900/20 dark:text-amber-300">
          请先在 Worker 电脑运行 run_fleet.ps1。环境列表出现后才能从下拉框选择。
        </div>
      )}

      {(overview?.workers || []).some((worker) => worker.ads_error) && (
        <div className="mx-6 mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-400">
          AdsPower 环境列表没有拉下来：
          {(overview?.workers || []).map((worker) => worker.ads_error).filter(Boolean).join('；')}
          。新建账号时可以手填环境 ID。
        </div>
      )}

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
                {visibleRows.map((row) => {
                  const acc = accountById.get(row.accountId)
                  if (!acc) return null
                  const view = overview?.accounts.find((item) => item.id === acc.id)
                  const name = acc.account_name === '待确认' ? '待确认' : acc.account_name
                  const dutyText = acc.auth_type === 'api'
                    ? '官方 API'
                    : (DUTY_LABEL[row.duty] || row.duty || '—')
                  const auth = acc.auth_type === 'api'
                    ? (acc.has_credentials ? '已授权' : '未授权')
                    : (row.authStatus
                      ? (AUTH_LABEL[row.authStatus] || row.authStatus)
                      : (view?.confirmed ? '已认出账号' : '待确认'))
                  const online = row.workerStatus ? (ONLINE_LABEL[row.workerStatus] || row.workerStatus) : '—'
                  return (
                    <tr key={row.key} className="border-b dark:border-gray-800">
                      <td className="px-4 py-3 text-gray-800 dark:text-gray-100">
                        {name}
                        {name === '待确认' && view?.profile_name ? <span className="block text-xs text-gray-400">{view.profile_name}</span> : null}
                        {row.workerStatus === 'selector_mismatch' && row.debugFile ? (
                          <span className="block text-xs text-red-500">页面快照 {row.debugFile}</span>
                        ) : null}
                        {row.accountTypeMismatch ? (
                          <span className="block text-xs text-amber-600">驱动和抖音账号类型不一致</span>
                        ) : null}
                      </td>
                      <td className="px-4 py-3">{PLATFORM_LABEL[acc.platform] || acc.platform}</td>
                      <td className="px-4 py-3">{dutyText}</td>
                      <td className="px-4 py-3 text-gray-500">{row.envLabel}</td>
                      <td className="px-4 py-3">{online}</td>
                      <td className="px-4 py-3">{auth}</td>
                      <td className="px-4 py-3 text-right space-x-2">
                        {acc.auth_type === 'api' && acc.platform === 'douyin' && (
                          <button onClick={() => goAuth(acc)} className="text-xs text-blue-600">去授权</button>
                        )}
                        {isAdmin && row.canReopen && row.bindingId != null && (
                          <button
                            onClick={() => {
                              api.reopenAccountBinding(row.bindingId as number).then(() => {
                                toast.success('已通知重新打开这个环境，请在弹出的窗口里登录')
                                load()
                              }).catch((e: Error) => toast.error(e.message))
                            }}
                            className="text-xs text-blue-600"
                          >
                            重新打开
                          </button>
                        )}
                        {isAdmin && row.canDisable && row.bindingId != null && (
                          <button
                            onClick={() => {
                              api.updateAccountBinding(row.bindingId as number, { auth_status: 'disabled' }).then(() => load())
                                .catch((e: Error) => toast.error(e.message))
                            }}
                            className="text-xs text-red-500"
                          >
                            停用
                          </button>
                        )}
                        {isAdmin && row.canEnable && row.bindingId != null && (
                          <button
                            onClick={() => {
                              api.updateAccountBinding(row.bindingId as number, { auth_status: 'pending_login' }).then(() => {
                                toast.success('已启用，调度器会重新打开这个环境')
                                load()
                              }).catch((e: Error) => toast.error(e.message))
                            }}
                            className="text-xs text-blue-600"
                          >
                            启用
                          </button>
                        )}
                        {isAdmin && row.showDelete && (
                          <button onClick={() => remove(acc)} className="text-xs text-red-500">删除</button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {!loading && (
          <div className="mt-6 bg-white dark:bg-gray-900 rounded-card shadow-card overflow-x-auto">
            <div className="px-4 py-3 flex items-center gap-3 border-b dark:border-gray-700">
              <div className="text-sm font-medium text-gray-800 dark:text-gray-100">RPA 回复记录</div>
              <select
                value={replyKind}
                onChange={(e) => setReplyKind(e.target.value)}
                className="text-xs border dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 rounded px-2 py-1"
              >
                <option value="">全部</option>
                <option value="dm">私信</option>
                <option value="comment">评论</option>
              </select>
            </div>
            {replies.length === 0 ? (
              <div className="px-4 py-6 text-xs text-gray-400">还没有 RPA 回复。私信和评论发出后会出现在这里。</div>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-xs text-gray-400 border-b dark:border-gray-700">
                  <tr>
                    <th className="text-left font-normal px-4 py-2">时间</th>
                    <th className="text-left font-normal px-4 py-2">账号</th>
                    <th className="text-left font-normal px-4 py-2">平台</th>
                    <th className="text-left font-normal px-4 py-2">类型</th>
                    <th className="text-left font-normal px-4 py-2">回复内容</th>
                    <th className="text-left font-normal px-4 py-2">状态</th>
                  </tr>
                </thead>
                <tbody>
                  {replies.map((item) => (
                    <tr key={item.outbox_id} className="border-b dark:border-gray-800">
                      <td className="px-4 py-3 text-xs text-gray-400 whitespace-nowrap">
                        {item.created_at ? dayjs(item.created_at).format('MM-DD HH:mm') : '—'}
                      </td>
                      <td className="px-4 py-3 text-gray-700 dark:text-gray-200">{item.account || '—'}</td>
                      <td className="px-4 py-3">{PLATFORM_LABEL[item.platform] || item.platform || '—'}</td>
                      <td className="px-4 py-3">{REPLY_KIND[item.msg_type] || item.msg_type}</td>
                      <td className="px-4 py-3 text-gray-800 dark:text-gray-100 max-w-md">
                        <div className="truncate">{replyBody(item.msg_type, item.content) || '—'}</div>
                        {item.status === 'failed' && item.error ? (
                          <div className="text-xs text-red-500 truncate">{item.error}</div>
                        ) : null}
                      </td>
                      <td className={clsx('px-4 py-3', item.status === 'failed' ? 'text-red-500' : 'text-gray-600 dark:text-gray-300')}>
                        {REPLY_STATUS[item.status] || item.status}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
                      value={profiles.some((item) => item.id === form.profile_id) ? form.profile_id : ''}
                      onChange={(e) => setForm({ ...form, profile_id: e.target.value })}
                      className="w-full border dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 rounded-lg px-3 py-2 text-sm mt-1"
                    >
                      <option value="">请选择已上报的环境</option>
                      {profiles.map((item) => (
                        <option key={item.id} value={item.id}>{item.name}（{item.id}）</option>
                      ))}
                    </select>
                    <input
                      value={form.profile_id}
                      onChange={(e) => setForm({ ...form, profile_id: e.target.value.trim() })}
                      placeholder="或手填环境 ID"
                      className="w-full border dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 rounded-lg px-3 py-2 text-sm mt-2"
                    />
                    <p className="text-xs text-gray-400 mt-2">私信和评论要各用一个 AdsPower 环境，不能同时绑在同一个环境上。</p>
                    {(overview?.workers || []).some((worker) => worker.ads_error) && (
                      <p className="text-xs text-red-500 mt-2">
                        {(overview?.workers || []).map((worker) => worker.ads_error).filter(Boolean).join('；')}
                      </p>
                    )}
                  </div>
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
