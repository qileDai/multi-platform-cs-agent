import clsx from 'clsx'
import dayjs from 'dayjs'
import { CheckCircle2, PenSquare, Plus, ShieldAlert, ShieldCheck, Sparkles, XCircle } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ContentItem, ContentVersion, KeywordSuggestion, TitleSuggestion } from '../api/client'
import Empty from '../components/ui/Empty'
import Skeleton from '../components/ui/Skeleton'
import { promptDialog } from '../components/ui/dialogs'
import { toast } from '../components/ui/toast'
import { subscribeWs, useAuth } from '../store'
import { PLATFORM_LABEL, variantLabel } from '../utils/labels'
import { countTags, isOverLimit } from '../utils/spec'

const STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  reviewing: '待审核',
  approved: '已通过',
  archived: '已归档',
}

const COMPLIANCE_STYLE: Record<string, { label: string; cls: string; icon: any }> = {
  pending: { label: '待检测', cls: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400', icon: ShieldAlert },
  passed: { label: '合规通过', cls: 'bg-green-100 text-green-600 dark:bg-green-900/40 dark:text-green-400', icon: ShieldCheck },
  failed: { label: '合规未过', cls: 'bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-400', icon: XCircle },
}

// 一稿多版变体风格与平台标签统一从 utils/labels 引入（与后端 creator/nodes.py VARIANT_STYLES 对应）

// 平台规格（与后端 creator/templates.py PLATFORM_SPECS 对应，用于实时计数提示）
const PLATFORM_SPECS: Record<string, { titleMax: number; bodyMax: number; tagMax: number }> = {
  xiaohongshu: { titleMax: 20, bodyMax: 1000, tagMax: 10 },
  douyin: { titleMax: 55, bodyMax: 300, tagMax: 5 },
}

export default function ContentStudio() {
  const { agent } = useAuth()
  const isAdmin = agent?.role === 'admin'
  const [items, setItems] = useState<ContentItem[]>([])
  const [loading, setLoading] = useState(true)
  const [current, setCurrent] = useState<ContentItem | null>(null)
  const [activeVersion, setActiveVersion] = useState(0)
  const [generating, setGenerating] = useState(false)
  const [genForm, setGenForm] = useState({ platforms: ['xiaohongshu'] as string[], content_type: 'note', variants: 1 })
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const loadList = useCallback(async () => {
    try {
      setItems(await api.listContents())
    } catch (e: any) {
      toast.error(e.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  const loadDetail = useCallback(async (id: number) => {
    try {
      const detail = await api.getContent(id)
      setCurrent(detail)
      setActiveVersion(0)
    } catch (e: any) {
      toast.error(e.message || '加载详情失败')
    }
  }, [])

  useEffect(() => {
    loadList()
  }, [loadList])

  // 灵感库「一键仿写」跳转：?item=<id> 自动定位到该内容
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const itemId = Number(params.get('item') || 0)
    if (itemId) loadDetail(itemId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 生成/复检完成实时刷新（队列异步任务）
  useEffect(
    () =>
      subscribeWs((event, data) => {
        if (event === 'content_version_updated') {
          if (current && data.item_id === current.id) loadDetail(current.id)
          loadList()
        }
      }),
    [current, loadDetail, loadList],
  )

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current) }, [])

  const createItem = async () => {
    const title = await promptDialog({ title: '新建内容', placeholder: '内容标题，如：夏季便携榨汁杯种草' })
    if (!title?.trim()) return
    const topic = await promptDialog({ title: '创作主题', placeholder: '一句话说明这篇内容讲什么', defaultValue: title })
    const points = await promptDialog({ title: '卖点（用逗号分隔）', placeholder: '如：便携,易清洗,续航久' })
    try {
      const item = await api.createContent({
        title: title.trim(),
        topic: (topic || title).trim(),
        selling_points: (points || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean),
      })
      toast.success('已创建，点击右侧「AI 生成」开始创作')
      await loadList()
      loadDetail(item.id)
    } catch (e: any) {
      toast.error(e.message || '创建失败')
    }
  }

  const generate = async () => {
    if (!current) return
    if (genForm.platforms.length === 0) {
      toast.error('至少选择一个平台')
      return
    }
    setGenerating(true)
    try {
      await api.generateContent(current.id, genForm.platforms, genForm.content_type, 0, genForm.variants)
      toast.success(genForm.variants > 1
        ? `已提交生成（每平台 ${genForm.variants} 个风格变体），稍候自动刷新`
        : '已提交生成，稍候自动刷新（生成+合规检测约 10-30 秒）')
      // 兜底轮询（WS 断开时也能看到结果）
      if (pollRef.current) clearInterval(pollRef.current)
      let n = 0
      pollRef.current = setInterval(() => {
        n += 1
        loadDetail(current.id)
        if (n >= 12 && pollRef.current) clearInterval(pollRef.current)
      }, 5000)
    } catch (e: any) {
      toast.error(e.message || '提交失败')
    } finally {
      setGenerating(false)
    }
  }

  const saveVersion = async (v: ContentVersion, patch: Partial<ContentVersion>) => {
    try {
      await api.updateVersion(v.id, patch)
      toast.success('已保存（合规状态已重置，请重新检测）')
      loadDetail(current!.id)
    } catch (e: any) {
      toast.error(e.message || '保存失败')
    }
  }

  const recheck = async (v: ContentVersion) => {
    try {
      await api.checkVersion(v.id)
      toast.success('已提交复检，稍候自动刷新')
      setTimeout(() => current && loadDetail(current.id), 6000)
    } catch (e: any) {
      toast.error(e.message || '提交失败')
    }
  }

  const submit = async () => {
    if (!current) return
    try {
      await api.submitContent(current.id)
      toast.success('已提交审核，等待管理员审批')
      loadList()
      loadDetail(current.id)
    } catch (e: any) {
      toast.error(e.message || '提交失败')
    }
  }

  const review = async (action: 'approve' | 'reject') => {
    if (!current) return
    let note = ''
    if (action === 'reject') {
      const v = await promptDialog({ title: '驳回原因（必填）', placeholder: '如：正文卖点与产品不符，请重写第二段' })
      if (v === null) return
      note = v.trim()
      if (!note) {
        toast.error('驳回必须填写原因')
        return
      }
    }
    try {
      await api.reviewContent(current.id, action, note)
      toast.success(action === 'approve' ? '审批通过，可去「发布」页创建发布任务' : '已驳回，修改后可重新提交')
      loadList()
      loadDetail(current.id)
    } catch (e: any) {
      toast.error(e.message || '审批失败')
    }
  }

  const version: ContentVersion | undefined = current?.versions?.[activeVersion]

  return (
    <div className="h-full flex bg-gray-50 dark:bg-gray-950">
      {/* 左栏：内容列表 */}
      <div className="w-64 shrink-0 border-r dark:border-gray-700 bg-white dark:bg-gray-900 flex flex-col">
        <div className="px-4 py-3 border-b dark:border-gray-700 flex items-center justify-between">
          <span className="text-sm font-medium text-gray-800 dark:text-gray-100">内容列表</span>
          <button onClick={createItem} className="text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/30 rounded p-1">
            <Plus size={16} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="p-3"><Skeleton rows={4} /></div>
          ) : items.length === 0 ? (
            <Empty icon={PenSquare} title="暂无内容" hint="点右上角 + 新建" />
          ) : (
            items.map((item) => (
              <div
                key={item.id}
                onClick={() => loadDetail(item.id)}
                className={clsx(
                  'px-4 py-3 border-b dark:border-gray-800 cursor-pointer',
                  current?.id === item.id ? 'bg-blue-50 dark:bg-blue-900/20' : 'hover:bg-gray-50 dark:hover:bg-gray-800',
                )}
              >
                <div className="text-sm text-gray-800 dark:text-gray-100 truncate">{item.title}</div>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-xs text-gray-400">{STATUS_LABEL[item.status] || item.status}</span>
                  <span className="text-xs text-gray-300 dark:text-gray-600">
                    {dayjs(item.updated_at).format('MM-DD HH:mm')}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* 中栏：版本编辑器 */}
      <div className="flex-1 flex flex-col min-w-0">
        {!current ? (
          <Empty icon={PenSquare} title="选择或新建一个内容" hint="AI 会为每个目标平台生成适配版本" />
        ) : (
          <>
            <div className="bg-white dark:bg-gray-900 border-b dark:border-gray-700 px-5 py-3">
              <div className="text-sm font-medium text-gray-800 dark:text-gray-100">{current.title}</div>
              <div className="text-xs text-gray-400 mt-0.5">主题：{current.topic}</div>
              {/* 版本 Tab */}
              <div className="flex gap-1 mt-2 flex-wrap">
                {(current.versions || []).map((v, i) => {
                  // 同平台多版本（一稿多版）时显示变体序号与风格
                  const hasSibling = (current.versions || []).some((x) => x.id !== v.id && x.platform === v.platform)
                  const variantTag = hasSibling ? ` ${variantLabel(v.variant_no)}` : ''
                  return (
                  <button
                    key={v.id}
                    onClick={() => setActiveVersion(i)}
                    className={clsx(
                      'px-3 py-1.5 text-xs rounded-t border-b-2 -mb-px',
                      i === activeVersion
                        ? 'border-blue-600 text-blue-600 dark:text-blue-400 font-medium'
                        : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300',
                    )}
                  >
                    {PLATFORM_LABEL[v.platform] || v.platform} · {v.content_type === 'video' ? '视频' : '图文'}{variantTag}
                  </button>
                  )
                })}
                {(current.versions || []).length === 0 && (
                  <span className="text-xs text-gray-400 py-1.5">还没有版本，请先在右侧生成</span>
                )}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-5">
              {version && (
                <VersionEditor version={version} onSave={saveVersion} onRecheck={recheck} />
              )}
            </div>

            {/* 审批流操作区：draft→提交审核；reviewing→管理员通过/驳回；驳回原因展示 */}
            {current.status === 'draft' && (current.versions || []).length > 0 && (
              <div className="px-5 py-3 border-t dark:border-gray-700 bg-white dark:bg-gray-900 space-y-2">
                {current.review_note && (
                  <div className="text-xs text-red-500 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded p-2">
                    上次驳回原因：{current.review_note}
                  </div>
                )}
                <button
                  onClick={submit}
                  className="flex items-center gap-1.5 text-sm bg-blue-600 text-white rounded-lg px-4 py-2 hover:bg-blue-700"
                >
                  <CheckCircle2 size={15} /> 提交审核（要求全部版本合规通过）
                </button>
              </div>
            )}
            {current.status === 'reviewing' && (
              <div className="px-5 py-3 border-t dark:border-gray-700 bg-white dark:bg-gray-900">
                {isAdmin ? (
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => review('approve')}
                      className="flex items-center gap-1.5 text-sm bg-green-600 text-white rounded-lg px-4 py-2 hover:bg-green-700"
                    >
                      <CheckCircle2 size={15} /> 审批通过
                    </button>
                    <button
                      onClick={() => review('reject')}
                      className="flex items-center gap-1.5 text-sm bg-red-50 text-red-500 dark:bg-red-900/30 rounded-lg px-4 py-2 hover:bg-red-100"
                    >
                      <XCircle size={15} /> 驳回
                    </button>
                  </div>
                ) : (
                  <div className="text-xs text-gray-400">等待管理员审批（审批权限：admin）</div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* 右栏：AI 生成面板 */}
      {current && (
        <div className="w-72 shrink-0 border-l dark:border-gray-700 bg-white dark:bg-gray-900 p-4">
          <div className="flex items-center gap-1.5 text-sm font-medium text-gray-800 dark:text-gray-100">
            <Sparkles size={15} className="text-blue-500" /> AI 生成
          </div>
          <div className="mt-3 space-y-3">
            <div>
              <label className="text-xs text-gray-500 dark:text-gray-400">目标平台</label>
              <div className="flex gap-2 mt-1">
                {['xiaohongshu', 'douyin'].map((p) => (
                  <label key={p} className="flex items-center gap-1 text-xs text-gray-600 dark:text-gray-300">
                    <input
                      type="checkbox"
                      checked={genForm.platforms.includes(p)}
                      onChange={(e) =>
                        setGenForm({
                          ...genForm,
                          platforms: e.target.checked
                            ? [...genForm.platforms, p]
                            : genForm.platforms.filter((x) => x !== p),
                        })
                      }
                    />
                    {PLATFORM_LABEL[p]}
                  </label>
                ))}
              </div>
            </div>
            <div>
              <label className="text-xs text-gray-500 dark:text-gray-400">内容形态</label>
              <select
                value={genForm.content_type}
                onChange={(e) => setGenForm({ ...genForm, content_type: e.target.value })}
                className="w-full border dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 rounded-lg px-3 py-2 text-sm mt-1"
              >
                <option value="note">图文笔记</option>
                <option value="video">短视频（口播脚本）</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-gray-500 dark:text-gray-400">每平台版数（一稿多版 A/B）</label>
              <select
                value={genForm.variants}
                onChange={(e) => setGenForm({ ...genForm, variants: Number(e.target.value) })}
                className="w-full border dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 rounded-lg px-3 py-2 text-sm mt-1"
              >
                <option value={1}>1 版（默认风格）</option>
                <option value={2}>2 版（测评风 + 提问风）</option>
                <option value={3}>3 版（测评 + 提问 + 清单）</option>
              </select>
            </div>
            <button
              onClick={generate}
              disabled={generating}
              className="w-full text-sm bg-blue-600 text-white rounded-lg px-4 py-2 hover:bg-blue-700 disabled:opacity-50"
            >
              {generating ? '提交中...' : '开始生成（含合规检测）'}
            </button>
            <p className="text-xs text-gray-400 leading-relaxed">
              生成后自动进行合规双审（违禁词库 + AI 审核），未通过会自动改写最多 2 次，仍不合规则转人工修改。
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

function VersionEditor({
  version,
  onSave,
  onRecheck,
}: {
  version: ContentVersion
  onSave: (v: ContentVersion, patch: Partial<ContentVersion>) => void
  onRecheck: (v: ContentVersion) => void
}) {
  const [form, setForm] = useState({
    title: version.title,
    body: version.body,
    script: version.script,
    cover_text: version.cover_text,
    tags: (version.tags || []).join(', '),
    first_comment: version.first_comment || '',
  })
  const [titles, setTitles] = useState<TitleSuggestion[] | null>(null)
  const [titlesLoading, setTitlesLoading] = useState(false)
  const [keywords, setKeywords] = useState<KeywordSuggestion[] | null>(null)
  const [keywordsLoading, setKeywordsLoading] = useState(false)
  const [showPreview, setShowPreview] = useState(false)

  const spec = PLATFORM_SPECS[version.platform]
  const tagCount = countTags(form.tags)

  const loadKeywords = async () => {
    setKeywordsLoading(true)
    try {
      const res = await api.suggestKeywords(version.id)
      setKeywords(res.keywords)
    } catch (e: any) {
      toast.error(e.message || '关键词分析失败')
    } finally {
      setKeywordsLoading(false)
    }
  }

  const appendTag = (word: string) => {
    const current = form.tags.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
    if (current.includes(word)) return
    setForm({ ...form, tags: [...current, word].join(', ') })
    setKeywords((prev) => prev?.map((k) => (k.word === word ? { ...k, covered: true } : k)) ?? prev)
  }
  useEffect(() => {
    setForm({
      title: version.title,
      body: version.body,
      script: version.script,
      cover_text: version.cover_text,
      tags: (version.tags || []).join(', '),
      first_comment: version.first_comment || '',
    })
  }, [version.id])

  const style = COMPLIANCE_STYLE[version.compliance_status] || COMPLIANCE_STYLE.pending
  const Icon = style.icon
  const hits = version.compliance_report?.hits || []
  const suggestions = version.compliance_report?.suggestions || []

  return (
    <div className="max-w-2xl space-y-4">
      {/* 合规状态 */}
      <div className="flex items-center gap-2">
        <span className={clsx('flex items-center gap-1 text-xs rounded px-2 py-1', style.cls)}>
          <Icon size={13} /> {style.label}
        </span>
        {/* 查重 badge：>0.9 红色警告（发布会被软拦截），0.7-0.9 黄色提示 */}
        {(version.dup_report?.max_similarity ?? 0) > 0.9 ? (
          <span className="text-xs bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-400 rounded px-2 py-1"
            title={`与版本 #${version.dup_report.similar_version_id} 相似度过高，发布需确认`}>
            查重 {(version.dup_report.max_similarity! * 100).toFixed(0)}% 高相似
          </span>
        ) : (version.dup_report?.max_similarity ?? 0) > 0.7 ? (
          <span className="text-xs bg-amber-100 text-amber-600 dark:bg-amber-900/40 dark:text-amber-400 rounded px-2 py-1"
            title={`与版本 #${version.dup_report.similar_version_id} 较相似，建议差异化改写`}>
            查重 {(version.dup_report.max_similarity! * 100).toFixed(0)}%
          </span>
        ) : (version.dup_report?.checked_at ? (
          <span className="text-xs bg-gray-100 text-gray-400 dark:bg-gray-800 rounded px-2 py-1">
            查重通过
          </span>
        ) : null)}
        <button
          onClick={() => onRecheck(version)}
          className="text-xs text-blue-600 hover:underline"
        >
          重新检测
        </button>
      </div>

      {/* 合规报告 */}
      {hits.length > 0 && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3">
          <div className="text-xs font-medium text-red-600 dark:text-red-400 mb-1">命中问题：</div>
          {hits.map((h, i) => (
            <div key={i} className="text-xs text-red-500 dark:text-red-400">
              · 「{h.word}」{h.reason}（{h.severity}）
            </div>
          ))}
          {suggestions.length > 0 && (
            <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">
              建议：{suggestions.join('；')}
            </div>
          )}
        </div>
      )}

      <Field label="标题" extra={<SpecCounter current={form.title.length} max={spec?.titleMax} />}>
        <div className="flex items-center gap-2">
          <input
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            className="flex-1 border dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 rounded-lg px-3 py-2 text-sm outline-none focus:border-blue-500"
          />
          <button
            onClick={async () => {
              setTitlesLoading(true)
              setTitles(null)
              try {
                const res = await api.suggestTitles(version.id)
                setTitles(res.titles)
              } catch (e: any) {
                toast.error(e.message || '标题助手失败')
                setTitles(null)
              } finally {
                setTitlesLoading(false)
              }
            }}
            disabled={titlesLoading}
            className="shrink-0 text-xs bg-purple-50 text-purple-600 dark:bg-purple-900/40 dark:text-purple-400 rounded-lg px-3 py-2 hover:bg-purple-100 disabled:opacity-50"
          >
            {titlesLoading ? '生成中...' : '标题助手'}
          </button>
        </div>
      </Field>
      {/* 标题助手结果：点击应用 */}
      {titles && (
        <div className="border dark:border-gray-700 rounded-lg divide-y dark:divide-gray-800 max-h-64 overflow-y-auto">
          {titles.length === 0 && (
            <div className="p-3 text-xs text-gray-400">未生成候选标题</div>
          )}
          {titles.map((t, i) => (
            <button
              key={i}
              onClick={() => {
                setForm({ ...form, title: t.text })
                setTitles(null)
                toast.success('已应用标题（记得保存）')
              }}
              className="w-full text-left px-3 py-2 hover:bg-blue-50 dark:hover:bg-blue-900/20"
            >
              <div className="text-sm text-gray-800 dark:text-gray-100">{t.text}</div>
              <div className="text-xs text-gray-400 mt-0.5">
                {t.formula} · 潜力 {Math.round(t.score)}
              </div>
            </button>
          ))}
        </div>
      )}
      <Field label="正文" extra={<SpecCounter current={form.body.length} max={spec?.bodyMax} />}>
        <textarea
          value={form.body}
          onChange={(e) => setForm({ ...form, body: e.target.value })}
          rows={8}
          className="w-full border dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 rounded-lg px-3 py-2 text-sm outline-none focus:border-blue-500"
        />
      </Field>
      {version.content_type === 'video' && (
        <Field label="口播脚本">
          <textarea
            value={form.script}
            onChange={(e) => setForm({ ...form, script: e.target.value })}
            rows={5}
            className="w-full border dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 rounded-lg px-3 py-2 text-sm outline-none focus:border-blue-500"
          />
        </Field>
      )}
      <Field label="封面文案">
        <input
          value={form.cover_text}
          onChange={(e) => setForm({ ...form, cover_text: e.target.value })}
          className="w-full border dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 rounded-lg px-3 py-2 text-sm outline-none focus:border-blue-500"
        />
      </Field>
      <Field
        label="话题标签（逗号分隔）"
        extra={
          <span className="flex items-center gap-2">
            <button
              onClick={loadKeywords}
              disabled={keywordsLoading}
              className="text-xs text-emerald-600 hover:underline disabled:opacity-50"
            >
              {keywordsLoading ? '分析中...' : '关键词埋词'}
            </button>
            <SpecCounter current={tagCount} max={spec?.tagMax} />
          </span>
        }
      >
        <input
          value={form.tags}
          onChange={(e) => setForm({ ...form, tags: e.target.value })}
          className="w-full border dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 rounded-lg px-3 py-2 text-sm outline-none focus:border-blue-500"
        />
      </Field>
      {/* 关键词埋词结果：推荐词 + 覆盖 badge + 一键加入话题标签 */}
      {keywords && (
        <div className="border dark:border-gray-700 rounded-lg divide-y dark:divide-gray-800 max-h-56 overflow-y-auto">
          {keywords.length === 0 && <div className="p-3 text-xs text-gray-400">未生成推荐关键词</div>}
          {keywords.map((k, i) => (
            <div key={i} className="flex items-center gap-2 px-3 py-2">
              <span className="text-sm text-gray-800 dark:text-gray-100">{k.word}</span>
              <span className={clsx('text-xs rounded px-1.5 py-0.5',
                k.heat === '高' ? 'bg-red-50 text-red-500 dark:bg-red-900/30'
                  : k.heat === '中' ? 'bg-amber-50 text-amber-600 dark:bg-amber-900/30'
                    : 'bg-gray-100 text-gray-400 dark:bg-gray-800')}>
                {k.heat}
              </span>
              <span className="flex-1" />
              {k.covered ? (
                <span className="text-xs bg-green-100 text-green-600 dark:bg-green-900/40 dark:text-green-400 rounded px-1.5 py-0.5">已覆盖</span>
              ) : (
                <button
                  onClick={() => appendTag(k.word)}
                  className="text-xs text-blue-600 hover:underline"
                >
                  加入标签
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      <Field label="首评引流话术（发布成功后 1-3 分钟自动发顶层评论；{code} 自动替换暗号；留空不发）">
        <input
          value={form.first_comment}
          onChange={(e) => setForm({ ...form, first_comment: e.target.value })}
          placeholder="如：需要报价单的宝子私信我回复【{code}】"
          className="w-full border dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 rounded-lg px-3 py-2 text-sm outline-none focus:border-blue-500"
        />
        <div className="text-xs text-gray-400 mt-1">
          首评禁止出现微信/电话等联系方式（引流词零容忍），只能引导私信 + 暗号
        </div>
      </Field>
      <div className="flex items-center gap-2">
        <button
          onClick={() =>
            onSave(version, {
              title: form.title,
              body: form.body,
              script: form.script,
              cover_text: form.cover_text,
              tags: form.tags.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
              first_comment: form.first_comment,
            })
          }
          className="text-sm bg-blue-600 text-white rounded-lg px-4 py-2 hover:bg-blue-700"
        >
          保存修改
        </button>
        <button
          onClick={() => setShowPreview(true)}
          className="text-sm bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300 rounded-lg px-4 py-2 hover:bg-gray-200"
        >
          预览
        </button>
      </div>
      {showPreview && <PreviewCard version={version} form={form} onClose={() => setShowPreview(false)} />}
    </div>
  )
}

function Field({ label, extra, children }: { label: string; extra?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center justify-between">
        <label className="text-xs text-gray-500 dark:text-gray-400">{label}</label>
        {extra}
      </div>
      <div className="mt-1">{children}</div>
    </div>
  )
}

function SpecCounter({ current, max }: { current: number; max?: number }) {
  if (!max) return null
  const over = isOverLimit(current, max)
  return (
    <span className={clsx('text-xs', over ? 'text-red-500 font-medium' : 'text-gray-400')}>
      {current}/{max}{over && ' 超限'}
    </span>
  )
}

/** 平台化预览卡（Phase 7）：图文 = 小红书笔记样式；视频 = 脚本预览卡。纯前端渲染当前编辑内容。 */
function PreviewCard({
  version,
  form,
  onClose,
}: {
  version: ContentVersion
  form: { title: string; body: string; script: string; cover_text: string; tags: string; first_comment: string }
  onClose: () => void
}) {
  const tags = form.tags.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
  return (
    <div className="fixed inset-0 z-[90] bg-black/50 flex items-center justify-center" onClick={onClose}>
      <div className="rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="w-[320px] max-h-[75vh] overflow-y-auto bg-white dark:bg-gray-900 rounded-xl shadow-pop overflow-hidden">
          {version.content_type === 'video' ? (
            <>
              {/* 视频：封面 + 标题 + 简介 + 口播脚本 */}
              <div className="aspect-[9/16] max-h-72 bg-gradient-to-br from-gray-800 to-black flex items-center justify-center p-4">
                <div className="text-white text-center text-lg font-medium leading-relaxed">
                  {form.cover_text || '封面文案'}
                </div>
              </div>
              <div className="p-3 space-y-2">
                <div className="text-sm font-medium text-gray-900 dark:text-gray-100">{form.title || '（无标题）'}</div>
                <div className="text-xs text-gray-500 dark:text-gray-400 whitespace-pre-wrap">{form.body}</div>
                {form.script && (
                  <div className="border-t dark:border-gray-700 pt-2">
                    <div className="text-xs font-medium text-gray-400 mb-1">口播脚本</div>
                    <div className="text-xs text-gray-600 dark:text-gray-300 whitespace-pre-wrap leading-relaxed">{form.script}</div>
                  </div>
                )}
                <div className="text-xs text-blue-500">{tags.map((t) => `#${t}`).join(' ')}</div>
              </div>
            </>
          ) : (
            <>
              {/* 图文：小红书笔记样式卡（封面文案块 + 标题 + 正文 + 话题 + 首评气泡） */}
              <div className="aspect-square bg-gradient-to-br from-rose-100 to-orange-50 dark:from-gray-800 dark:to-gray-700 flex items-center justify-center p-6">
                <div className="text-xl font-bold text-gray-800 dark:text-gray-100 text-center leading-relaxed">
                  {form.cover_text || '封面文案'}
                </div>
              </div>
              <div className="p-3 space-y-2">
                <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">{form.title || '（无标题）'}</div>
                <div className="text-xs text-gray-600 dark:text-gray-300 whitespace-pre-wrap leading-relaxed">{form.body}</div>
                <div className="text-xs text-blue-500">{tags.map((t) => `#${t}`).join(' ')}</div>
                {form.first_comment && (
                  <div className="border-t dark:border-gray-700 pt-2">
                    <div className="text-xs text-gray-400 mb-1">首评预览（发布后暗号自动替换 {'{code}'}）</div>
                    <div className="text-xs bg-gray-100 dark:bg-gray-800 rounded-lg px-2 py-1.5 text-gray-600 dark:text-gray-300">
                      {form.first_comment.replace('{code}', '暗号')}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
        <button
          onClick={onClose}
          className="mt-3 w-full text-xs bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 rounded-lg py-2 hover:bg-gray-100"
        >
          关闭预览
        </button>
      </div>
    </div>
  )
}
