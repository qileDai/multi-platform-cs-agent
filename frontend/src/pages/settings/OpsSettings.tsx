import { useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { api, AuditLogItem, QueueOpsOverview } from '../../api/client'
import { toast } from '../../components/ui/toast'
import { useAuth } from '../../store'

const TASK_TYPE_LABELS: Record<string, string> = {
  inbound_message: '私信入站',
  inbound_comment: '评论入站',
  content_generate: '内容生成',
  first_comment: '首评引流',
}

const ACTION_LABELS: Record<string, string> = {
  takeover: '接管会话',
  release: '释放会话',
  close: '关闭会话',
  kb_faq_create: '新增 FAQ',
  kb_faq_update: '修改 FAQ',
  kb_doc_delete: '删除文档',
  kb_doc_upload: '上传文档',
  ai_switch: 'AI 总开关',
  auto_switches: '自动化开关',
  brand_style_update: '品牌语气更新',
  rpa_outbox_retry: '重发失败消息',
  rpa_outbox_discard: '忽略失败消息',
}

export default function OpsSettings() {
  const { agent: me } = useAuth()
  const [auditLogs, setAuditLogs] = useState<AuditLogItem[]>([])
  const [queueOps, setQueueOps] = useState<QueueOpsOverview | null>(null)

  const load = async () => {
    try {
      setAuditLogs((await api.listAuditLogs()).items)
    } catch { /* 忽略 */ }
    try {
      setQueueOps(await api.queueFailed())
    } catch { /* 忽略 */ }
  }

  useEffect(() => {
    if (me?.role !== 'admin') return
    load()
  }, [me?.role])

  if (me?.role !== 'admin') {
    return <Navigate to="/settings/service" replace />
  }

  const downloadJson = (filename: string, data: unknown, message: string) => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = filename
    a.click()
    URL.revokeObjectURL(a.href)
    toast.success(message)
  }

  return (
    <div className="max-w-5xl space-y-4">
      <div className="bg-white dark:bg-gray-900 rounded-card shadow-card p-5">
        <div className="flex items-center justify-between mb-1">
          <div className="text-sm font-medium text-gray-700 dark:text-gray-200">队列运维（后台任务）</div>
          {queueOps && (
            <div className="text-xs text-gray-400">
              待处理 {queueOps.pending} ·
              <span className={queueOps.failed > 0 ? 'text-red-500 font-medium' : ''}> 失败 {queueOps.failed}</span>
            </div>
          )}
        </div>
        <div className="text-xs text-gray-400 mb-3">
          私信/评论入站走 fast 通道，内容生成/发布走 slow 通道，互不阻塞；失败任务自动退避重试 3 次（30s/60s/120s）后停在这里。
        </div>
        {!queueOps || queueOps.items.length === 0 ? (
          <div className="text-xs text-gray-300 dark:text-gray-600 text-center py-4">暂无失败任务</div>
        ) : (
          <div className="space-y-1.5 max-h-56 overflow-y-auto">
            {queueOps.items.map((t) => (
              <div key={t.id} className="flex items-center justify-between text-xs border dark:border-gray-700 rounded px-2.5 py-1.5">
                <div className="min-w-0 flex-1">
                  <span className="text-blue-600 dark:text-blue-400 font-medium">
                    {TASK_TYPE_LABELS[t.task_type] || t.task_type}
                  </span>
                  <span className="text-gray-400 ml-2">#{t.id} · 重试 {t.retries} 次</span>
                  <div className="text-gray-400 truncate">{t.error}</div>
                  <div className="text-gray-300 dark:text-gray-600">
                    {t.updated_at ? new Date(t.updated_at).toLocaleString() : ''}
                  </div>
                </div>
                <button
                  onClick={async () => {
                    try {
                      await api.retryQueueTask(t.id)
                      toast.success('已重新入队')
                      load()
                    } catch (e: any) {
                      toast.error(e.message || '重试失败')
                    }
                  }}
                  className="ml-3 shrink-0 text-blue-500 hover:text-blue-700"
                >
                  重试
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="bg-white dark:bg-gray-900 rounded-card shadow-card p-5">
        <div className="flex items-center justify-between mb-3 gap-3">
          <div className="text-sm font-medium text-gray-700 dark:text-gray-200">操作审计日志</div>
          <div className="flex items-center gap-3">
            <button
              onClick={async () => {
                const cases = await api.exportBadCases()
                downloadJson('badcase-cases.json', cases, `已导出 ${cases.length} 条 badcase`)
              }}
              className="text-xs text-blue-500 hover:underline"
            >
              导出 badcase（evals 格式，人工审阅后合入 backend/evals/cases.json）
            </button>
            <button
              onClick={async () => {
                const cases = await api.draftEvalCases()
                downloadJson('eval-drafts.json', cases, `已生成 ${cases.length} 条评测草稿`)
              }}
              className="text-xs text-blue-500 hover:underline"
            >
              生成评测草稿
            </button>
          </div>
        </div>
        {auditLogs.length === 0 ? (
          <div className="text-xs text-gray-300 text-center py-6">暂无操作记录</div>
        ) : (
          <div className="space-y-1 max-h-64 overflow-y-auto">
            {auditLogs.map((l) => (
              <div key={l.id} className="flex items-center gap-3 text-xs border-b border-gray-50 dark:border-gray-800 py-1.5">
                <span className="text-gray-400 dark:text-gray-500 shrink-0">{new Date(l.created_at).toLocaleString()}</span>
                <span className="text-gray-700 dark:text-gray-200 font-medium shrink-0">{l.agent_name}</span>
                <span className="text-blue-600 dark:text-blue-400 shrink-0">{ACTION_LABELS[l.action] || l.action}</span>
                <span className="text-gray-400 dark:text-gray-500 truncate">{l.target} {l.detail}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
