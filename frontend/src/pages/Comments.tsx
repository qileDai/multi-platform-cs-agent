import clsx from 'clsx'
import dayjs from 'dayjs'
import { MessageCircle, Plus, Settings2, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { api, AutoSwitches, CommentRule, PostComment } from '../api/client'
import Empty from '../components/ui/Empty'
import Skeleton from '../components/ui/Skeleton'
import { confirmDialog, promptDialog } from '../components/ui/dialogs'
import { toast } from '../components/ui/toast'
import { subscribeWs, useAuth } from '../store'

const INTENT_STYLE: Record<string, { label: string; cls: string }> = {
  consult: { label: '咨询', cls: 'bg-blue-100 text-blue-600 dark:bg-blue-900/40 dark:text-blue-400' },
  price: { label: '问价', cls: 'bg-purple-100 text-purple-600 dark:bg-purple-900/40 dark:text-purple-400' },
  praise: { label: '好评', cls: 'bg-green-100 text-green-600 dark:bg-green-900/40 dark:text-green-400' },
  complaint: { label: '差评', cls: 'bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-400' },
  spam: { label: '广告', cls: 'bg-orange-100 text-orange-600 dark:bg-orange-900/40 dark:text-orange-400' },
  irrelevant: { label: '无关', cls: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400' },
}

const STATUS_STYLE: Record<string, { label: string; cls: string }> = {
  pending: { label: '待处理', cls: 'bg-yellow-100 text-yellow-600 dark:bg-yellow-900/40 dark:text-yellow-400' },
  replied: { label: '已自动回复', cls: 'bg-green-100 text-green-600 dark:bg-green-900/40 dark:text-green-400' },
  manual: { label: '已人工回复', cls: 'bg-blue-100 text-blue-600 dark:bg-blue-900/40 dark:text-blue-400' },
  skipped: { label: '已跳过', cls: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400' },
}

const PLATFORM_LABEL: Record<string, string> = { douyin: '抖音', xiaohongshu: '小红书' }

export default function Comments() {
  const { agent } = useAuth()
  const isAdmin = agent?.role === 'admin'
  const [tab, setTab] = useState<'list' | 'rules'>('list')
  const [statusFilter, setStatusFilter] = useState('pending')
  const [comments, setComments] = useState<PostComment[]>([])
  const [rules, setRules] = useState<CommentRule[]>([])
  const [switches, setSwitches] = useState<AutoSwitches | null>(null)
  const [loading, setLoading] = useState(true)
  const [replyingId, setReplyingId] = useState(0)
  const [replyText, setReplyText] = useState('')

  const load = useCallback(async () => {
    try {
      const [cs, rs, sw] = await Promise.all([
        api.listComments(statusFilter ? { status: statusFilter } : {}),
        api.listCommentRules(),
        api.getAutoSwitches().catch(() => null),
      ])
      setComments(cs)
      setRules(rs)
      setSwitches(sw)
    } catch (e: any) {
      toast.error(e.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }, [statusFilter])

  useEffect(() => {
    load()
  }, [load])

  useEffect(
    () =>
      subscribeWs((event) => {
        if (event === 'comment_new') load()
      }),
    [load],
  )

  const reply = async (id: number) => {
    if (!replyText.trim()) return
    try {
      await api.replyComment(id, replyText.trim())
      toast.success('已回复')
      setReplyingId(0)
      setReplyText('')
      load()
    } catch (e: any) {
      toast.error(e.message || '回复失败')
    }
  }

  const skip = async (id: number) => {
    try {
      await api.skipComment(id)
      load()
    } catch (e: any) {
      toast.error(e.message || '操作失败')
    }
  }

  const toggleAuto = async () => {
    if (!switches) return
    const next = !switches.comment_auto_reply_enabled
    try {
      const updated = await api.setAutoSwitches({ comment_auto_reply_enabled: next })
      setSwitches(updated)
      toast.success(next ? '评论自动回复已开启' : '评论自动回复已关闭（全部转人工）')
    } catch (e: any) {
      toast.error(e.message || '切换失败')
    }
  }

  const addRule = async () => {
    const intent = await promptDialog({
      title: '命中意图（留空=仅按关键词）',
      placeholder: 'consult | price | praise',
    })
    if (intent === null) return
    const keywords = await promptDialog({ title: '关键词（逗号分隔，可留空）', placeholder: '如：多少钱,怎么买' })
    if (keywords === null) return
    const templates = await promptDialog({
      title: '回复模板（| 分隔多条，{code} 为暗号占位）',
      placeholder: '如：已私您啦|私信我哈',
    })
    if (!templates?.trim()) {
      toast.error('至少一条回复模板')
      return
    }
    const code = await promptDialog({ title: '暗号（用户私信该词完成归因，可留空）', placeholder: '如：价格' })
    try {
      await api.createCommentRule({
        intent: (intent || '').trim(),
        keywords: (keywords || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean),
        reply_templates: templates.split('|').map((s) => s.trim()).filter(Boolean),
        guide_code: (code || '').trim(),
        enabled: true,
        priority: 10,
      })
      toast.success('规则已创建')
      load()
    } catch (e: any) {
      toast.error(e.message || '创建失败')
    }
  }

  const toggleRule = async (rule: CommentRule) => {
    try {
      await api.updateCommentRule(rule.id, { ...rule, enabled: !rule.enabled })
      load()
    } catch (e: any) {
      toast.error(e.message || '操作失败')
    }
  }

  const removeRule = async (rule: CommentRule) => {
    if (!(await confirmDialog({ title: '删除该规则？', danger: true }))) return
    try {
      await api.deleteCommentRule(rule.id)
      load()
    } catch (e: any) {
      toast.error(e.message || '删除失败')
    }
  }

  return (
    <div className="h-full flex flex-col bg-gray-50 dark:bg-gray-950">
      <div className="bg-white dark:bg-gray-900 border-b dark:border-gray-700 px-6 py-4 flex items-center">
        <div>
          <h1 className="text-lg font-medium text-gray-800 dark:text-gray-100">评论管理</h1>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
            评论采集 → 意图识别 → 自动回复（暗号引导私信）；差评/广告自动转人工
          </p>
        </div>
        <span className="flex-1" />
        {isAdmin && switches && (
          <button
            onClick={toggleAuto}
            className={clsx(
              'text-xs rounded-lg px-4 py-2 font-medium',
              switches.comment_auto_reply_enabled
                ? 'bg-green-600 text-white hover:bg-green-700'
                : 'bg-gray-200 text-gray-600 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-300',
            )}
          >
            自动回复：{switches.comment_auto_reply_enabled ? '已开启' : '已关闭'}
          </button>
        )}
      </div>

      {/* Tab + 筛选 */}
      <div className="bg-white dark:bg-gray-900 border-b dark:border-gray-700 px-6 flex items-center gap-1">
        <button
          onClick={() => setTab('list')}
          className={clsx(
            'px-4 py-2.5 text-sm border-b-2 -mb-px',
            tab === 'list' ? 'border-blue-600 text-blue-600 dark:text-blue-400 font-medium' : 'border-transparent text-gray-500',
          )}
        >
          评论列表
        </button>
        <button
          onClick={() => setTab('rules')}
          className={clsx(
            'px-4 py-2.5 text-sm border-b-2 -mb-px flex items-center gap-1',
            tab === 'rules' ? 'border-blue-600 text-blue-600 dark:text-blue-400 font-medium' : 'border-transparent text-gray-500',
          )}
        >
          <Settings2 size={13} /> 回复规则
        </button>
        <span className="flex-1" />
        {tab === 'list' && (
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="text-xs border dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 rounded px-2 py-1.5 my-1.5"
          >
            <option value="">全部状态</option>
            <option value="pending">待处理</option>
            <option value="replied">已自动回复</option>
            <option value="manual">已人工回复</option>
            <option value="skipped">已跳过</option>
          </select>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {tab === 'list' ? (
          loading ? (
            <Skeleton rows={4} className="max-w-4xl" />
          ) : comments.length === 0 ? (
            <Empty icon={MessageCircle} title="暂无评论" hint="发布内容后，评论会自动采集到这里" />
          ) : (
            <div className="space-y-3 max-w-4xl">
              {comments.map((c) => (
                <div key={c.id} className="bg-white dark:bg-gray-900 rounded-card shadow-card p-4">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400 rounded px-2 py-0.5">
                      {PLATFORM_LABEL[c.platform] || c.platform}
                    </span>
                    <span className="text-xs text-gray-500 dark:text-gray-400">{c.author_nickname}</span>
                    {c.intent && (
                      <span className={clsx('text-xs rounded px-2 py-0.5', INTENT_STYLE[c.intent]?.cls)}>
                        {INTENT_STYLE[c.intent]?.label || c.intent}
                      </span>
                    )}
                    <span className={clsx('text-xs rounded px-2 py-0.5', STATUS_STYLE[c.status]?.cls)}>
                      {STATUS_STYLE[c.status]?.label || c.status}
                    </span>
                    <span className="flex-1" />
                    <span className="text-xs text-gray-400">{dayjs(c.created_at).format('MM-DD HH:mm')}</span>
                  </div>
                  <div className="mt-2 text-sm text-gray-800 dark:text-gray-100">{c.content}</div>
                  {c.post_title && (
                    <div className="mt-1 text-xs text-gray-400">作品：{c.post_title}</div>
                  )}
                  {c.reply_content && (
                    <div className="mt-2 text-xs text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 rounded p-2">
                      回复：{c.reply_content}
                    </div>
                  )}
                  {(c.status === 'pending' || c.status === 'skipped') && (
                    <div className="mt-3">
                      {replyingId === c.id ? (
                        <div className="flex gap-2">
                          <input
                            autoFocus
                            value={replyText}
                            onChange={(e) => setReplyText(e.target.value)}
                            placeholder="输入回复（禁止联系方式，违规将被拦截）"
                            className="flex-1 border dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 rounded-lg px-3 py-1.5 text-sm outline-none focus:border-blue-500"
                            onKeyDown={(e) => e.key === 'Enter' && reply(c.id)}
                          />
                          <button
                            onClick={() => reply(c.id)}
                            className="text-xs bg-blue-600 text-white rounded-lg px-3 py-1.5 hover:bg-blue-700"
                          >
                            发送
                          </button>
                          <button
                            onClick={() => { setReplyingId(0); setReplyText('') }}
                            className="text-xs bg-gray-100 text-gray-500 rounded-lg px-3 py-1.5"
                          >
                            取消
                          </button>
                        </div>
                      ) : (
                        <div className="flex gap-2">
                          <button
                            onClick={() => { setReplyingId(c.id); setReplyText('') }}
                            className="text-xs bg-blue-50 text-blue-600 dark:bg-blue-900/40 dark:text-blue-400 rounded px-3 py-1.5 hover:bg-blue-100"
                          >
                            人工回复
                          </button>
                          {c.status === 'pending' && (
                            <button
                              onClick={() => skip(c.id)}
                              className="text-xs bg-gray-100 text-gray-500 dark:bg-gray-800 rounded px-3 py-1.5 hover:bg-gray-200"
                            >
                              跳过
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )
        ) : (
          /* 规则配置 Tab */
          <div className="max-w-4xl">
            {isAdmin && (
              <button
                onClick={addRule}
                className="flex items-center gap-1.5 text-sm bg-blue-600 text-white rounded-lg px-4 py-2 hover:bg-blue-700 mb-4"
              >
                <Plus size={15} /> 新建规则
              </button>
            )}
            <div className="space-y-3">
              {rules.map((rule) => (
                <div key={rule.id} className="bg-white dark:bg-gray-900 rounded-card shadow-card p-4">
                  <div className="flex items-center gap-2 flex-wrap">
                    {rule.intent && (
                      <span className={clsx('text-xs rounded px-2 py-0.5', INTENT_STYLE[rule.intent]?.cls || 'bg-gray-100 text-gray-500')}>
                        意图:{INTENT_STYLE[rule.intent]?.label || rule.intent}
                      </span>
                    )}
                    {(rule.keywords || []).map((k) => (
                      <span key={k} className="text-xs bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400 rounded px-2 py-0.5">
                        {k}
                      </span>
                    ))}
                    {rule.guide_code && (
                      <span className="text-xs bg-purple-100 text-purple-600 dark:bg-purple-900/40 dark:text-purple-400 rounded px-2 py-0.5">
                        暗号:{rule.guide_code}
                      </span>
                    )}
                    <span className="text-xs text-gray-400">优先级 {rule.priority}</span>
                    <span className="flex-1" />
                    {isAdmin && (
                      <>
                        <button
                          onClick={() => toggleRule(rule)}
                          className={clsx(
                            'text-xs rounded px-2.5 py-1',
                            rule.enabled
                              ? 'bg-green-100 text-green-600 dark:bg-green-900/40 dark:text-green-400'
                              : 'bg-gray-100 text-gray-400 dark:bg-gray-800',
                          )}
                        >
                          {rule.enabled ? '已启用' : '已停用'}
                        </button>
                        <button
                          onClick={() => removeRule(rule)}
                          className="text-xs bg-red-50 text-red-500 rounded px-2.5 py-1 hover:bg-red-100"
                        >
                          <Trash2 size={12} />
                        </button>
                      </>
                    )}
                  </div>
                  <div className="mt-2 space-y-1">
                    {(rule.reply_templates || []).map((t, i) => (
                      <div key={i} className="text-xs text-gray-600 dark:text-gray-300">
                        模板{i + 1}：{t}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              {rules.length === 0 && (
                <Empty icon={Settings2} title="暂无规则" hint="规则命中评论后自动回复模板并引导私信暗号" />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
