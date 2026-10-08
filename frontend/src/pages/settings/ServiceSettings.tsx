import clsx from 'clsx'
import { ListChecks, MessageSquare, Users } from 'lucide-react'
import { FormEvent, ReactNode, useEffect, useState } from 'react'
import { api, Agent, BannedWord, QuickReply } from '../../api/client'
import { confirmDialog } from '../../components/ui/dialogs'
import Empty from '../../components/ui/Empty'
import { toast } from '../../components/ui/toast'
import { useAuth } from '../../store'

const fieldClass = 'w-full border dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 rounded-lg px-3 py-2 text-sm mt-1 outline-none focus:border-blue-500'

type Tab = 'agents' | 'quick' | 'banned'
type QuickDraft = { id: number | null; title: string; content: string; personal: boolean }
type BannedDraft = { id: number | null; word: string; category: string; direction: 'out' | 'in' }
type AgentDraft = {
  id: number | null
  username: string
  displayName: string
  password: string
  role: 'agent' | 'admin'
  maxConcurrent: number
}

const TABS: { id: Tab; label: string }[] = [
  { id: 'agents', label: '客服账号' },
  { id: 'quick', label: '快捷回复' },
  { id: 'banned', label: '违禁词' },
]

const STATUS_LABEL: Record<string, string> = {
  active: '接待中',
  resting: '休息中',
  offline: '离线',
}

function FormModal({
  title,
  submitText,
  onClose,
  onSubmit,
  children,
}: {
  title: string
  submitText: string
  onClose: () => void
  onSubmit: () => void
  children: ReactNode
}) {
  return (
    <div className="fixed inset-0 z-[90] bg-black/40 flex items-center justify-center" onClick={onClose}>
      <form
        className="bg-white dark:bg-gray-800 rounded-2xl shadow-pop w-[420px] p-5"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e: FormEvent) => {
          e.preventDefault()
          onSubmit()
        }}
      >
        <div className="text-sm font-medium text-gray-800 dark:text-gray-100 mb-4">{title}</div>
        <div className="space-y-3">{children}</div>
        <div className="flex justify-end gap-2 mt-5">
          <button
            type="button"
            onClick={onClose}
            className="text-xs px-4 py-2 rounded-lg bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300"
          >
            取消
          </button>
          <button type="submit" className="text-xs px-4 py-2 rounded-lg text-white bg-blue-600 hover:bg-blue-700 font-medium">
            {submitText}
          </button>
        </div>
      </form>
    </div>
  )
}

