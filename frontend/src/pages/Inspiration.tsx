import clsx from 'clsx'
import dayjs from 'dayjs'
import { Lightbulb, Plus, Sparkles, Trash2, Wand2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, InspirationItem } from '../api/client'
import Empty from '../components/ui/Empty'
import Skeleton from '../components/ui/Skeleton'
import { confirmDialog } from '../components/ui/dialogs'
import { toast } from '../components/ui/toast'

const PLATFORM_LABEL: Record<string, string> = { douyin: '抖音', xiaohongshu: '小红书' }
const STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  new: { label: '新采集', cls: 'bg-blue-100 text-blue-600 dark:bg-blue-900/40 dark:text-blue-400' },
  analyzed: { label: '已拆解', cls: 'bg-purple-100 text-purple-600 dark:bg-purple-900/40 dark:text-purple-400' },
  used: { label: '已仿写', cls: 'bg-green-100 text-green-600 dark:bg-green-900/40 dark:text-green-400' },
}

export default function Inspiration() {
  const navigate = useNavigate()
  const [items, setItems] = useState<InspirationItem[]>([])
  const [loading, setLoading] = useState(true)
  const [platform, setPlatform] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [expanded, setExpanded] = useState<number | null>(null)
  const [busyId, setBusyId] = useState(0)
  const [form, setForm] = useState({ platform: 'xiaohongshu', title: '', source_url: '', author: '', content_text: '' })

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setItems(await api.listInspiration({ platform: platform || undefined }))
    } catch (e: any) {
      toast.error(e.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }, [platform])

  useEffect(() => {
    load()
  }, [load])

  const create = async () => {
    if (!form.title.trim()) {
      toast.error('标题必填')
      return
    }
    try {
      await api.createInspiration(form)
      toast.success('已录入灵感库')
      setShowCreate(false)
      setForm({ platform: 'xiaohongshu', title: '', source_url: '', author: '', content_text: '' })
      load()
    } catch (e: any) {
      toast.error(e.message || '录入失败')
    }
  }

  const analyze = async (item: InspirationItem) => {
    setBusyId(item.id)
    try {
      await api.analyzeInspiration(item.id)
      toast.success('AI 拆解完成')
      setExpanded(item.id)
      load()
    } catch (e: any) {
      toast.error(e.message || '拆解失败')
    } finally {
      setBusyId(0)
    }
  }

  const imitate = async (item: InspirationItem) => {
    setBusyId(item.id)
    try {
      const r = await api.imitateInspiration(item.id)
      toast.success('已创建仿写草稿，跳转到创作台生成内容')
      navigate(`/contents?item=${r.content_item_id}`)
    } catch (e: any) {
      toast.error(e.message || '仿写失败')
      setBusyId(0)
    }
  }

  const remove = async (item: InspirationItem) => {
    if (!(await confirmDialog({ title: '删除该灵感？', danger: true }))) return
    try {
      await api.deleteInspiration(item.id)
      load()
    } catch (e: any) {
      toast.error(e.message || '删除失败')
    }
  }

  return (
    <div className="h-full flex flex-col bg-gray-50 dark:bg-gray-950">
      <div className="bg-white dark:bg-gray-900 border-b dark:border-gray-700 px-6 py-4 flex items-center">
        <div>
          <h1 className="text-lg font-medium text-gray-800 dark:text-gray-100">爆款灵感库</h1>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
            手动录入或 hot_collect_worker 热榜采集 → AI 拆解标题公式/结构/钩子 → 一键仿写（参考方法论，不抄袭）
          </p>
        </div>
        <span className="flex-1" />
        <select value={platform} onChange={(e) => setPlatform(e.target.value)}
          className="text-xs border dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 rounded px-2 py-1.5 mr-3">
          <option value="">全部平台</option>
          <option value="xiaohongshu">小红书</option>
          <option value="douyin">抖音</option>
        </select>
        <button onClick={() => setShowCreate(true)}
          className="flex items-center gap-1.5 text-sm bg-blue-600 text-white rounded-lg px-4 py-2 hover:bg-blue-700">
          <Plus size={15} /> 手动录入
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {loading ? (
          <Skeleton rows={4} className="max-w-5xl" />
        ) : items.length === 0 ? (
          <Empty icon={Lightbulb} title="灵感库为空"
            hint="手动录入爆款链接，或运行 hot_collect_worker.py --keyword 品类词 自动采集热榜" />
        ) : (
          <div className="space-y-3 max-w-5xl">
            {items.map((item) => (
              <div key={item.id} className="bg-white dark:bg-gray-900 rounded-card shadow-card p-4">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs bg-blue-50 text-blue-600 dark:bg-blue-900/40 dark:text-blue-400 rounded px-2 py-0.5">
                    {PLATFORM_LABEL[item.platform] || item.platform}
                  </span>
                  <span className="text-xs bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400 rounded px-2 py-0.5">
                    {item.source === 'rpa' ? `热榜采集${item.keyword ? ` · ${item.keyword}` : ''}` : '手动录入'}
                  </span>
                  <span className={clsx('text-xs rounded px-2 py-0.5', STATUS_LABEL[item.status]?.cls)}>
                    {STATUS_LABEL[item.status]?.label || item.status}
                  </span>
                  {(item.stats_json?.digg ?? 0) > 0 && (
                    <span className="text-xs text-orange-500">👍 {item.stats_json.digg.toLocaleString()}</span>
                  )}
                  <span className="flex-1" />
                  <span className="text-xs text-gray-400">{dayjs(item.created_at).format('MM-DD HH:mm')}</span>
                </div>
                <div className="mt-2 text-sm text-gray-800 dark:text-gray-100 font-medium">{item.title}</div>
                <div className="text-xs text-gray-400 mt-0.5">
                  {item.author && <>作者：{item.author} · </>}
                  {item.source_url && (
                    <a href={item.source_url} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline">原文链接</a>
                  )}
                </div>

                {expanded === item.id && item.analysis && Object.keys(item.analysis).length > 0 && (
                  <div className="mt-3 bg-purple-50 dark:bg-purple-900/20 rounded-lg p-3 text-xs space-y-1.5">
                    <div className="font-medium text-purple-700 dark:text-purple-300">AI 拆解结论</div>
                    {item.analysis.title_formula && <div className="text-gray-700 dark:text-gray-300">标题公式：{item.analysis.title_formula}</div>}
                    {item.analysis.structure && <div className="text-gray-700 dark:text-gray-300">内容结构：{item.analysis.structure}</div>}
                    {(item.analysis.hooks || []).length > 0 && (
                      <div className="text-gray-700 dark:text-gray-300">开头钩子：{item.analysis.hooks!.join('；')}</div>
                    )}
                    {item.analysis.selling_angle && <div className="text-gray-700 dark:text-gray-300">卖点切入：{item.analysis.selling_angle}</div>}
                    {item.analysis.why_viral && <div className="text-gray-700 dark:text-gray-300">爆款原因：{item.analysis.why_viral}</div>}
                    {(item.analysis.reusable_points || []).length > 0 && (
                      <div className="text-gray-700 dark:text-gray-300">可复用要点：{item.analysis.reusable_points!.join('；')}</div>
                    )}
                  </div>
                )}
                {expanded === item.id && item.content_text && (
                  <div className="mt-2 bg-gray-50 dark:bg-gray-800 rounded-lg p-3 text-xs text-gray-600 dark:text-gray-300 whitespace-pre-wrap max-h-40 overflow-y-auto">
                    {item.content_text}
                  </div>
                )}

                <div className="mt-3 flex items-center gap-2 flex-wrap">
                  <button
                    onClick={() => setExpanded(expanded === item.id ? null : item.id)}
                    className="text-xs bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300 rounded px-3 py-1.5 hover:bg-gray-200"
                  >
                    {expanded === item.id ? '收起' : '详情'}
                  </button>
                  <button
                    onClick={() => analyze(item)}
                    disabled={busyId === item.id}
                    className="flex items-center gap-1 text-xs bg-purple-50 text-purple-600 dark:bg-purple-900/40 dark:text-purple-400 rounded px-3 py-1.5 hover:bg-purple-100 disabled:opacity-50"
                  >
                    <Sparkles size={12} /> {busyId === item.id ? '拆解中...' : item.status === 'new' ? 'AI 拆解' : '重新拆解'}
                  </button>
                  <button
                    onClick={() => imitate(item)}
                    disabled={busyId === item.id}
                    className="flex items-center gap-1 text-xs bg-blue-50 text-blue-600 dark:bg-blue-900/40 dark:text-blue-400 rounded px-3 py-1.5 hover:bg-blue-100 disabled:opacity-50"
                  >
                    <Wand2 size={12} /> 一键仿写
                  </button>
                  <button
                    onClick={() => remove(item)}
                    className="flex items-center gap-1 text-xs bg-red-50 text-red-500 dark:bg-red-900/30 rounded px-3 py-1.5 hover:bg-red-100"
                  >
                    <Trash2 size={12} /> 删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 手动录入对话框 */}
      {showCreate && (
        <div className="fixed inset-0 z-[90] bg-black/40 flex items-center justify-center" onClick={() => setShowCreate(false)}>
          <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-pop w-[480px] p-5 max-h-[80vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}>
            <div className="text-sm font-medium text-gray-800 dark:text-gray-100 mb-4">手动录入爆款</div>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-gray-500 dark:text-gray-400">平台</label>
                <select value={form.platform} onChange={(e) => setForm({ ...form, platform: e.target.value })}
                  className="w-full border dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 rounded-lg px-3 py-2 text-sm mt-1">
                  <option value="xiaohongshu">小红书</option>
                  <option value="douyin">抖音</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-gray-500 dark:text-gray-400">标题 *</label>
                <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })}
                  className="w-full border dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 rounded-lg px-3 py-2 text-sm mt-1" />
              </div>
              <div>
                <label className="text-xs text-gray-500 dark:text-gray-400">原文链接</label>
                <input value={form.source_url} onChange={(e) => setForm({ ...form, source_url: e.target.value })}
                  className="w-full border dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 rounded-lg px-3 py-2 text-sm mt-1" />
              </div>
              <div>
                <label className="text-xs text-gray-500 dark:text-gray-400">作者</label>
                <input value={form.author} onChange={(e) => setForm({ ...form, author: e.target.value })}
                  className="w-full border dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 rounded-lg px-3 py-2 text-sm mt-1" />
              </div>
              <div>
                <label className="text-xs text-gray-500 dark:text-gray-400">正文/口播文案（粘贴原文，AI 拆解更准）</label>
                <textarea value={form.content_text} onChange={(e) => setForm({ ...form, content_text: e.target.value })}
                  rows={5}
                  className="w-full border dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 rounded-lg px-3 py-2 text-sm mt-1" />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setShowCreate(false)}
                className="text-xs px-4 py-2 rounded-lg bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300">
                取消
              </button>
              <button onClick={create} className="text-xs px-4 py-2 rounded-lg text-white bg-blue-600 hover:bg-blue-700 font-medium">
                录入
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
