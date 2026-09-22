import clsx from 'clsx'
import dayjs from 'dayjs'
import { BarChart3, TrendingUp } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { api, AccountReport, AnalyticsPost, ContentRoi, PostStatPoint } from '../api/client'
import Empty from '../components/ui/Empty'
import Skeleton from '../components/ui/Skeleton'
import { toast } from '../components/ui/toast'

const PLATFORM_LABEL: Record<string, string> = { douyin: '抖音', xiaohongshu: '小红书', mock: 'Mock' }
const SORT_OPTIONS = [
  { key: 'play', label: '按播放' },
  { key: 'digg', label: '按点赞' },
  { key: 'comment', label: '按评论' },
  { key: 'share', label: '按分享' },
  { key: 'collect', label: '按收藏' },
]
const FUNNEL_STAGES = [
  { key: 'comment', label: '评论' },
  { key: 'dm', label: '私信' },
  { key: 'lead', label: '留资' },
  { key: 'wecom', label: '加微' },
]

const HEALTH_LABEL: Record<string, { label: string; cls: string }> = {
  good: { label: '健康', cls: 'bg-green-100 text-green-600 dark:bg-green-900/40 dark:text-green-400' },
  warn: { label: '预警', cls: 'bg-amber-100 text-amber-600 dark:bg-amber-900/40 dark:text-amber-400' },
  bad: { label: '异常', cls: 'bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-400' },
}

