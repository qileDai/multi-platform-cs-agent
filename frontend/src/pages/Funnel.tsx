import clsx from 'clsx'
import dayjs from 'dayjs'
import { Filter } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { api, FunnelOverview } from '../api/client'
import Empty from '../components/ui/Empty'
import Skeleton from '../components/ui/Skeleton'
import { toast } from '../components/ui/toast'

const STAGE_META: { key: string; label: string; color: string }[] = [
  { key: 'comment', label: '评论互动', color: 'bg-blue-500' },
  { key: 'dm', label: '私信暗号', color: 'bg-indigo-500' },
  { key: 'lead', label: '留资推送', color: 'bg-amber-500' },
  { key: 'wecom', label: '加企微', color: 'bg-emerald-500' },
]

const CONV_META: { key: string; label: string }[] = [
  { key: 'dm_rate', label: '评论→私信' },
  { key: 'lead_rate', label: '私信→留资' },
  { key: 'wecom_rate', label: '留资→企微' },
]

const PLATFORM_LABEL: Record<string, string> = {
  douyin: '抖音', xiaohongshu: '小红书', mock: 'Mock', unknown: '未识别',
}

export default function Funnel() {
  const [days, setDays] = useState(7)
  const [data, setData] = useState<FunnelOverview | null>(null)
  const [events, setEvents] = useState<any[]>([])
  const [stageFilter, setStageFilter] = useState('')
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [ov, ev] = await Promise.all([
        api.funnelOverview(days),
        api.funnelEvents(stageFilter, 100),
      ])
      setData(ov)
      setEvents(ev.items)
    } catch (e: any) {
      toast.error(e.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }, [days, stageFilter])

  useEffect(() => {
    load()
  }, [load])

  const maxStage = Math.max(1, ...(STAGE_META.map((s) => data?.stages[s.key] ?? 0)))

  return (
    <div className="h-full flex flex-col bg-gray-50 dark:bg-gray-950">
      <div className="bg-white dark:bg-gray-900 border-b dark:border-gray-700 px-6 py-4 flex items-center">
        <div>
          <h1 className="text-lg font-medium text-gray-800 dark:text-gray-100">引流漏斗</h1>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
            评论互动 → 私信暗号 → 留资推送 → 加企微，全链路归因到账号与内容
          </p>
        </div>
        <span className="flex-1" />
        <select
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          className="text-xs border dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 rounded px-2 py-1.5"
        >
          <option value={7}>近 7 天</option>
          <option value={14}>近 14 天</option>
          <option value={30}>近 30 天</option>
        </select>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        {loading || !data ? (
          <Skeleton rows={4} className="max-w-4xl" />
        ) : (
          <>
            {/* 漏斗主体 */}
            <div className="bg-white dark:bg-gray-900 rounded-card shadow-card p-5 max-w-4xl">
              <div className="flex items-end justify-between gap-3">
                {STAGE_META.map((s) => {
                  const value = data.stages[s.key] ?? 0
                  return (
                    <div key={s.key} className="flex-1 text-center">
                      <div className="text-xl font-semibold text-gray-800 dark:text-gray-100">{value}</div>
                      <div className="mt-2 mx-auto w-full max-w-[140px]">
                        <div
                          className={clsx('mx-auto rounded-t-md transition-all', s.color)}
                          style={{ height: 8 + Math.round((value / maxStage) * 72) }}
                        />
                      </div>
                      <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">{s.label}</div>
                    </div>
                  )
                })}
              </div>
              <div className="mt-4 pt-3 border-t dark:border-gray-700 flex gap-6">
                {CONV_META.map((c) => (
                  <div key={c.key} className="text-xs text-gray-500 dark:text-gray-400">
                    {c.label}
                    <span className="ml-1.5 font-semibold text-gray-800 dark:text-gray-100">
                      {Math.round((data.conversion[c.key] ?? 0) * 100)}%
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* 平台 / 账号对比 */}
            <div className="grid grid-cols-2 gap-4 max-w-4xl">
              {([
                { title: '按平台', map: data.by_platform, labelOf: (k: string) => PLATFORM_LABEL[k] || k },
                { title: '按账号', map: data.by_account, labelOf: (k: string) => k },
              ]).map((block) => (
                <div key={block.title} className="bg-white dark:bg-gray-900 rounded-card shadow-card p-5">
                  <div className="text-sm font-medium text-gray-700 dark:text-gray-200 mb-3">{block.title}</div>
                  {Object.keys(block.map).length === 0 ? (
                    <div className="text-xs text-gray-400 py-4 text-center">暂无数据</div>
                  ) : (
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-gray-400 text-left">
                          <th className="py-1 font-normal">名称</th>
                          {STAGE_META.map((s) => (
                            <th key={s.key} className="py-1 font-normal text-right">{s.label}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {Object.entries(block.map).map(([name, row]) => (
                          <tr key={name} className="border-t dark:border-gray-800">
                            <td className="py-1.5 text-gray-700 dark:text-gray-200">{block.labelOf(name)}</td>
                            {STAGE_META.map((s) => (
                              <td key={s.key} className="py-1.5 text-right text-gray-600 dark:text-gray-300">
                                {row[s.key] ?? 0}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              ))}
            </div>

            {/* 事件明细 */}
            <div className="bg-white dark:bg-gray-900 rounded-card shadow-card p-5 max-w-4xl">
              <div className="flex items-center justify-between mb-3">
                <div className="text-sm font-medium text-gray-700 dark:text-gray-200">事件明细</div>
                <select
                  value={stageFilter}
                  onChange={(e) => setStageFilter(e.target.value)}
                  className="text-xs border dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 rounded px-2 py-1"
                >
                  <option value="">全部阶段</option>
                  {STAGE_META.map((s) => (
                    <option key={s.key} value={s.key}>{s.label}</option>
                  ))}
                </select>
              </div>
              {events.length === 0 ? (
                <Empty icon={Filter} title="暂无漏斗事件" hint="评论/私信/留资/加粉发生后自动记录" />
              ) : (
                <div className="space-y-1 max-h-80 overflow-y-auto">
                  {events.map((ev) => (
                    <div key={ev.id} className="flex items-center gap-3 text-xs border-b border-gray-50 dark:border-gray-800 py-1.5">
                      <span className="text-gray-400 shrink-0">{dayjs(ev.created_at).format('MM-DD HH:mm')}</span>
                      <span className={clsx(
                        'rounded px-2 py-0.5 shrink-0',
                        ev.stage === 'wecom' ? 'bg-emerald-100 text-emerald-600 dark:bg-emerald-900/40'
                          : ev.stage === 'lead' ? 'bg-amber-100 text-amber-600 dark:bg-amber-900/40'
                          : ev.stage === 'dm' ? 'bg-indigo-100 text-indigo-600 dark:bg-indigo-900/40'
                          : 'bg-blue-100 text-blue-600 dark:bg-blue-900/40',
                      )}>
                        {STAGE_META.find((s) => s.key === ev.stage)?.label || ev.stage}
                      </span>
                      <span className="text-gray-500">{PLATFORM_LABEL[ev.platform] || ev.platform || '-'}</span>
                      {ev.guide_code && <span className="text-purple-500">暗号:{ev.guide_code}</span>}
                      {ev.customer_id > 0 && <span className="text-gray-400">客户#{ev.customer_id}</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
