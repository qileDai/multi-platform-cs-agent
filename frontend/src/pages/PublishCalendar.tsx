import clsx from 'clsx'
import dayjs from 'dayjs'
import { CalendarClock, CalendarDays, ChevronLeft, ChevronRight, Download, List, Plus, RotateCcw, XCircle, Zap } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, CalendarDay, MatrixAccount, PublishableVersion, PublishTask } from '../api/client'
import Empty from '../components/ui/Empty'
import Skeleton from '../components/ui/Skeleton'
import { confirmDialog } from '../components/ui/dialogs'
import { toast } from '../components/ui/toast'
import { subscribeWs } from '../store'
import { PLATFORM_LABEL, publishableLabel } from '../utils/labels'

const STATUS_STYLE: Record<string, { label: string; cls: string }> = {
  pending: { label: '待发布', cls: 'bg-blue-100 text-blue-600 dark:bg-blue-900/40 dark:text-blue-400' },
  publishing: { label: '发布中', cls: 'bg-yellow-100 text-yellow-600 dark:bg-yellow-900/40 dark:text-yellow-400' },
  success: { label: '已发布', cls: 'bg-green-100 text-green-600 dark:bg-green-900/40 dark:text-green-400' },
  failed: { label: '失败', cls: 'bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-400' },
  cancelled: { label: '已取消', cls: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400' },
}

// 平台标签统一从 utils/labels 引入

export default function PublishCalendar() {
  const navigate = useNavigate()
  const [tasks, setTasks] = useState<PublishTask[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [publishable, setPublishable] = useState<PublishableVersion[]>([])
  const [accounts, setAccounts] = useState<MatrixAccount[]>([])
  const [form, setForm] = useState({ version_id: 0, account_ids: [] as number[], scheduled_at: '' })
  const [view, setView] = useState<'list' | 'calendar'>('list')
  const [month, setMonth] = useState(dayjs().format('YYYY-MM'))
  const [calDays, setCalDays] = useState<CalendarDay[]>([])
  const [calLoading, setCalLoading] = useState(false)
  const [bestSlotHint, setBestSlotHint] = useState('')

  const load = useCallback(async () => {
    try {
      setTasks(await api.listPublishTasks())
    } catch (e: any) {
      toast.error(e.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  const loadCalendar = useCallback(async () => {
    setCalLoading(true)
    try {
      setCalDays(await api.publishCalendar(month))
    } catch (e: any) {
      toast.error(e.message || '日历加载失败')
    } finally {
      setCalLoading(false)
    }
  }, [month])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    if (view === 'calendar') loadCalendar()
  }, [view, loadCalendar])

  useEffect(
    () =>
      subscribeWs((event) => {
        if (event === 'publish_task_updated') {
          load()
          if (view === 'calendar') loadCalendar()
        }
      }),
    [load, loadCalendar, view],
  )

  // 选中单个账号时拉取最佳时段提示
  useEffect(() => {
    if (form.account_ids.length !== 1) {
      setBestSlotHint('')
      return
    }
    api.bestSlots(form.account_ids[0])
      .then((r) => setBestSlotHint(
        `推荐时段：${r.slots.join(' / ')}（${r.source === 'history' ? '按该账号历史播放数据' : '平台黄金时段默认'}）`))
      .catch(() => setBestSlotHint(''))
  }, [form.account_ids])

  const enqueue = async (force = false) => {
    if (!form.version_id || form.account_ids.length === 0) {
      toast.error('请选择内容版本和账号')
      return
    }
    try {
      const created = await api.enqueuePublish({
        content_version_id: form.version_id, account_ids: form.account_ids, force,
      })
      toast.success(`已加入队列：${created.map((t) => `${t.account_name} ${dayjs(t.scheduled_at).format('MM-DD HH:mm')}`).join('；')}`)
      setShowCreate(false)
      load()
      if (view === 'calendar') loadCalendar()
    } catch (e: any) {
      if (!force && typeof e.message === 'string' && e.message.includes('force=true')) {
        const ok = await confirmDialog({
          title: '检测到高相似内容',
          message: e.message.replace('，确认仍要发布请带 force=true', '。确认仍要入队？'),
          confirmText: '仍要入队',
          danger: true,
        })
        if (ok) return enqueue(true)
        return
      }
      toast.error(e.message || '入队失败')
    }
  }

  const dropToDay = async (date: string) => {
    const taskId = Number(sessionStorage.getItem('drag_task_id') || 0)
    if (!taskId) return
    const task = tasks.find((t) => t.id === taskId)
      || calDays.flatMap((d) => d.tasks).find((t) => t.id === taskId)
    if (!task || task.status !== 'pending') return
    const newTime = dayjs(task.scheduled_at)
    const target = dayjs(date).hour(newTime.hour()).minute(newTime.minute())
    if (target.isBefore(dayjs())) {
      toast.error('不能改到过去的时间')
      return
    }
    try {
      await api.reschedulePublishTask(taskId, target.toISOString())
      toast.success(`已改期到 ${target.format('MM-DD HH:mm')}`)
      load()
      loadCalendar()
    } catch (e: any) {
      toast.error(e.message || '改期失败')
    }
  }

  const openCreate = async () => {
    try {
      // 一次平铺查询拿到「审批+合规双通过」的版本，替代逐条拉详情的 N+1
      const [versions, accs] = await Promise.all([api.listPublishable(), api.listAccounts()])
      setPublishable(versions)
      setAccounts(accs.filter((a) => a.status === 'active'))
      setForm({ version_id: 0, account_ids: [], scheduled_at: '' })
      setShowCreate(true)
    } catch (e: any) {
      toast.error(e.message || '加载失败')
    }
  }

  const create = async (force = false) => {
    if (!form.version_id || form.account_ids.length === 0) {
      toast.error('请选择内容版本和账号')
      return
    }
    try {
      await api.createPublishTask({
        content_version_id: form.version_id,
        account_ids: form.account_ids,
        scheduled_at: form.scheduled_at ? new Date(form.scheduled_at).toISOString() : null,
        force,
      })
      toast.success('发布任务已创建（自动发布开关开启后按时间执行）')
      setShowCreate(false)
      load()
    } catch (e: any) {
      // 查重软拦截（409）：弹确认后带 force 重试
      if (!force && typeof e.message === 'string' && e.message.includes('force=true')) {
        const ok = await confirmDialog({
          title: '检测到高相似内容',
          message: e.message.replace('，确认仍要发布请带 force=true', '。确认仍要发布？'),
          confirmText: '仍要发布',
          danger: true,
        })
        if (ok) return create(true)
        return
      }
      toast.error(e.message || '创建失败')
    }
  }

  const cancel = async (task: PublishTask) => {
    if (!(await confirmDialog({ title: '取消该发布任务？' }))) return
    try {
      await api.cancelPublishTask(task.id)
      load()
    } catch (e: any) {
      toast.error(e.message || '取消失败')
    }
  }

  const retry = async (task: PublishTask) => {
    try {
      await api.retryPublishTask(task.id)
      toast.success('已重新排队')
      load()
    } catch (e: any) {
      toast.error(e.message || '重试失败')
    }
  }

  const exportPack = async (task: PublishTask) => {
    try {
      const pack = await api.exportPublishTask(task.id)
      const text = [
        `平台：${PLATFORM_LABEL[pack.platform] || pack.platform}    账号：${pack.account_name}`,
        `\n【标题】\n${pack.title}`,
        `\n【正文】\n${pack.body}`,
        `\n【话题】\n${(pack.tags || []).map((t: string) => `#${t}`).join(' ')}`,
        pack.script ? `\n【口播脚本】\n${pack.script}` : '',
        pack.cover_text ? `\n【封面文案】\n${pack.cover_text}` : '',
        `\n【素材】\n${(pack.materials || []).map((m: any) => `${window.location.origin}${m.url}`).join('\n') || '无'}`,
      ].join('')
      await navigator.clipboard.writeText(text)
      toast.success('发布包已复制到剪贴板（素材链接在浏览器打开下载）')
    } catch (e: any) {
      toast.error(e.message || '导出失败')
    }
  }

  // 可选版本：后端已平铺（审批通过 + 合规通过），此处只补展示标签（含变体风格标识）
  const versionOptions = publishable.map((v) => ({
    id: v.version_id,
    platform: v.platform,
    label: publishableLabel(v),
  }))
  const selectedPlatform = versionOptions.find((v) => v.id === form.version_id)?.platform || ''
  const candidateAccounts = accounts.filter((a) => !selectedPlatform || a.platform === selectedPlatform)

  return (
    <div className="h-full flex flex-col bg-gray-50 dark:bg-gray-950">
      <div className="bg-white dark:bg-gray-900 border-b dark:border-gray-700 px-6 py-4 flex items-center">
        <div>
          <h1 className="text-lg font-medium text-gray-800 dark:text-gray-100">发布计划</h1>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
            定时发布到矩阵账号；自动发布总开关在「设置」页（默认关闭，可先导出发布包人工发）
          </p>
        </div>
        <span className="flex-1" />
        <div className="flex items-center gap-1 mr-3 bg-gray-100 dark:bg-gray-800 rounded-lg p-0.5">
          <button
            onClick={() => setView('list')}
            className={clsx('flex items-center gap-1 text-xs rounded-md px-3 py-1.5',
              view === 'list' ? 'bg-white dark:bg-gray-900 shadow text-gray-800 dark:text-gray-100' : 'text-gray-500')}
          >
            <List size={13} /> 列表
          </button>
          <button
            onClick={() => setView('calendar')}
            className={clsx('flex items-center gap-1 text-xs rounded-md px-3 py-1.5',
              view === 'calendar' ? 'bg-white dark:bg-gray-900 shadow text-gray-800 dark:text-gray-100' : 'text-gray-500')}
          >
            <CalendarDays size={13} /> 日历
          </button>
        </div>
        <button
          onClick={openCreate}
          className="flex items-center gap-1.5 text-sm bg-blue-600 text-white rounded-lg px-4 py-2 hover:bg-blue-700"
        >
          <Plus size={15} /> 新建发布任务
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {view === 'calendar' ? (
          <CalendarGrid
            month={month}
            days={calDays}
            loading={calLoading}
            onMonthChange={setMonth}
            onDropTask={dropToDay}
          />
        ) : loading ? (
          <Skeleton rows={4} className="max-w-5xl" />
        ) : tasks.length === 0 ? (
          <Empty icon={CalendarClock} title="暂无发布任务" hint="先在「创作」页生成内容并审核通过" />
        ) : (
          <div className="space-y-3 max-w-5xl">
            {tasks.map((task) => (
              <div key={task.id} className="bg-white dark:bg-gray-900 rounded-card shadow-card p-4">
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="text-xs bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400 rounded px-2 py-0.5">
                    {PLATFORM_LABEL[task.platform] || task.platform}
                  </span>
                  <span className="text-sm text-gray-800 dark:text-gray-100">{task.account_name}</span>
                  <span className={clsx('text-xs rounded px-2 py-0.5', STATUS_STYLE[task.status]?.cls)}>
                    {STATUS_STYLE[task.status]?.label || task.status}
                  </span>
                  {task.retries > 0 && (
                    <span className="text-xs text-orange-500">重试 {task.retries} 次</span>
                  )}
                  <span className="flex-1" />
                  <span className="text-xs text-gray-400">
                    计划 {dayjs(task.scheduled_at).format('MM-DD HH:mm')}
                  </span>
                  {task.published_at && (
                    <span className="text-xs text-gray-400">
                      发布 {dayjs(task.published_at).format('MM-DD HH:mm')}
                    </span>
                  )}
                </div>
                {task.error && (
                  <div className="mt-2 text-xs text-red-500 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded p-2">
                    {task.error}
                  </div>
                )}
                {task.post_url && (
                  <div className="mt-2 text-xs">
                    <a href={task.post_url} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline break-all">
                      {task.post_url}
                    </a>
                  </div>
                )}
                <div className="mt-3 flex items-center gap-2">
                  <button
                    onClick={() => exportPack(task)}
                    className="flex items-center gap-1 text-xs bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300 rounded px-3 py-1.5 hover:bg-gray-200"
                  >
                    <Download size={12} /> 导出发布包
                  </button>
                  {task.status === 'failed' && (
                    <button
                      onClick={() => retry(task)}
                      className="flex items-center gap-1 text-xs bg-blue-50 text-blue-600 dark:bg-blue-900/40 dark:text-blue-400 rounded px-3 py-1.5 hover:bg-blue-100"
                    >
                      <RotateCcw size={12} /> 重试
                    </button>
                  )}
                  {(task.status === 'pending' || task.status === 'failed') && (
                    <button
                      onClick={() => cancel(task)}
                      className="flex items-center gap-1 text-xs bg-red-50 text-red-500 dark:bg-red-900/30 rounded px-3 py-1.5 hover:bg-red-100"
                    >
                      <XCircle size={12} /> 取消
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 新建任务对话框 */}
      {showCreate && (
        <div className="fixed inset-0 z-[90] bg-black/40 flex items-center justify-center" onClick={() => setShowCreate(false)}>
          <div
            className="bg-white dark:bg-gray-800 rounded-2xl shadow-pop w-[460px] p-5 max-h-[80vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-sm font-medium text-gray-800 dark:text-gray-100 mb-4">新建发布任务</div>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-gray-500 dark:text-gray-400">内容版本（仅显示已通过审批且合规通过的版本）</label>
                {publishable.length === 0 ? (
                  <div className="mt-1 border border-dashed dark:border-gray-600 rounded-lg p-3 text-xs text-gray-500 dark:text-gray-400 space-y-1.5">
                    <div className="font-medium text-gray-600 dark:text-gray-300">没有可发布的内容</div>
                    <div>内容需满足三道闸才能发布：</div>
                    <div>① AI 生成版本 → ② 全部版本合规通过 → ③ 提交审核并由管理员审批通过</div>
                    <button
                      onClick={() => { setShowCreate(false); navigate('/contents') }}
                      className="text-blue-500 hover:text-blue-600 font-medium"
                    >
                      → 去创作台处理
                    </button>
                  </div>
                ) : (
                  <select
                    value={form.version_id}
                    onChange={(e) => setForm({ ...form, version_id: Number(e.target.value), account_ids: [] })}
                    className="w-full border dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 rounded-lg px-3 py-2 text-sm mt-1"
                  >
                    <option value={0}>请选择</option>
                    {versionOptions.map((v) => (
                      <option key={v.id} value={v.id}>{v.label}</option>
                    ))}
                  </select>
                )}
              </div>
              <div>
                <label className="text-xs text-gray-500 dark:text-gray-400">
                  目标账号{selectedPlatform ? `（${PLATFORM_LABEL[selectedPlatform]}）` : ''}（可多选）
                </label>
                <div className="mt-1 space-y-1 max-h-40 overflow-y-auto border dark:border-gray-600 rounded-lg p-2">
                  {candidateAccounts.length === 0 && (
                    <div className="text-xs text-gray-400 py-2 text-center">无可用账号（需与内容平台匹配且状态正常）</div>
                  )}
                  {candidateAccounts.map((a) => (
                    <label key={a.id} className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300 py-1">
                      <input
                        type="checkbox"
                        checked={form.account_ids.includes(a.id)}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            account_ids: e.target.checked
                              ? [...form.account_ids, a.id]
                              : form.account_ids.filter((x) => x !== a.id),
                          })
                        }
                      />
                      {a.account_name}（今日 {a.today_published}/{a.daily_publish_limit}）
                    </label>
                  ))}
                </div>
              </div>
              <div>
                <label className="text-xs text-gray-500 dark:text-gray-400">计划时间（留空 = 立即执行）</label>
                <input
                  type="datetime-local"
                  value={form.scheduled_at}
                  onChange={(e) => setForm({ ...form, scheduled_at: e.target.value })}
                  className="w-full border dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 rounded-lg px-3 py-2 text-sm mt-1"
                />
                {bestSlotHint && (
                  <div className="text-xs text-amber-600 dark:text-amber-400 mt-1">{bestSlotHint}</div>
                )}
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button
                onClick={() => setShowCreate(false)}
                className="text-xs px-4 py-2 rounded-lg bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300"
              >
                取消
              </button>
              <button
                onClick={() => enqueue()}
                title="按账号时段位自动占坑（账号需开启队列模式）"
                className="flex items-center gap-1 text-xs px-4 py-2 rounded-lg text-amber-700 bg-amber-100 hover:bg-amber-200 dark:bg-amber-900/40 dark:text-amber-400 font-medium"
              >
                <Zap size={12} /> 加入队列
              </button>
              <button onClick={() => create()} className="text-xs px-4 py-2 rounded-lg text-white bg-blue-600 hover:bg-blue-700 font-medium">
                创建
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** 月历格子视图：任务按状态着色，待发布任务可拖拽改期（保留原时刻）。 */
function CalendarGrid({
  month, days, loading, onMonthChange, onDropTask,
}: {
  month: string
  days: CalendarDay[]
  loading: boolean
  onMonthChange: (m: string) => void
  onDropTask: (date: string) => void
}) {
  const monthStart = dayjs(`${month}-01`)
  const firstCell = monthStart.subtract((monthStart.day() + 6) % 7, 'day') // 周一开头
  const cells = Array.from({ length: 42 }, (_, i) => firstCell.add(i, 'day'))
  const byDate = new Map(days.map((d) => [d.date, d.tasks]))
  const [dragOver, setDragOver] = useState('')

  return (
    <div className="max-w-6xl">
      <div className="flex items-center gap-3 mb-3">
        <button
          onClick={() => onMonthChange(monthStart.subtract(1, 'month').format('YYYY-MM'))}
          className="p-1.5 rounded-lg bg-white dark:bg-gray-900 shadow-card text-gray-500 hover:text-gray-800"
        >
          <ChevronLeft size={15} />
        </button>
        <span className="text-sm font-medium text-gray-800 dark:text-gray-100">
          {monthStart.format('YYYY 年 M 月')}
        </span>
        <button
          onClick={() => onMonthChange(monthStart.add(1, 'month').format('YYYY-MM'))}
          className="p-1.5 rounded-lg bg-white dark:bg-gray-900 shadow-card text-gray-500 hover:text-gray-800"
        >
          <ChevronRight size={15} />
        </button>
        <span className="text-xs text-gray-400 ml-2">拖拽「待发布」任务到其他日期即可改期（保留原时刻）</span>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center text-xs text-gray-400 mb-1">
        {['一', '二', '三', '四', '五', '六', '日'].map((d) => <div key={d}>周{d}</div>)}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {cells.map((cell) => {
          const key = cell.format('YYYY-MM-DD')
          const dayTasks = byDate.get(key) || []
          const inMonth = cell.month() === monthStart.month()
          const isToday = key === dayjs().format('YYYY-MM-DD')
          return (
            <div
              key={key}
              onDragOver={(e) => { e.preventDefault(); setDragOver(key) }}
              onDragLeave={() => setDragOver('')}
              onDrop={(e) => { e.preventDefault(); setDragOver(''); onDropTask(key) }}
              className={clsx(
                'min-h-[96px] rounded-lg border p-1.5 transition-colors',
                inMonth ? 'bg-white dark:bg-gray-900 border-gray-100 dark:border-gray-800' : 'bg-gray-50 dark:bg-gray-950 border-transparent',
                isToday && 'ring-1 ring-blue-500',
                dragOver === key && 'border-blue-400 bg-blue-50 dark:bg-blue-900/20',
              )}
            >
              <div className={clsx('text-xs mb-1', inMonth ? 'text-gray-600 dark:text-gray-300' : 'text-gray-300 dark:text-gray-600')}>
                {cell.date()}
              </div>
              <div className="space-y-1">
                {dayTasks.map((t) => (
                  <div
                    key={t.id}
                    draggable={t.status === 'pending'}
                    onDragStart={() => sessionStorage.setItem('drag_task_id', String(t.id))}
                    title={`${t.account_name} ${dayjs(t.scheduled_at).format('HH:mm')} ${STATUS_STYLE[t.status]?.label || t.status}`}
                    className={clsx(
                      'text-[10px] rounded px-1.5 py-0.5 truncate',
                      STATUS_STYLE[t.status]?.cls,
                      t.status === 'pending' && 'cursor-grab active:cursor-grabbing',
                    )}
                  >
                    {dayjs(t.scheduled_at).format('HH:mm')} {t.account_name}
                  </div>
                ))}
                {loading && inMonth && dayTasks.length === 0 && <div className="h-3" />}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