export default function Analytics() {
  const [tab, setTab] = useState<'posts' | 'contents' | 'accounts'>('posts')
  const [sort, setSort] = useState('play')
  const [days, setDays] = useState(30)
  const [posts, setPosts] = useState<AnalyticsPost[]>([])
  const [roi, setRoi] = useState<ContentRoi[]>([])
  const [accountReports, setAccountReports] = useState<AccountReport[]>([])
  const [trend, setTrend] = useState<{ id: number; points: PostStatPoint[] } | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [p, r, a] = await Promise.all([
        api.analyticsPosts({ sort, days }),
        api.contentRoi(days),
        api.analyticsAccounts(days),
      ])
      setPosts(p)
      setRoi(r)
      setAccountReports(a)
    } catch (e: any) {
      toast.error(e.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }, [sort, days])

  useEffect(() => {
    load()
  }, [load])

  const openTrend = async (postId: number) => {
    try {
      const points = await api.postTrend(postId)
      setTrend({ id: postId, points })
    } catch (e: any) {
      toast.error(e.message || '趋势加载失败')
    }
  }

  return (
    <div className="h-full flex flex-col bg-gray-50 dark:bg-gray-950">
      <div className="bg-white dark:bg-gray-900 border-b dark:border-gray-700 px-6 py-4">
        <h1 className="text-lg font-medium text-gray-800 dark:text-gray-100">内容效果</h1>
        <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
          作品数据自动回采（每 4 小时），选题 ROI = 播放数据 + 引流漏斗，反哺创作选题
        </p>
      </div>

      <div className="bg-white dark:bg-gray-900 border-b dark:border-gray-700 px-6 flex items-center gap-1">
        <button
          onClick={() => setTab('posts')}
          className={clsx('px-4 py-2.5 text-sm border-b-2 -mb-px',
            tab === 'posts' ? 'border-blue-600 text-blue-600 dark:text-blue-400 font-medium' : 'border-transparent text-gray-500')}
        >
          作品排行
        </button>
        <button
          onClick={() => setTab('contents')}
          className={clsx('px-4 py-2.5 text-sm border-b-2 -mb-px',
            tab === 'contents' ? 'border-blue-600 text-blue-600 dark:text-blue-400 font-medium' : 'border-transparent text-gray-500')}
        >
          选题 ROI
        </button>
        <button
          onClick={() => setTab('accounts')}
          className={clsx('px-4 py-2.5 text-sm border-b-2 -mb-px',
            tab === 'accounts' ? 'border-blue-600 text-blue-600 dark:text-blue-400 font-medium' : 'border-transparent text-gray-500')}
        >
          账号对比
        </button>
        <span className="flex-1" />
        {tab === 'posts' && (
          <select value={sort} onChange={(e) => setSort(e.target.value)}
            className="text-xs border dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 rounded px-2 py-1.5 my-1.5">
            {SORT_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
          </select>
        )}
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}
          className="text-xs border dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 rounded px-2 py-1.5 my-1.5">
          <option value={7}>近 7 天</option>
          <option value={30}>近 30 天</option>
          <option value={90}>近 90 天</option>
        </select>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {loading ? (
          <Skeleton rows={5} className="max-w-5xl" />
        ) : tab === 'posts' ? (
          posts.length === 0 ? (
            <Empty icon={BarChart3} title="暂无作品数据" hint="发布成功后系统每 4 小时自动回采数据" />
          ) : (
            <div className="bg-white dark:bg-gray-900 rounded-card shadow-card max-w-5xl overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-gray-400 text-left border-b dark:border-gray-700">
                    <th className="px-4 py-2.5 font-normal">作品</th>
                    <th className="px-2 py-2.5 font-normal">平台/账号</th>
                    <th className="px-2 py-2.5 font-normal text-right">播放</th>
                    <th className="px-2 py-2.5 font-normal text-right">点赞</th>
                    <th className="px-2 py-2.5 font-normal text-right">评论</th>
                    <th className="px-2 py-2.5 font-normal text-right">分享</th>
                    <th className="px-2 py-2.5 font-normal text-right">收藏</th>
                    <th className="px-2 py-2.5 font-normal text-right">更新于</th>
                    <th className="px-2 py-2.5" />
                  </tr>
                </thead>
                <tbody>
                  {posts.map((p) => (
                    <tr key={p.id} className="border-b border-gray-50 dark:border-gray-800">
                      <td className="px-4 py-2.5 max-w-[240px]">
                        <div className="truncate text-gray-800 dark:text-gray-100">{p.title || '（无标题）'}</div>
                        {p.url && (
                          <a href={p.url} target="_blank" rel="noreferrer"
                            className="text-blue-400 hover:underline truncate block">{p.url}</a>
                        )}
                      </td>
                      <td className="px-2 py-2.5 text-gray-500">
                        {PLATFORM_LABEL[p.platform] || p.platform} · {p.account_name}
                      </td>
                      <td className="px-2 py-2.5 text-right font-medium text-gray-800 dark:text-gray-100">
                        {(p.stats.play ?? 0).toLocaleString()}
                      </td>
                      <td className="px-2 py-2.5 text-right text-gray-600 dark:text-gray-300">{(p.stats.digg ?? 0).toLocaleString()}</td>
                      <td className="px-2 py-2.5 text-right text-gray-600 dark:text-gray-300">{(p.stats.comment ?? 0).toLocaleString()}</td>
                      <td className="px-2 py-2.5 text-right text-gray-600 dark:text-gray-300">{(p.stats.share ?? 0).toLocaleString()}</td>
                      <td className="px-2 py-2.5 text-right text-gray-600 dark:text-gray-300">{(p.stats.collect ?? 0).toLocaleString()}</td>
                      <td className="px-2 py-2.5 text-right text-gray-400">
                        {p.stats_updated_at ? dayjs(p.stats_updated_at).format('MM-DD HH:mm') : '-'}
                      </td>
                      <td className="px-2 py-2.5 text-right">
                        <button onClick={() => openTrend(p.id)}
                          className="text-blue-500 hover:underline flex items-center gap-0.5 ml-auto">
                          <TrendingUp size={12} /> 趋势
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : tab === 'accounts' ? (
          accountReports.length === 0 ? (
            <Empty icon={BarChart3} title="暂无账号数据" hint="添加矩阵账号并发布后，这里展示账号维度对比" />
          ) : (
            <div className="bg-white dark:bg-gray-900 rounded-card shadow-card max-w-6xl overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-gray-400 text-left border-b dark:border-gray-700">
                    <th className="px-4 py-2.5 font-normal">账号</th>
                    <th className="px-2 py-2.5 font-normal">分组</th>
                    <th className="px-2 py-2.5 font-normal text-right">粉丝</th>
                    <th className="px-2 py-2.5 font-normal text-right">发布数</th>
                    <th className="px-2 py-2.5 font-normal text-right">总播放</th>
                    <th className="px-2 py-2.5 font-normal text-right">总点赞</th>
                    <th className="px-2 py-2.5 font-normal text-right">总评论</th>
                    <th className="px-2 py-2.5 font-normal text-right">留资</th>
                    <th className="px-2 py-2.5 font-normal text-right">加微</th>
                    <th className="px-2 py-2.5 font-normal text-right">发布成功率</th>
                    <th className="px-2 py-2.5 font-normal text-right">健康</th>
                  </tr>
                </thead>
                <tbody>
                  {accountReports.map((r) => (
                    <tr key={r.account_id} className="border-b border-gray-50 dark:border-gray-800">
                      <td className="px-4 py-2.5 max-w-[180px]">
                        <div className="truncate text-gray-800 dark:text-gray-100">{r.account_name}</div>
                        <div className="text-gray-400">{PLATFORM_LABEL[r.platform] || r.platform}</div>
                      </td>
                      <td className="px-2 py-2.5 text-gray-500">{r.group_name || '-'}</td>
                      <td className="px-2 py-2.5 text-right text-gray-600 dark:text-gray-300">
                        {(r.profile?.followers ?? 0) > 0 ? (r.profile.followers!).toLocaleString() : '-'}
                      </td>
                      <td className="px-2 py-2.5 text-right text-gray-600 dark:text-gray-300">{r.posts}</td>
                      <td className="px-2 py-2.5 text-right font-medium text-gray-800 dark:text-gray-100">{r.play.toLocaleString()}</td>
                      <td className="px-2 py-2.5 text-right text-gray-600 dark:text-gray-300">{r.digg.toLocaleString()}</td>
                      <td className="px-2 py-2.5 text-right text-gray-600 dark:text-gray-300">{r.comment.toLocaleString()}</td>
                      <td className={clsx('px-2 py-2.5 text-right', (r.funnel.lead ?? 0) > 0 ? 'text-emerald-600 font-medium' : 'text-gray-600 dark:text-gray-300')}>
                        {r.funnel.lead ?? 0}
                      </td>
                      <td className={clsx('px-2 py-2.5 text-right', (r.funnel.wecom ?? 0) > 0 ? 'text-emerald-600 font-medium' : 'text-gray-600 dark:text-gray-300')}>
                        {r.funnel.wecom ?? 0}
                      </td>
                      <td className="px-2 py-2.5 text-right text-gray-600 dark:text-gray-300">
                        {r.publish_success_rate === null ? '-' : `${Math.round(r.publish_success_rate * 100)}%`}
                      </td>
                      <td className="px-2 py-2.5 text-right">
                        <span className={clsx('rounded px-1.5 py-0.5', HEALTH_LABEL[r.health_level]?.cls)}>
                          {HEALTH_LABEL[r.health_level]?.label || r.health_level} {r.health_score}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : (
          roi.length === 0 ? (
            <Empty icon={BarChart3} title="暂无选题数据" hint="内容发布并回采数据后，这里展示每个选题的引流效果" />
          ) : (
            <div className="bg-white dark:bg-gray-900 rounded-card shadow-card max-w-5xl overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-gray-400 text-left border-b dark:border-gray-700">
                    <th className="px-4 py-2.5 font-normal">选题</th>
                    <th className="px-2 py-2.5 font-normal text-right">发布数</th>
                    <th className="px-2 py-2.5 font-normal text-right">总播放</th>
                    <th className="px-2 py-2.5 font-normal text-right">总点赞</th>
                    {FUNNEL_STAGES.map((s) => (
                      <th key={s.key} className="px-2 py-2.5 font-normal text-right">{s.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {roi.map((r) => (
                    <tr key={r.content_item_id} className="border-b border-gray-50 dark:border-gray-800">
                      <td className="px-4 py-2.5 max-w-[260px] truncate text-gray-800 dark:text-gray-100">{r.title}</td>
                      <td className="px-2 py-2.5 text-right text-gray-600 dark:text-gray-300">{r.posts}</td>
                      <td className="px-2 py-2.5 text-right font-medium text-gray-800 dark:text-gray-100">{r.play.toLocaleString()}</td>
                      <td className="px-2 py-2.5 text-right text-gray-600 dark:text-gray-300">{r.digg.toLocaleString()}</td>
                      {FUNNEL_STAGES.map((s) => (
                        <td key={s.key} className={clsx('px-2 py-2.5 text-right',
                          (r.funnel[s.key] ?? 0) > 0 && (s.key === 'lead' || s.key === 'wecom')
                            ? 'text-emerald-600 font-medium' : 'text-gray-600 dark:text-gray-300')}>
                          {r.funnel[s.key] ?? 0}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}
      </div>

      {/* 趋势弹窗 */}
      {trend && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => setTrend(null)}>
          <div className="bg-white dark:bg-gray-900 rounded-xl shadow-xl p-6 w-[560px]" onClick={(e) => e.stopPropagation()}>
            <div className="text-sm font-medium text-gray-800 dark:text-gray-100 mb-4">
              作品 #{trend.id} 数据趋势
            </div>
            {trend.points.length === 0 ? (
              <div className="text-xs text-gray-400 text-center py-10">暂无回采数据（下一轮回采后展示）</div>
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <AreaChart data={trend.points.map((p) => ({
                  time: dayjs(p.captured_at).format('MM-DD HH:mm'),
                  播放: p.play, 点赞: p.digg, 评论: p.comment,
                }))}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                  <XAxis dataKey="time" fontSize={11} />
                  <YAxis fontSize={11} />
                  <Tooltip />
                  <Area type="monotone" dataKey="播放" stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.15} />
                  <Area type="monotone" dataKey="点赞" stroke="#f59e0b" fill="#f59e0b" fillOpacity={0.15} />
                  <Area type="monotone" dataKey="评论" stroke="#10b981" fill="#10b981" fillOpacity={0.15} />
                </AreaChart>
              </ResponsiveContainer>
            )}
            <button onClick={() => setTrend(null)}
              className="mt-4 w-full text-xs bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 rounded-lg py-2 hover:bg-gray-200">
              关闭
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
