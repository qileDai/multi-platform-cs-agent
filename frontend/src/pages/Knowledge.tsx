import clsx from 'clsx'
import { Download, FileText, FlaskConical, Plus, Upload, X } from 'lucide-react'
import { FormEvent, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { api, downloadFaqPack, KnowledgeChunk, KnowledgeDoc, MissedQuestion, RecallTestResult } from '../api/client'
import { confirmDialog } from '../components/ui/dialogs'
import Empty from '../components/ui/Empty'
import { toast } from '../components/ui/toast'

type NavKey = 'all' | 'faq' | 'file' | 'missed'

const NAV: { key: NavKey; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'faq', label: 'FAQ' },
  { key: 'file', label: '文档' },
  { key: 'missed', label: '未命中' },
]

interface Draft {
  title: string
  category: string
  question: string
  answer: string
  similars: string[]
}

const EMPTY_DRAFT: Draft = { title: '', category: '未分类', question: '', answer: '', similars: [] }

function statusLabel(status: string) {
  if (status === 'active') return '启用'
  if (status === 'disabled') return '停用'
  return '已归档'
}

export default function Knowledge() {
  const location = useLocation()
  const navigate = useNavigate()
  const [docs, setDocs] = useState<KnowledgeDoc[]>([])
  const [missed, setMissed] = useState<MissedQuestion[]>([])
  const [nav, setNav] = useState<NavKey>('all')
  const [category, setCategory] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'disabled'>('all')
  const [q, setQ] = useState('')
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [acting, setActing] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [missedId, setMissedId] = useState<number | null>(null)
  const [chunks, setChunks] = useState<KnowledgeChunk[]>([])
  const [chunksOpen, setChunksOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testOpen, setTestOpen] = useState(false)
  const [testQuery, setTestQuery] = useState('')
  const [testResult, setTestResult] = useState<RecallTestResult | null>(null)
  const [testing, setTesting] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLInputElement>(null)
  const faqPackRef = useRef<HTMLInputElement>(null)
  const [importing, setImporting] = useState(false)
  const [packImporting, setPackImporting] = useState(false)
  const [limit, setLimit] = useState(200)

  const refresh = async () => {
    const [list, pending] = await Promise.all([api.listDocs(), api.listMissed()])
    setDocs(list)
    setMissed(pending)
    return list
  }

  useEffect(() => {
    refresh()
  }, [])

  const visible = useMemo(
    () => docs.filter((d) => d.status !== 'archived'),
    [docs],
  )
  const categories = useMemo(() => {
    const names = new Set(visible.map((d) => d.category || '未分类'))
    return Array.from(names).sort()
  }, [visible])

  const filtered = useMemo(() => {
    const keyword = q.trim().toLowerCase()
    const isId = /^\d+$/.test(keyword)
    const rows = visible.filter((d) => {
      if (nav === 'faq' && d.doc_type !== 'faq') return false
      if (nav === 'file' && d.doc_type !== 'file') return false
      if (statusFilter !== 'all' && d.status !== statusFilter) return false
      if (category && (d.category || '未分类') !== category) return false
      if (!keyword) return true
      if (isId) return String(d.id).includes(keyword)
      const similars = (d.similar_questions || []).join(' ')
      const hay = `${d.title} ${d.question || ''} ${d.answer || ''} ${d.category || ''} ${similars}`.toLowerCase()
      return hay.includes(keyword)
    })
    return rows.sort((a, b) => b.id - a.id)
  }, [visible, nav, category, q, statusFilter])

  useEffect(() => {
    setLimit(200)
  }, [nav, category, q, statusFilter])

  const shown = useMemo(() => filtered.slice(0, limit), [filtered, limit])

  const activeDoc = visible.find((d) => d.id === selectedId) || null
  const counts = {
    all: visible.length,
    faq: visible.filter((d) => d.doc_type === 'faq').length,
    file: visible.filter((d) => d.doc_type === 'file').length,
    missed: missed.length,
  }

  const openDoc = async (doc: KnowledgeDoc) => {
    setCreating(false)
    setMissedId(null)
    setSelectedId(doc.id)
    setDraft({
      title: doc.title,
      category: doc.category || '未分类',
      question: doc.question || '',
      answer: doc.answer || '',
      similars: [...(doc.similar_questions || [])],
    })
    setChunksOpen(doc.doc_type === 'file')
    setChunks(await api.listChunks(doc.id).catch(() => []))
  }

  const startCreate = (prefill?: Partial<Draft>, fromMissed?: number) => {
    setNav(fromMissed ? 'missed' : 'faq')
    setSelectedId(null)
    setCreating(true)
    setMissedId(fromMissed ?? null)
    setChunks([])
    setDraft({ ...EMPTY_DRAFT, ...prefill })
  }

  useEffect(() => {
    const incoming = (location.state as { faqDraft?: Partial<Draft> } | null)?.faqDraft
    if (!incoming || (!incoming.question && !incoming.answer)) return
    startCreate({
      title: (incoming.title || incoming.question || '').slice(0, 30),
      question: incoming.question || '',
      answer: incoming.answer || '',
    })
    navigate('/knowledge', { replace: true, state: null })
  }, [location.state])

  const closeEditor = () => {
    setSelectedId(null)
    setCreating(false)
    setMissedId(null)
  }

  const saveFaq = async (e: FormEvent) => {
    e.preventDefault()
    if (!draft.title.trim() || !draft.question.trim() || !draft.answer.trim()) return
    setSaving(true)
    let savedId = activeDoc?.id ?? null
    try {
      const similars = Array.from(new Set(draft.similars.map((s) => s.trim()).filter(Boolean)))
      if (missedId) {
        const res = await api.resolveMissed(missedId, draft.title.trim(), draft.question.trim(), draft.answer.trim(), draft.category, similars)
        savedId = res.doc_id
        toast.success('已转为 FAQ 并索引')
        setMissedId(null)
        setNav('faq')
      } else if (activeDoc && activeDoc.doc_type === 'faq') {
        const updated = await api.updateFaq(activeDoc.id, draft.title.trim(), draft.question.trim(), draft.answer.trim(), draft.category, similars)
        savedId = updated.id
        toast.success(updated.status === 'active' ? 'FAQ 已更新并重新索引' : 'FAQ 已保存，启用后才会进入检索')
      } else {
        const created = await api.createFaq(draft.title.trim(), draft.question.trim(), draft.answer.trim(), draft.category, similars)
        savedId = created.id
        toast.success('FAQ 已保存并索引')
        setNav('faq')
      }
      const list = await refresh()
      const doc = savedId ? list.find((d) => d.id === savedId) : undefined
      if (doc) await openDoc(doc)
    } catch (err: any) {
      toast.error(err?.message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const saveFile = async () => {
    if (!activeDoc || activeDoc.doc_type !== 'file') return
    setSaving(true)
    try {
      const updated = await api.updateDocMeta(activeDoc.id, {
        title: draft.title.trim(),
        category: draft.category.trim() || '未分类',
      })
      toast.success('文档信息已保存')
      await refresh()
      setSelectedId(updated.id)
    } catch (err: any) {
      toast.error(err?.message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const toggleStatus = async (doc: KnowledgeDoc) => {
    const next = doc.status === 'active' ? 'disabled' : 'active'
    try {
      await api.setDocStatus(doc.id, next)
      toast.success(next === 'active' ? '已启用并重新索引' : '已停用，已从检索移除')
      const list = await refresh()
      const current = list.find((d) => d.id === doc.id)
      if (current) {
        setChunks(await api.listChunks(doc.id).catch(() => []))
      }
    } catch (err: any) {
      toast.error(err?.message || '状态更新失败')
    }
  }

  const chosenIds = () => filtered.filter((doc) => selected.has(doc.id)).map((doc) => doc.id)

  const toggleSelected = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleSelectFiltered = () => {
    setSelected((prev) => {
      const next = new Set(prev)
      const allOn = filtered.length > 0 && filtered.every((doc) => next.has(doc.id))
      filtered.forEach((doc) => {
        if (allOn) next.delete(doc.id)
        else next.add(doc.id)
      })
      return next
    })
  }

  const removeDocs = async (ids: number[], title?: string) => {
    if (!ids.length) return
    const ok = await confirmDialog({
      title: ids.length === 1 ? `删除「${title || '这条知识'}」？` : `删除选中的 ${ids.length} 条？`,
      message: '只从当前环境的列表消失，AI 也不再引用。要生产一起关掉，把该行状态写成停用后导入。',
      confirmText: '删除',
      danger: true,
    })
    if (!ok) return
    setActing(true)
    try {
      const result = await api.batchDocs(ids, 'delete')
      if (result.failed_ids.length) toast.error(`已删除 ${result.updated} 条，${result.failed_ids.length} 条失败`)
      else toast.success(`已删除 ${result.updated} 条`)
      if (selectedId != null && ids.includes(selectedId)) setSelectedId(null)
      setSelected((prev) => {
        const next = new Set(prev)
        ids.forEach((id) => next.delete(id))
        return next
      })
      await refresh()
    } catch (err: any) {
      toast.error(err?.message || '删除失败')
    } finally {
      setActing(false)
    }
  }

  const runBatch = async (action: 'active' | 'disabled') => {
    const ids = chosenIds()
    if (!ids.length) return
    setActing(true)
    try {
      const result = await api.batchDocs(ids, action)
      const label = action === 'active' ? '启用' : '停用'
      if (result.failed_ids.length) toast.error(`已${label} ${result.updated} 条，${result.failed_ids.length} 条失败`)
      else toast.success(`已${label} ${result.updated} 条`)
      setSelected(new Set())
      const list = await refresh()
      if (selectedId != null) {
        const current = list.find((doc) => doc.id === selectedId)
        if (current) setChunks(await api.listChunks(current.id).catch(() => []))
      }
    } catch (err: any) {
      toast.error(err?.message || '状态更新失败')
    } finally {
      setActing(false)
    }
  }

  const onExportFaq = async () => {
    setExporting(true)
    try {
      await downloadFaqPack()
    } catch (err: any) {
      toast.error(err?.message || '导出失败')
    } finally {
      setExporting(false)
    }
  }

  const onImportFaqPack = async (file: File) => {
    setPackImporting(true)
    try {
      const preview = await api.importFaqPack(file, false)
      const duplicates = preview.duplicates_overridden ?? []
      const unchanged = preview.created === 0
        && preview.content_updated === 0
        && preview.enabling === 0
        && preview.disabling_active === 0
        && preview.skipped_ambiguous.length === 0
        && duplicates.length === 0
      if (unchanged) {
        toast.info('这张表和当前知识库一致')
        return
      }
      const skip = preview.skipped_ambiguous.length
        ? `同标题有多条、未改动：${preview.skipped_ambiguous.slice(0, 5).join('、')}。`
        : ''
      const dup = duplicates.length
        ? `文件内重复标题已按最后一行处理：${duplicates.slice(0, 5).join('、')}。`
        : ''
      const ok = await confirmDialog({
        title: '按这张表更新知识库？',
        message: `新建 ${preview.created} 条，覆盖 ${preview.content_updated} 条，将启用 ${preview.enabling} 条，将停用 ${preview.disabling_active} 条当前已启用的。文件里没有的条目保持不变。${skip}${dup}`,
        confirmText: '导入',
        danger: preview.disabling_active > 0,
      })
      if (!ok) return
      const result = await api.importFaqPack(file, true)
      const resultDup = (result.duplicates_overridden ?? []).length
        ? `，重复标题按最后一行覆盖 ${(result.duplicates_overridden ?? []).slice(0, 5).join('、')}`
        : ''
      toast.success(`已导入：新建 ${result.created}，覆盖 ${result.content_updated}，启用 ${result.enabling}${resultDup}`)
      await refresh()
      setNav('faq')
      setCreating(false)
      setSelectedId(null)
    } catch (err: any) {
      toast.error(err?.message || '导入失败')
    } finally {
      setPackImporting(false)
    }
  }

  const onImportDialogs = async (file: File) => {
    setImporting(true)
    try {
      const result = await api.importDialogs(file)
      toast.success(`已导入 ${result.imported} 条，均为停用；另有 ${result.gap_count} 条待补未入库`)
      await refresh()
      setNav('faq')
      setCreating(false)
      setSelectedId(null)
    } catch (err: any) {
      toast.error(err?.message || '导入失败')
    } finally {
      setImporting(false)
    }
  }

  const onUpload = async (file: File) => {
    try {
      const doc = await api.uploadDoc(file)
      toast.success(`「${file.name}」已上传并索引`)
      await refresh()
      setNav('file')
      setSelectedId(doc.id)
      setCreating(false)
      setDraft({
        title: doc.title,
        category: doc.category || '未分类',
        question: '',
        answer: '',
        similars: [],
      })
      setChunksOpen(true)
      setChunks(await api.listChunks(doc.id).catch(() => []))
    } catch (err: any) {
      toast.error(err?.message || '上传失败')
    }
  }

  const runTest = async () => {
    if (!testQuery.trim()) return
    setTesting(true)
    try {
      setTestResult(await api.recallTest(testQuery.trim()))
    } finally {
      setTesting(false)
    }
  }

  const showEditor = creating || !!activeDoc

  return (
    <div className="h-full flex flex-col bg-gray-50 dark:bg-gray-950">
      <div className="bg-white dark:bg-gray-900 border-b dark:border-gray-800 px-4 py-3 flex items-center gap-2 flex-wrap">
        <h1 className="text-base font-semibold text-gray-800 dark:text-gray-100">知识库</h1>
        <div className="flex-1" />
        <button
          onClick={() => startCreate()}
          className="text-sm px-3 py-1.5 rounded-lg bg-primary-600 text-white hover:bg-primary-700 inline-flex items-center gap-1"
        >
          <Plus size={14} /> 新建 FAQ
        </button>
        <button
          onClick={onExportFaq}
          disabled={exporting}
          className="text-sm px-3 py-1.5 rounded-lg border dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 inline-flex items-center gap-1 disabled:opacity-50"
        >
          <Download size={14} /> {exporting ? '导出中…' : '导出 FAQ'}
        </button>
        <button
          onClick={() => faqPackRef.current?.click()}
          disabled={packImporting}
          className="text-sm px-3 py-1.5 rounded-lg border dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 inline-flex items-center gap-1 disabled:opacity-50"
        >
          <Upload size={14} /> {packImporting ? '导入中…' : '导入 FAQ'}
        </button>
        <input
          ref={faqPackRef}
          type="file"
          accept=".xlsx"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) onImportFaqPack(file)
            e.target.value = ''
          }}
        />
        <button
          onClick={() => dialogRef.current?.click()}
          disabled={importing}
          className="text-sm px-3 py-1.5 rounded-lg border dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 inline-flex items-center gap-1 disabled:opacity-50"
        >
          <Upload size={14} /> {importing ? '导入中…' : '导入历史对话'}
        </button>
        <input
          ref={dialogRef}
          type="file"
          accept=".xlsx"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) onImportDialogs(file)
            e.target.value = ''
          }}
        />
        <button
          onClick={() => fileRef.current?.click()}
          className="text-sm px-3 py-1.5 rounded-lg border dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 inline-flex items-center gap-1"
        >
          <Upload size={14} /> 上传文档
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".pdf,.docx,.doc,.md,.txt"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) onUpload(file)
            e.target.value = ''
          }}
        />
        <button
          onClick={() => setTestOpen(true)}
          className="text-sm px-3 py-1.5 rounded-lg border dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 inline-flex items-center gap-1"
        >
          <FlaskConical size={14} /> 召回测试
        </button>
      </div>

      <div className="flex-1 flex min-h-0">
        <aside className="w-[200px] shrink-0 border-r dark:border-gray-800 bg-white dark:bg-gray-900 py-2 overflow-y-auto">
          {NAV.map((item) => (
            <button
              key={item.key}
              onClick={() => {
                setNav(item.key)
                if (item.key === 'file') setCategory('')
                if (item.key === 'missed') {
                  setSelectedId(null)
                  setCreating(false)
                }
              }}
              className={clsx(
                'w-full text-left px-4 py-2 text-sm flex items-center',
                nav === item.key ? 'text-primary-700 bg-primary-50 dark:bg-primary-600/15 dark:text-primary-200' : 'text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800',
              )}
            >
              <span className="flex-1">{item.label}</span>
              <span className="text-[11px] text-gray-400">{counts[item.key]}</span>
            </button>
          ))}
          {nav !== 'missed' && nav !== 'file' && (
            <div className="mt-3 px-4">
              <div className="text-[11px] text-gray-400 mb-1">分类</div>
              <button
                onClick={() => setCategory('')}
                className={clsx('w-full text-left text-xs py-1', !category ? 'text-primary-600' : 'text-gray-500')}
              >
                全部分类
              </button>
              {categories.map((name) => (
                <button
                  key={name}
                  onClick={() => setCategory(name)}
                  className={clsx('w-full text-left text-xs py-1 truncate', category === name ? 'text-primary-600' : 'text-gray-500')}
                >
                  {name}
                </button>
              ))}
            </div>
          )}
        </aside>

        <section className="flex-1 min-w-0 flex flex-col bg-gray-50 dark:bg-gray-950">
          {nav === 'missed' ? (
            <div className="flex-1 overflow-y-auto p-4 space-y-2">
              <div className="text-xs text-gray-400">答不上来的问题会记在这里，补上答案后变成 FAQ。</div>
              {missed.map((m) => (
                <div key={m.id} className="bg-white dark:bg-gray-900 border dark:border-gray-800 rounded-lg px-3 py-2.5 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-gray-800 dark:text-gray-100 truncate">{m.question}</div>
                    <div className="text-[11px] text-orange-500 mt-0.5">被问 {m.count} 次{m.suggested_answer ? " · 有待确认答案" : ""}</div>
                  </div>
                  {m.conversation_id != null && (
                    <button
                      onClick={() => navigate('/', { state: { conversationId: m.conversation_id } })}
                      className="text-xs text-gray-500 shrink-0"
                    >
                      打开会话
                    </button>
                  )}
                  <button
                    onClick={() => startCreate({ title: m.question.slice(0, 30), question: m.question, answer: m.suggested_answer || "" }, m.id)}
                    className="text-xs text-primary-600 shrink-0"
                  >
                    补答案
                  </button>
                </div>
              ))}
              {missed.length === 0 && <Empty title="暂无未命中问题" hint="AI 暂时都能从知识库里找到依据" />}
            </div>
          ) : (
            <>
              <div className="px-3 py-2 space-y-2">
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="搜索标题、问法、答案"
                  className="w-full bg-white dark:bg-gray-900 border dark:border-gray-800 rounded-lg px-3 py-1.5 text-sm outline-none focus:border-primary-500"
                />
                <div className="flex items-center gap-1 text-xs">
                  {([
                    ['all', '全部'],
                    ['active', '启用'],
                    ['disabled', '停用'],
                  ] as const).map(([key, label]) => (
                    <button
                      key={key}
                      onClick={() => setStatusFilter(key)}
                      className={clsx(
                        'px-2 py-1 rounded',
                        statusFilter === key ? 'bg-primary-50 text-primary-700 dark:bg-primary-600/15 dark:text-primary-200' : 'text-gray-500 hover:bg-white dark:hover:bg-gray-900',
                      )}
                    >
                      {label}
                    </button>
                  ))}
                  <button
                    onClick={toggleSelectFiltered}
                    disabled={!filtered.length || acting}
                    className="ml-auto text-gray-500 disabled:opacity-40"
                  >
                    {filtered.length > 0 && filtered.every((doc) => selected.has(doc.id)) ? '取消全选' : '全选当前筛选'}
                  </button>
                </div>
                {filtered.some((doc) => selected.has(doc.id)) && (
                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-gray-500">已选 {filtered.filter((doc) => selected.has(doc.id)).length}</span>
                    <button disabled={acting} onClick={() => runBatch('active')} className="px-2 py-1 rounded bg-primary-600 text-white disabled:opacity-50">启用</button>
                    <button disabled={acting} onClick={() => runBatch('disabled')} className="px-2 py-1 rounded border dark:border-gray-700 text-gray-600 dark:text-gray-300 disabled:opacity-50">停用</button>
                    <button
                      disabled={acting}
                      onClick={() => {
                        const rows = filtered.filter((doc) => selected.has(doc.id))
                        removeDocs(rows.map((doc) => doc.id), rows.length === 1 ? rows[0].title : undefined)
                      }}
                      className="px-2 py-1 rounded text-red-500 disabled:opacity-50"
                    >
                      删除
                    </button>
                  </div>
                )}
              </div>
              <div className="flex-1 overflow-y-auto">
                {shown.map((doc) => (
                  <div
                    key={doc.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => openDoc(doc)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') openDoc(doc)
                    }}
                className={clsx(
                  'group w-full text-left px-4 py-2.5 border-b dark:border-gray-800/80 cursor-pointer',
                      selectedId === doc.id && !creating ? 'bg-primary-50 dark:bg-primary-600/15' : 'hover:bg-white dark:hover:bg-gray-900',
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={selected.has(doc.id)}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => toggleSelected(doc.id)}
                        className="shrink-0"
                        aria-label={`选择 ${doc.title}`}
                      />
                      <span className="text-sm text-gray-800 dark:text-gray-100 truncate flex-1">{doc.title}</span>
                      <span className={clsx('text-[10px] px-1.5 py-px rounded', doc.doc_type === 'faq' ? 'bg-primary-50 text-primary-700' : 'bg-gray-100 text-gray-500 dark:bg-gray-800')}>
                        {doc.doc_type === 'faq' ? 'FAQ' : '文档'}
                      </span>
                    </div>
                    {doc.doc_type === 'faq' && doc.question && (
                      <div className="text-[11px] text-gray-500 dark:text-gray-400 truncate mt-0.5 pl-6">{doc.question}</div>
                    )}
                    <div className="text-[11px] text-gray-400 mt-0.5 flex items-center gap-2 pl-6">
                      <span>#{doc.id}</span>
                      <span>{doc.category || '未分类'}</span>
                      <span>{doc.chunk_count} 切片</span>
                      <span>引用 {doc.hit_count || 0} 次</span>
                      <span className={doc.status === 'active' ? 'text-primary-600' : 'text-gray-400'}>{statusLabel(doc.status)}</span>
                      <button
                        type="button"
                        disabled={acting}
                        onClick={(e) => {
                          e.stopPropagation()
                          toggleStatus(doc)
                        }}
                        className={clsx(
                          'ml-auto rounded px-1.5 py-px opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity disabled:opacity-40',
                          doc.status === 'active'
                            ? 'text-gray-500 bg-gray-100 dark:bg-gray-800 dark:text-gray-300'
                            : 'bg-primary-600 text-white',
                        )}
                      >
                        {doc.status === 'active' ? '停用' : '启用'}
                      </button>
                    </div>
                  </div>
                ))}
                {filtered.length > shown.length && (
                  <div className="px-4 py-3 flex items-center gap-3 text-xs text-gray-400">
                    <span>已显示 {shown.length} / {filtered.length} 条</span>
                    <button onClick={() => setLimit((n) => n + 200)} className="text-primary-600">
                      显示更多
                    </button>
                  </div>
                )}
                {filtered.length === 0 && (
                  <Empty icon={FileText} title="没有匹配的知识" hint="新建 FAQ，或上传 PDF / Word / Markdown" />
                )}
              </div>
            </>
          )}
        </section>

        <aside className="w-[360px] shrink-0 border-l dark:border-gray-800 bg-white dark:bg-gray-900 flex flex-col">
          {!showEditor && (
            <div className="h-full flex items-center justify-center text-sm text-gray-400 px-6 text-center">
              选择一条知识，或新建 FAQ
            </div>
          )}
          {showEditor && (creating || activeDoc?.doc_type === 'faq') && (
            <form onSubmit={saveFaq} className="flex-1 min-h-0 flex flex-col">
              <div className="p-4 pb-3 flex items-center gap-2">
                <div className="text-sm font-medium text-gray-800 dark:text-gray-100">
                  {missedId ? '未命中转 FAQ' : creating ? '新建 FAQ' : '编辑 FAQ'}
                </div>
                <button type="button" onClick={closeEditor} className="ml-auto text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">
                  <X size={16} />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-3">
                <Field label="标题">
                  <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} className={inputCls} placeholder="产品价格" />
                </Field>
                <Field label="分类">
                  <input value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })} className={inputCls} list="kb-categories" placeholder="未分类" />
                </Field>
                <Field label="标准问">
                  <input value={draft.question} onChange={(e) => setDraft({ ...draft, question: e.target.value })} className={inputCls} placeholder="这个多少钱" />
                </Field>
                <Field label="相似问">
                  <textarea
                    value={draft.similars.join('\n')}
                    onChange={(e) => setDraft({ ...draft, similars: e.target.value.split('\n') })}
                    onPaste={(e) => {
                      const text = e.clipboardData.getData('text')
                      if (!text) return
                      const parts = text.split(/[\n,，、/／]+/).map((s) => s.trim()).filter(Boolean)
                      const merged = Array.from(new Set([...draft.similars.filter((s) => s.trim()), ...parts]))
                      e.preventDefault()
                      setDraft({ ...draft, similars: merged })
                    }}
                    rows={5}
                    className={inputCls}
                    placeholder={'每行一条相似问\n可整段粘贴，自动按 换行/逗号/顿号/斜杠 拆分'}
                  />
                </Field>
                <Field label="答案">
                  <textarea value={draft.answer} onChange={(e) => setDraft({ ...draft, answer: e.target.value })} rows={6} className={inputCls} placeholder="标准款 99 元" />
                </Field>
                {activeDoc && !creating && (
                  <EnableRow doc={activeDoc} onToggle={() => toggleStatus(activeDoc)} />
                )}
                <ChunkList chunks={chunks} open={chunksOpen} onToggle={() => setChunksOpen(!chunksOpen)} />
              </div>
              <div className="p-4 pt-3 border-t dark:border-gray-800 space-y-2">
                <button disabled={saving} className="w-full bg-primary-600 hover:bg-primary-700 text-white text-sm rounded-lg py-2 disabled:opacity-50">
                  {saving ? '保存中…' : '保存并索引'}
                </button>
                {activeDoc && !creating && (
                  <button
                    type="button"
                    disabled={acting}
                    onClick={() => removeDocs([activeDoc.id], activeDoc.title)}
                    className="w-full text-xs text-red-500 disabled:opacity-50"
                  >
                    删除
                  </button>
                )}
              </div>
            </form>
          )}
          {showEditor && activeDoc && activeDoc.doc_type === 'file' && !creating && (
            <div className="flex-1 min-h-0 flex flex-col">
              <div className="p-4 pb-3 flex items-center gap-2">
                <div className="text-sm font-medium text-gray-800 dark:text-gray-100">文档</div>
                <button type="button" onClick={closeEditor} className="ml-auto text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">
                  <X size={16} />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-3">
                <Field label="标题">
                  <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} className={inputCls} />
                </Field>
                <Field label="分类">
                  <input value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })} className={inputCls} list="kb-categories" />
                </Field>
                <EnableRow doc={activeDoc} onToggle={() => toggleStatus(activeDoc)} />
                <ChunkList chunks={chunks} open={chunksOpen} onToggle={() => setChunksOpen(!chunksOpen)} />
              </div>
              <div className="p-4 pt-3 border-t dark:border-gray-800 space-y-2">
                <button onClick={saveFile} disabled={saving} className="w-full bg-primary-600 hover:bg-primary-700 text-white text-sm rounded-lg py-2 disabled:opacity-50">
                  {saving ? '保存中…' : '保存'}
                </button>
                <button
                  disabled={acting}
                  onClick={() => removeDocs([activeDoc.id], activeDoc.title)}
                  className="w-full text-xs text-red-500 disabled:opacity-50"
                >
                  删除
                </button>
              </div>
            </div>
          )}
          <datalist id="kb-categories">
            {categories.map((name) => <option key={name} value={name} />)}
          </datalist>
        </aside>
      </div>

      {testOpen && (
        <div className="fixed inset-0 z-40 flex justify-end bg-black/20" onClick={() => setTestOpen(false)}>
          <div className="w-[420px] h-full bg-white dark:bg-gray-900 shadow-pop p-4 overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center mb-3">
              <div className="font-medium text-sm text-gray-800 dark:text-gray-100">召回测试</div>
              <button onClick={() => setTestOpen(false)} className="ml-auto text-gray-400"><X size={16} /></button>
            </div>
            <div className="flex gap-2">
              <input
                value={testQuery}
                onChange={(e) => setTestQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && runTest()}
                placeholder="输入测试问题"
                className={inputCls}
              />
              <button onClick={runTest} disabled={testing} className="bg-primary-600 text-white text-sm rounded-lg px-3 disabled:opacity-50">
                {testing ? '检索中' : '测试'}
              </button>
            </div>
            {testResult && (
              <div className="mt-4 space-y-3 text-sm">
                {testResult.degraded && (
                  <div className="text-xs bg-yellow-50 text-yellow-700 rounded-lg px-3 py-2">当前为纯 BM25，未配置 Embedding</div>
                )}
                <div>
                  <span className="text-gray-400 text-xs">改写后查询</span>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {testResult.rewritten_queries.map((item, i) => (
                      <span key={i} className="text-xs bg-gray-100 dark:bg-gray-800 rounded px-2 py-0.5">{item}</span>
                    ))}
                  </div>
                </div>
                <div className="text-xs text-gray-500">
                  最高分 {testResult.rerank_top_score?.toFixed(3) ?? '未启用 rerank'} · 阈值 {testResult.threshold}
                  <span className={clsx('ml-2', testResult.passed ? 'text-primary-600' : 'text-red-500')}>
                    {testResult.passed ? '通过' : '未过阈值'}
                  </span>
                </div>
                {testResult.hits.map((hit, i) => (
                  <div key={i} className="border dark:border-gray-700 rounded-lg p-3">
                    <div className="text-[11px] text-gray-400 mb-1">{hit.source}{hit.score != null ? ` · ${hit.score.toFixed(3)}` : ''}</div>
                    <div className="text-gray-700 dark:text-gray-200 whitespace-pre-wrap text-xs">{hit.content}</div>
                  </div>
                ))}
                {testResult.hits.length === 0 && <div className="text-xs text-gray-400">无召回结果</div>}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

const inputCls = 'w-full border dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 rounded-lg px-3 py-2 text-sm outline-none focus:border-primary-500'

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <div className="text-[12px] text-gray-400 mb-1">{label}</div>
      {children}
    </label>
  )
}

function EnableRow({ doc, onToggle }: { doc: KnowledgeDoc; onToggle: () => void }) {
  const on = doc.status === 'active'
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-gray-500">{on ? '检索中' : '已停用，不参与回答'}</span>
      <button type="button" onClick={onToggle} className={clsx('text-xs px-2 py-1 rounded', on ? 'bg-gray-100 text-gray-600' : 'bg-primary-600 text-white')}>
        {on ? '停用' : '启用'}
      </button>
    </div>
  )
}

function ChunkList({ chunks, open, onToggle }: { chunks: KnowledgeChunk[]; open: boolean; onToggle: () => void }) {
  return (
    <div>
      <button type="button" onClick={onToggle} className="text-xs text-gray-400">
        切片 {chunks.length} {open ? '收起' : '展开'}
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          {chunks.length === 0 && <div className="text-xs text-gray-400">停用或尚未索引时没有切片</div>}
          {chunks.map((chunk) => (
            <div key={chunk.id} className="text-xs bg-gray-50 dark:bg-gray-800 rounded-lg p-2 whitespace-pre-wrap text-gray-600 dark:text-gray-300">
              {chunk.content}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