export default function ServiceSettings() {
  const { agent: me, loadMe } = useAuth()
  const isAdmin = me?.role === 'admin'
  const [tab, setTab] = useState<Tab>('agents')
  const [agents, setAgents] = useState<Agent[]>([])
  const [quickReplies, setQuickReplies] = useState<QuickReply[]>([])
  const [banned, setBanned] = useState<BannedWord[]>([])
  const [quickDraft, setQuickDraft] = useState<QuickDraft | null>(null)
  const [bannedDraft, setBannedDraft] = useState<BannedDraft | null>(null)
  const [agentDraft, setAgentDraft] = useState<AgentDraft | null>(null)

  const loadAgents = async () => setAgents(await api.listAgents())
  const loadQuick = async () => setQuickReplies(await api.listQuickReplies())
  const loadBanned = async () => {
    try {
      setBanned(await api.listBannedWords())
    } catch {
      setBanned([])
    }
  }

  useEffect(() => {
    if (tab === 'agents') loadAgents().catch(() => {})
    else if (tab === 'quick') loadQuick().catch(() => {})
    else loadBanned()
  }, [tab])

  const openCreate = () => {
    if (tab === 'agents') {
      setAgentDraft({ id: null, username: '', displayName: '', password: '', role: 'agent', maxConcurrent: 20 })
    } else if (tab === 'quick') {
      setQuickDraft({ id: null, title: '', content: '', personal: false })
    } else {
      setBannedDraft({ id: null, word: '', category: '极限词', direction: 'out' })
    }
  }

  const saveAgent = async () => {
    if (!agentDraft) return
    const displayName = agentDraft.displayName.trim()
    const username = agentDraft.username.trim()
    const password = agentDraft.password.trim()
    if (!displayName) {
      toast.error('请填写姓名')
      return
    }
    if (agentDraft.maxConcurrent < 0 || Number.isNaN(agentDraft.maxConcurrent)) {
      toast.error('接待上限不能为负数')
      return
    }
    try {
      if (agentDraft.id == null) {
        if (!username || !password) {
          toast.error('请填写账号和密码')
          return
        }
        await api.createAgent(username, password, displayName, agentDraft.role, agentDraft.maxConcurrent)
        toast.success('客服账号已创建')
      } else {
        await api.updateAgent(agentDraft.id, {
          display_name: displayName,
          role: agentDraft.role,
          max_concurrent: agentDraft.maxConcurrent,
          ...(password ? { password } : {}),
        })
        toast.success('客服账号已保存')
        if (agentDraft.id === me?.id) await loadMe()
      }
      setAgentDraft(null)
      loadAgents()
    } catch (e: any) {
      toast.error(e.message || '保存失败')
    }
  }

  const removeAgent = async (a: Agent) => {
    const ok = await confirmDialog({
      title: `删除客服「${a.display_name}」？`,
      message: '删除后该账号无法登录，历史接待记录保留。',
      confirmText: '删除',
      danger: true,
    })
    if (!ok) return
    try {
      await api.deleteAgent(a.id)
      toast.success('客服已删除')
      loadAgents()
    } catch (e: any) {
      toast.error(e.message || '删除失败')
    }
  }

  const saveQuick = async () => {
    if (!quickDraft) return
    const title = quickDraft.title.trim()
    const content = quickDraft.content.trim()
    if (!title || !content) {
      toast.error('请填写标题和内容')
      return
    }
    try {
      if (quickDraft.id == null) {
        await api.createQuickReply(title, content, quickDraft.personal)
        toast.success('快捷回复已添加')
      } else {
        await api.updateQuickReply(quickDraft.id, title, content, quickDraft.personal)
        toast.success('快捷回复已保存')
      }
      setQuickDraft(null)
      loadQuick()
    } catch (e: any) {
      toast.error(e.message || '保存失败')
    }
  }

  const removeQuick = async (q: QuickReply) => {
    const ok = await confirmDialog({
      title: `删除快捷回复「${q.title}」？`,
      message: '删除后工作台将不再显示这条模板。',
      confirmText: '删除',
      danger: true,
    })
    if (!ok) return
    try {
      await api.deleteQuickReply(q.id)
      toast.info('已删除')
      loadQuick()
    } catch (e: any) {
      toast.error(e.message || '删除失败')
    }
  }

  const saveBanned = async () => {
    if (!bannedDraft) return
    const word = bannedDraft.word.trim()
    const category = bannedDraft.category.trim() || '极限词'
    if (!word) {
      toast.error('请填写违禁词')
      return
    }
    try {
      if (bannedDraft.id == null) {
        await api.addBannedWord(word, category, bannedDraft.direction)
        toast.success('已加入词库')
      } else {
        await api.updateBannedWord(bannedDraft.id, word, category, bannedDraft.direction)
        toast.success('违禁词已保存')
      }
      setBannedDraft(null)
      loadBanned()
    } catch (e: any) {
      toast.error(e.message || '保存失败')
    }
  }

  const removeBanned = async (w: BannedWord) => {
    const ok = await confirmDialog({
      title: `删除违禁词「${w.word}」？`,
      confirmText: '删除',
      danger: true,
    })
    if (!ok) return
    try {
      await api.deleteBannedWord(w.id)
      toast.info('已删除')
      loadBanned()
    } catch (e: any) {
      toast.error(e.message || '删除失败')
    }
  }

  const canAdd = tab === 'quick' || isAdmin
  const hint = tab === 'agents'
    ? '状态由客服本人在左下角切换。'
    : tab === 'quick'
      ? '团队模板所有客服可见；勾选「仅自己」后只在本人工作台出现。'
      : '出口词过滤 AI/客服回复中的极限词；入口词用于识别用户风险内容。'

  return (
    <div className="max-w-5xl">
      <div className="bg-white dark:bg-gray-900 rounded-card shadow-card overflow-hidden">
        <div className="border-b dark:border-gray-700 px-2 flex items-center gap-1">
          {TABS.map((item) => (
            <button
              key={item.id}
              onClick={() => setTab(item.id)}
              className={clsx(
                'px-4 py-2.5 text-sm border-b-2 -mb-px',
                tab === item.id
                  ? 'border-blue-600 text-blue-600 dark:text-blue-400 font-medium'
                  : 'border-transparent text-gray-500',
              )}
            >
              {item.label}
            </button>
          ))}
          <span className="flex-1" />
          {canAdd && (
            <button
              onClick={openCreate}
              className="text-xs px-3 py-1.5 my-1.5 mr-2 rounded-lg text-white bg-blue-600 hover:bg-blue-700"
            >
              新增
            </button>
          )}
        </div>
        <div className="px-4 py-2 text-xs text-gray-400 border-b dark:border-gray-800">{hint}</div>

        {tab === 'agents' && (
          agents.length === 0 ? (
            <Empty icon={Users} title="暂无客服账号" />
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-400 text-left border-b dark:border-gray-700">
                  <th className="px-4 py-2.5 font-normal">姓名</th>
                  <th className="px-2 py-2.5 font-normal">账号</th>
                  <th className="px-2 py-2.5 font-normal">角色</th>
                  <th className="px-2 py-2.5 font-normal">状态</th>
                  <th className="px-2 py-2.5 font-normal">接待上限</th>
                  {isAdmin && <th className="px-4 py-2.5 font-normal w-28 text-right">操作</th>}
                </tr>
              </thead>
              <tbody>
                {agents.map((a) => (
                  <tr key={a.id} className="border-b border-gray-50 dark:border-gray-800">
                    <td className="px-4 py-2.5 text-gray-800 dark:text-gray-100">{a.display_name}</td>
                    <td className="px-2 py-2.5 text-gray-500">@{a.username}</td>
                    <td className="px-2 py-2.5 text-gray-500">{a.role === 'admin' ? '管理员' : '客服'}</td>
                    <td className={`px-2 py-2.5 ${a.status === 'active' ? 'text-green-600' : 'text-gray-400'}`}>
                      {STATUS_LABEL[a.status] || a.status}
                    </td>
                    <td className="px-2 py-2.5 text-gray-500">{a.max_concurrent ?? 20}</td>
                    {isAdmin && (
                      <td className="px-4 py-2.5 text-right">
                        <button
                          onClick={() => setAgentDraft({
                            id: a.id,
                            username: a.username,
                            displayName: a.display_name,
                            password: '',
                            role: a.role === 'admin' ? 'admin' : 'agent',
                            maxConcurrent: a.max_concurrent ?? 20,
                          })}
                          className="text-blue-500 hover:text-blue-700 mr-3"
                        >
                          编辑
                        </button>
                        {a.id !== me?.id && (
                          <button onClick={() => removeAgent(a)} className="text-red-400 hover:text-red-600">
                            删除
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )
        )}

        {tab === 'quick' && (
          quickReplies.length === 0 ? (
            <Empty icon={MessageSquare} title="暂无快捷回复" hint="点击新增，写一条像真人说话的模板" />
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-400 text-left border-b dark:border-gray-700">
                  <th className="px-4 py-2.5 font-normal w-36">标题</th>
                  <th className="px-2 py-2.5 font-normal">内容</th>
                  <th className="px-2 py-2.5 font-normal w-20">范围</th>
                  <th className="px-4 py-2.5 font-normal w-28 text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {quickReplies.map((q) => (
                  <tr key={q.id} className="border-b border-gray-50 dark:border-gray-800">
                    <td className="px-4 py-2.5 text-gray-800 dark:text-gray-100">{q.title}</td>
                    <td className="px-2 py-2.5 text-gray-500 max-w-md">
                      <div className="truncate" title={q.content}>{q.content}</div>
                    </td>
                    <td className="px-2 py-2.5 text-gray-400">{q.agent_id ? '我的' : '团队'}</td>
                    <td className="px-4 py-2.5 text-right">
                      <button
                        onClick={() => setQuickDraft({
                          id: q.id,
                          title: q.title,
                          content: q.content,
                          personal: !!q.agent_id,
                        })}
                        className="text-blue-500 hover:text-blue-700 mr-3"
                      >
                        编辑
                      </button>
                      <button onClick={() => removeQuick(q)} className="text-red-400 hover:text-red-600">
                        删除
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        )}

        {tab === 'banned' && (
          banned.length === 0 ? (
            <Empty icon={ListChecks} title="暂无自定义违禁词" hint={isAdmin ? '点击新增，写入出口或入口词' : '管理员添加后会显示在这里'} />
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-400 text-left border-b dark:border-gray-700">
                  <th className="px-4 py-2.5 font-normal">词</th>
                  <th className="px-2 py-2.5 font-normal">分类</th>
                  <th className="px-2 py-2.5 font-normal">方向</th>
                  {isAdmin && <th className="px-4 py-2.5 font-normal w-28 text-right">操作</th>}
                </tr>
              </thead>
              <tbody>
                {banned.map((w) => (
                  <tr key={w.id} className="border-b border-gray-50 dark:border-gray-800">
                    <td className="px-4 py-2.5 text-gray-800 dark:text-gray-100">{w.word}</td>
                    <td className="px-2 py-2.5 text-gray-500">{w.category}</td>
                    <td className="px-2 py-2.5 text-gray-400">{w.direction === 'in' ? '入口' : '出口'}</td>
                    {isAdmin && (
                      <td className="px-4 py-2.5 text-right">
                        <button
                          onClick={() => setBannedDraft({
                            id: w.id,
                            word: w.word,
                            category: w.category,
                            direction: w.direction === 'in' ? 'in' : 'out',
                          })}
                          className="text-blue-500 hover:text-blue-700 mr-3"
                        >
                          编辑
                        </button>
                        <button onClick={() => removeBanned(w)} className="text-red-400 hover:text-red-600">
                          删除
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )
        )}
      </div>

      {agentDraft && (
        <FormModal
          title={agentDraft.id == null ? '新增客服' : '编辑客服'}
          submitText={agentDraft.id == null ? '添加' : '保存'}
          onClose={() => setAgentDraft(null)}
          onSubmit={saveAgent}
        >
          {agentDraft.id == null ? (
            <label className="block text-xs text-gray-500 dark:text-gray-400">
              账号
              <input
                value={agentDraft.username}
                onChange={(e) => setAgentDraft({ ...agentDraft, username: e.target.value })}
                className={fieldClass}
                autoFocus
              />
            </label>
          ) : (
            <div className="text-xs text-gray-400">账号 @{agentDraft.username}</div>
          )}
          <label className="block text-xs text-gray-500 dark:text-gray-400">
            姓名
            <input
              value={agentDraft.displayName}
              onChange={(e) => setAgentDraft({ ...agentDraft, displayName: e.target.value })}
              className={fieldClass}
              autoFocus={agentDraft.id != null}
            />
          </label>
          <label className="block text-xs text-gray-500 dark:text-gray-400">
            {agentDraft.id == null ? '密码' : '新密码'}
            <input
              type="password"
              value={agentDraft.password}
              onChange={(e) => setAgentDraft({ ...agentDraft, password: e.target.value })}
              placeholder={agentDraft.id == null ? '' : '留空则不修改'}
              className={fieldClass}
            />
          </label>
          <label className="block text-xs text-gray-500 dark:text-gray-400">
            角色
            <select
              value={agentDraft.role}
              disabled={agentDraft.id === me?.id}
              onChange={(e) => setAgentDraft({ ...agentDraft, role: e.target.value === 'admin' ? 'admin' : 'agent' })}
              className={fieldClass}
            >
              <option value="agent">客服</option>
              <option value="admin">管理员</option>
            </select>
          </label>
          <label className="block text-xs text-gray-500 dark:text-gray-400">
            接待上限
            <input
              type="number"
              min={0}
              value={agentDraft.maxConcurrent}
              onChange={(e) => setAgentDraft({ ...agentDraft, maxConcurrent: Number(e.target.value) })}
              className={fieldClass}
            />
          </label>
        </FormModal>
      )}

      {quickDraft && (
        <FormModal
          title={quickDraft.id == null ? '新增快捷回复' : '编辑快捷回复'}
          submitText={quickDraft.id == null ? '添加' : '保存'}
          onClose={() => setQuickDraft(null)}
          onSubmit={saveQuick}
        >
          <label className="block text-xs text-gray-500 dark:text-gray-400">
            标题
            <input
              value={quickDraft.title}
              onChange={(e) => setQuickDraft({ ...quickDraft, title: e.target.value })}
              className={fieldClass}
              autoFocus
            />
          </label>
          <label className="block text-xs text-gray-500 dark:text-gray-400">
            内容
            <textarea
              value={quickDraft.content}
              onChange={(e) => setQuickDraft({ ...quickDraft, content: e.target.value })}
              rows={4}
              placeholder="口语化，像真人说话"
              className={fieldClass}
            />
          </label>
          <label className="text-xs text-gray-500 dark:text-gray-400 flex items-center gap-2">
            <input
              type="checkbox"
              checked={quickDraft.personal}
              onChange={(e) => setQuickDraft({ ...quickDraft, personal: e.target.checked })}
            />
            仅自己
          </label>
        </FormModal>
      )}

      {bannedDraft && (
        <FormModal
          title={bannedDraft.id == null ? '新增违禁词' : '编辑违禁词'}
          submitText={bannedDraft.id == null ? '添加' : '保存'}
          onClose={() => setBannedDraft(null)}
          onSubmit={saveBanned}
        >
          <label className="block text-xs text-gray-500 dark:text-gray-400">
            违禁词
            <input
              value={bannedDraft.word}
              onChange={(e) => setBannedDraft({ ...bannedDraft, word: e.target.value })}
              className={fieldClass}
              autoFocus
            />
          </label>
          <label className="block text-xs text-gray-500 dark:text-gray-400">
            分类
            <input
              value={bannedDraft.category}
              onChange={(e) => setBannedDraft({ ...bannedDraft, category: e.target.value })}
              placeholder="极限词"
              className={fieldClass}
            />
          </label>
          <label className="block text-xs text-gray-500 dark:text-gray-400">
            方向
            <select
              value={bannedDraft.direction}
              onChange={(e) => setBannedDraft({ ...bannedDraft, direction: e.target.value === 'in' ? 'in' : 'out' })}
              className={fieldClass}
            >
              <option value="out">出口（过滤回复）</option>
              <option value="in">入口（识别用户风险）</option>
            </select>
          </label>
        </FormModal>
      )}
    </div>
  )
}
